"""RefMod consumers: put a bundle into H3 conditioning.

Two ways in, mirroring ComfyUI-MiniMaxH3Mod's pair (MIT, Luisa /
luisacaotica) so a graph works without that pack installed:

* Text Encode — presents each reference to H3's native text/vision encoder
  during tokenization, so the prompt can cite <Picture n> / <Video n> /
  <Audio n>. This is the path the model was trained on.
* Apply — appends the reference blocks to conditioning that was encoded
  elsewhere. No labels; the model sees the references but the prompt
  cannot name them.

Both accept any bundle that follows the shared (mod, strength) contract,
so ComfyUI-MiniMaxH3Mod's loaders feed these nodes and our stack feeds its.
"""

import inspect
import math
import time

import comfy.model_management as mm

from .refmod_core import check_bundle
from .refmods import KIND_LABEL

MEDIA_LABEL = {"pictures": "picture", "videos": "video", "video_audios": "video_audio", "audios": "audio"}

CATEGORY = "conditioning/video_models"


def _budget(rows, limit):
    total = sum(m.token_count for m, s in rows if s > 0)
    if limit and total > limit:
        raise ValueError(
            f"RefMods require {total} tokens after copies; the limit is {limit}. "
            "Lower a weight, drop a pick, or raise the limit.")
    return total


def media_refs(references, vae, audio_vae, ref_image_size, width, height, length, counters):
    """Loader media as the encoder's items and the DiT's reference blocks,
    prepared exactly as core's MiniMax H3 Reference to Video prepares its own
    inputs (its helpers do the sizing and the audio encode). The bundle is a
    Media Loader's / Prompt Builder's: pictures, videos, index-paired
    video_audios, standalone audios. Labels continue `counters`, one per
    kind, in that node's order: a video's soundtrack is labelled before it."""
    try:
        from comfy_extras.nodes_minimax_h3 import (_resize, _encode_ref_audio, adapt_canvas,
                                                   temporal_shape, CANVAS_MULTIPLE, FPS,
                                                   REF_IMAGE_SHORT_EDGE)
    except Exception as exc:
        raise RuntimeError("This ComfyUI has no native MiniMax H3 support; update it.") from exc
    if not isinstance(references, dict):
        raise ValueError("'references' is not a Media Loader bundle.")
    frame_count, _t, _a = temporal_shape(length)
    items, blocks, mapping = [], [], []
    tokens_of = lambda b: int(b.get("latent_t", 1)) * ((b["latent_h"] + 1) // 2) * ((b["latent_w"] + 1) // 2)
    seq = lambda key: [v for v in (references.get(key) or []) if v is not None] if key != "video_audios" else list(references.get(key) or [])

    for n, img in enumerate(seq("pictures"), 1):
        h, w = img.shape[1], img.shape[2]
        if ref_image_size == "match":
            scale = min(1.0, math.sqrt((width * height) / (w * h)))
        else:
            scale = min(1.0, REF_IMAGE_SHORT_EDGE / min(w, h))
        tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        resized = _resize(img[:1], tw, th, "disabled")
        counters["image"] += 1
        mapping.append(f"<Picture {counters['image']}> = picture {n} (media)")
        items.append({"type": "image", "data": resized})
        if vae is not None:
            t0 = time.perf_counter()
            z = vae.encode(resized)
            blocks.append({"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": z})
            print(f"[MiniMaxH3FantasticRefModTextEncode] media picture {n}: {tw}x{th} -> "
                  f"{tokens_of(blocks[-1])} reference tokens ({time.perf_counter() - t0:.1f}s)")

    tracks = seq("video_audios")
    videos = references.get("videos") or []
    for n, frames in enumerate(videos, 1):
        if frames is None:
            continue
        soundtrack = tracks[n - 1] if n - 1 < len(tracks) else None
        vh, vw = frames.shape[1], frames.shape[2]
        cw, ch = adapt_canvas(vw, vh)
        if vw * vh < cw * ch:
            cw = max(CANVAS_MULTIPLE, round(vw / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
            ch = max(CANVAS_MULTIPLE, round(vh / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        frames = _resize(frames, cw, ch, "disabled")
        if frames.shape[0] > frame_count:
            frames = frames[:frame_count]
        k = frames.shape[0]
        if k < 5:
            raise ValueError(f"Reference video {n} needs at least 5 frames (~0.2 s at 24 fps).")
        while k % 17 != 5:
            k -= 1
        frames = frames[:k]
        if soundtrack is not None:
            counters["audio"] += 1
            mapping.append(f"<Audio {counters['audio']}> = soundtrack of video {n} (media)")
            items.append({"type": "audio"})
        counters["video"] += 1
        mapping.append(f"<Video {counters['video']}> = video {n} (media)")
        sample_idx = list(range(0, frames.shape[0], FPS // 2))
        items.append({"type": "video", "data": frames[sample_idx],
                      "timestamps": [i / 2.0 for i in range(len(sample_idx))]})
        if vae is None:
            continue
        t0 = time.perf_counter()
        z = vae.encode(frames)
        audio_latent, ref_audio_t = None, 0
        if soundtrack is not None and audio_vae is not None:
            audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, soundtrack)
        blocks.append({"kind": "video_audio" if ref_audio_t else "video",
                       "latent_t": z.shape[2], "latent_h": ch // 16, "latent_w": cw // 16,
                       "ref_audio_t": ref_audio_t, "latent": z, "audio_latent": audio_latent})
        # A long clip is the single most expensive reference there is: every
        # one of its tokens rides through every sampling step. Say so.
        print(f"[MiniMaxH3FantasticRefModTextEncode] media video {n}: {k} frames at {cw}x{ch} -> "
              f"{tokens_of(blocks[-1])} reference tokens"
              + (f" + {2 * ref_audio_t} audio" if ref_audio_t else "")
              + f" ({time.perf_counter() - t0:.1f}s to encode)"
              + ("; trim the clip in the Media Loader if only a moment of it is the reference"
                 if tokens_of(blocks[-1]) > 12000 else ""))

    for n, audio in enumerate(seq("audios"), 1):
        counters["audio"] += 1
        mapping.append(f"<Audio {counters['audio']}> = audio {n} (media)")
        items.append({"type": "audio"})
        if audio_vae is not None:
            audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, audio)
            blocks.append({"kind": "audio", "ref_audio_t": ref_audio_t, "audio_latent": audio_latent})
    return items, blocks, mapping


class MiniMaxH3FantasticRefModTextEncode:
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "Encode the prompt with references presented to H3's native encoder, "
        "so <Picture n>, <Video n> and <Audio n> in the prompt name them: "
        "Media Loader media from 'references' first, then the RefMod bundle, "
        "each kind counted in one sequence. Stands in for MiniMax H3 Reference "
        "to Video: its conditioning already carries the references (do not "
        "Apply the same bundle again) and 'latent' is the empty AV latent for "
        "the sampler. Needs the H3 video VAE for pictures and the audio VAE "
        "for voices."
    )
    RETURN_TYPES = ("CONDITIONING", "STRING", "LATENT")
    RETURN_NAMES = ("conditioning", "reference_map", "latent")
    FUNCTION = "encode"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clip": ("CLIP",),
            "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
            "width": ("INT", {"default": 1344, "min": 32, "max": 16384, "step": 32,
                "tooltip": "Generation width: sizes the empty latent and, with 'match', the media references."}),
            "height": ("INT", {"default": 768, "min": 32, "max": 16384, "step": 32}),
            "length": ("INT", {"default": 124, "min": 5, "max": 3600, "step": 17,
                "tooltip": "Frame count at 24 fps (124 = ~5 s). Media reference videos are cut to it."}),
            "ref_image_size": (["match", "max"], {"default": "match",
                "tooltip": "Media pictures: 'match' scales each (down only) to the generation's "
                           "pixel area; 'max' keeps up to a 2048 px short edge for identity, at a "
                           "cost in speed. RefMods keep the size they were saved at."}),
            "reference_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0,
                "tooltip": "Playback rate assumed for a reconstructed RefMod video. "
                           "Compressed or stacked references do not keep their original timing."}),
            "max_total_tokens": ("INT", {"default": 0, "min": 0, "max": 2147483647,
                "tooltip": "Refuse RefMod bundles over this many reference tokens. 0 = no limit."}),
        }, "optional": {
            "mods": ("H3_REF_MODS", {"tooltip": "RefMod bundle from a RefMod Stack or the Prompt Builder's mods output."}),
            "references": ("H3_REFS", {"tooltip": "Media Loader bundle — from the loader, or the Prompt "
                                                  "Builder's references output. Labelled before the RefMods."}),
            "vae": ("VAE", {"tooltip": "H3 video VAE: encodes media pictures and clips, and reconstructs "
                                       "visual RefMods for the encoder. Not needed for audio-only references."}),
            "audio_vae": ("VAE", {"tooltip": "H3 audio VAE: encodes media voices and soundtracks. "
                                             "RefMod voices are already encoded."}),
        }}

    def encode(self, clip, prompt, width=1344, height=768, length=124, ref_image_size="match",
               reference_fps=24.0, max_total_tokens=0, mods=None, references=None, vae=None, audio_vae=None):
        try:
            from comfy.text_encoders.minimax import MiniMaxH3Tokenizer
            from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE
            from comfy_extras.nodes_minimax_h3 import _empty_av_latent
        except Exception as exc:
            raise RuntimeError("This ComfyUI has no native MiniMax H3 support; update it.") from exc

        native = isinstance(clip.tokenizer, MiniMaxH3Tokenizer)
        if not native and "minimax_ref_items" not in inspect.signature(clip.tokenize).parameters:
            raise ValueError("Connect an H3 CLIP (or a projected CLIP that accepts minimax_ref_items).")
        if not math.isfinite(reference_fps) or not 1 <= reference_fps <= 120:
            raise ValueError("reference_fps must be between 1 and 120.")

        active = [(m, s) for m, s in check_bundle(mods, "RefMod Text Encode") if s > 0]
        _budget(active, max_total_tokens)
        visual = any(getattr(m, "kind", None) != "audio" for m, _s in active)
        media_visual = isinstance(references, dict) and any(
            v is not None for v in (references.get("pictures") or []) + (references.get("videos") or []))
        if (visual or media_visual) and vae is None:
            raise ValueError("Connect the H3 video VAE to present pictures and clips to the encoder.")
        if (visual or media_visual) and not isinstance(vae.first_stage_model, MiniMaxH3VideoVAE):
            raise ValueError("Visual references need the MiniMax H3 video VAE.")

        counters = {"image": 0, "video": 0, "audio": 0}
        items, blocks, mapping = [], [], []
        t_start = time.perf_counter()
        if references is not None:
            items, blocks, mapping = media_refs(references, vae, audio_vae, ref_image_size,
                                                width, height, length, counters)
            if items and audio_vae is None and any(i["type"] == "audio" for i in items):
                print("[MiniMaxH3FantasticRefModTextEncode] media audio has no audio VAE: "
                      "it conditions the text encoder only")
        # A copy is the same latent again: decode each one once and reuse the
        # pixels for every label it gets.
        decoded = {}
        for mod, strength in active:
            block = mod.ref_block(strength)
            if block is None:
                continue
            block["refmod"] = True          # lets a step-curve wrapper find it
            kind = block["kind"]
            if kind not in counters:
                raise ValueError(f"Reference '{mod.name}' has kind '{kind}', which this "
                                 "node cannot label (expected image, video or audio).")
            counters[kind] += 1
            mapping.append(f"<{KIND_LABEL[kind]} {counters[kind]}> = {mod.name}")
            item = {"type": kind}
            if kind != "audio":
                key = (id(mod), round(float(strength), 4))
                if key not in decoded:
                    # Show the encoder the same weakened latent the DiT receives.
                    t0 = time.perf_counter()
                    pixels = vae.decode(block["latent"])
                    if pixels.ndim == 5 and pixels.shape[0] == 1:
                        pixels = pixels[0]
                    if pixels.ndim != 4 or pixels.shape[-1] != 3 or pixels.shape[0] < 1:
                        raise ValueError(f"Unexpected VAE decode shape {tuple(pixels.shape)}.")
                    decoded[key] = pixels.cpu()
                    del pixels
                    print(f"[MiniMaxH3FantasticRefModTextEncode] decoded {mod.name} for the encoder: "
                          f"{tuple(decoded[key].shape[:3])} ({time.perf_counter() - t0:.1f}s)")
                pixels = decoded[key]
                if kind == "image":
                    item["data"] = pixels[:1].clone()
                else:
                    # Native H3 presents video at 2 fps, indexed by timestamp.
                    times = [i / 2 for i in range(math.ceil(pixels.shape[0] * 2 / reference_fps))]
                    idx = [min(round(t * reference_fps), pixels.shape[0] - 1) for t in times]
                    item["data"] = pixels[idx].clone()
                    item["timestamps"] = times
            items.append(item)
            blocks.append(block)
        del decoded
        if blocks:
            # Let the VAE's working memory go before the text encoder loads.
            mm.soft_empty_cache()
            media_tokens = sum(int(b.get("latent_t", 1)) * ((b["latent_h"] + 1) // 2) * ((b["latent_w"] + 1) // 2)
                               for b in blocks if not b.get("refmod") and "latent_h" in b)
            refmod_tokens = sum(m.token_count for m, _s in active)
            print(f"[MiniMaxH3FantasticRefModTextEncode] references ready in {time.perf_counter() - t_start:.1f}s: "
                  f"media {media_tokens} tokens + RefMods {refmod_tokens} tokens = {media_tokens + refmod_tokens}"
                  " riding through every sampling step")

        tokens = clip.tokenize(prompt, minimax_ref_items=items)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        out = []
        for embedding, metadata in conditioning:
            if "minimax_token_tags" not in metadata:
                raise ValueError("The encoder returned no H3 token tags; use an H3 CLIP.")
            metadata = dict(metadata)
            if blocks:
                metadata["minimax_refs"] = list(metadata.get("minimax_refs", [])) + blocks
            out.append([embedding, metadata])
        latent, _frames = _empty_av_latent(width, height, length)
        return out, "\n".join(mapping) or "No references.", latent


class MiniMaxH3FantasticRefModApply:
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "Append the bundle's references to existing H3 conditioning. The prompt "
        "cannot name them this way; use Text Encode for <Picture n> labels. "
        "'retention' multiplies every entry's strength."
    )
    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("conditioning",)
    FUNCTION = "apply"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "conditioning": ("CONDITIONING",),
            "mods": ("H3_REF_MODS",),
            "retention": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                "tooltip": "Master multiplier on every entry's strength. 1 = as picked."}),
            "max_total_tokens": ("INT", {"default": 0, "min": 0, "max": 2147483647,
                "tooltip": "Refuse bundles over this many reference tokens. 0 = no limit."}),
        }}

    def apply(self, conditioning, mods, retention=1.0, max_total_tokens=0):
        rows = check_bundle(mods, "RefMod Apply")
        factor = max(0.0, min(1.0, float(retention)))
        active = [(m, min(1.0, s * factor)) for m, s in rows if s * factor > 0]
        _budget(active, max_total_tokens)
        blocks = []
        for mod, strength in active:
            block = mod.ref_block(strength)
            if block is not None:
                block["refmod"] = True
                blocks.append(block)
        out = []
        for entry in conditioning:
            meta = dict(entry[1])
            meta["minimax_refs"] = list(meta.get("minimax_refs", [])) + blocks
            out.append([entry[0], meta])
        if blocks:
            print(f"[MiniMaxH3FantasticRefModApply] attached {len(blocks)} reference "
                  f"block{'s' if len(blocks) != 1 else ''} "
                  f"({sum(m.token_count for m, _s in active)} tokens)")
        return (out,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3FantasticRefModTextEncode": MiniMaxH3FantasticRefModTextEncode,
    "MiniMaxH3FantasticRefModApply": MiniMaxH3FantasticRefModApply,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3FantasticRefModTextEncode": "Fantastic H3 RefMod Text Encode",
    "MiniMaxH3FantasticRefModApply": "Fantastic H3 RefMod Apply",
}
