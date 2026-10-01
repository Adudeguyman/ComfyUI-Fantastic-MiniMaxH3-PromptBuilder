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

import hashlib
import inspect
import math
import time

import torch

import comfy.model_management as mm

from .refmod_core import (check_bundle, _blur_latent, decode_for_encoder, pack_frames, unpack_frames,
                          stored_record, soften)
from .refmods import KIND_LABEL
from . import latent_cache
from .video_edit import bundle_edit, hide_area, shape, spec_mask, usable_frames

REF_TOKEN_WARN = 30000      # a cited clip being edited past this many tokens gets a warning

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
    specs = references.get("video_specs") or []
    edit = references.get("edit")
    for n, frames in enumerate(videos, 1):
        if frames is None:
            continue
        soundtrack = tracks[n - 1] if n - 1 < len(tracks) else None
        spec = specs[n - 1] if n - 1 < len(specs) else None
        source_shape = list(frames.shape)
        vh, vw = frames.shape[1], frames.shape[2]
        # With crop to mask the edit samples only a box around the mask, so
        # the cited clip is that same box.
        box, obj = None, None
        hide = edit.get("hide", "off") if spec and spec.get("edit") and edit else "off"
        if spec and spec.get("edit") and edit and (edit.get("context") or hide != "off"):
            used = usable_frames(frames.shape[0])
            obj, box = shape(spec_mask(edit, used), used, vw, vh, int(edit.get("grow", 16)),
                             bool(edit.get("invert")), float(edit.get("context") or 0))
            if box:
                x, y, vw, vh = box
                frames = frames[:, y:y + vh, x:x + vw]
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
        if hide != "off":
            # what's being replaced, hidden from the encoder and the DiT alike
            frames = hide_area(frames, obj, box, source_shape[2], source_shape[1], bool(edit.get("invert")), hide,
                               float(edit.get("blur") or 24.0))
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
        # A loader clip's encode is saved under its settings: the prompt
        # changes far more often than the clip does.
        with_audio = soundtrack is not None and audio_vae is not None
        path = None
        if spec and spec.get("file"):
            try:
                path = latent_cache.path_for("ref", {
                    "v": 1, "clip": latent_cache.file_stamp(spec["file"]), "trim": spec.get("trim"),
                    "crop": spec.get("crop"), "mirror": bool(spec.get("mirror")), "resize": spec.get("resize"),
                    "audio_mode": spec.get("audio_mode"), "shape": source_shape, "box": box, "size": [cw, ch, k],
                    "audio": with_audio, "vae": latent_cache.vae_tag(vae),
                    "audio_vae": latent_cache.vae_tag(audio_vae) if with_audio else None,
                    **({"hide": [hide, latent_cache.file_stamp(edit["mask"]), int(edit.get("grow", 16)),
                                 bool(edit.get("invert")), float(edit.get("blur") or 24.0) if hide != "invert" else 0]}
                       if hide != "off" else {})})
            except (OSError, ValueError):
                path = None
        saved = latent_cache.load(path) if path else None
        if saved is not None:
            z = saved["video"].to(mm.intermediate_device())
            audio_latent = saved.get("audio")
            ref_audio_t = audio_latent.shape[-1] if audio_latent is not None else 0
        else:
            z = vae.encode(frames)
            audio_latent, ref_audio_t = None, 0
            if with_audio:
                audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, soundtrack)
            if path:
                latent_cache.save(path, {"video": z, "audio": audio_latent})
        # The clip being edited sits at the target's own positions, and at
        # full strength the model can copy it back instead of editing. Mixed
        # toward a blur it still gives colour and placement, not the detail.
        soft = float(edit.get("ref_strength") or 1.0) if spec and spec.get("edit") and edit else 1.0
        if soft < 1.0:
            z = soft * z + (1.0 - soft) * _blur_latent(z)
        blocks.append({"kind": "video_audio" if ref_audio_t else "video",
                       "latent_t": z.shape[2], "latent_h": ch // 16, "latent_w": cw // 16,
                       "ref_audio_t": ref_audio_t, "latent": z, "audio_latent": audio_latent})
        # A long clip is the single most expensive reference there is: every
        # one of its tokens rides through every sampling step. Say so.
        print(f"[MiniMaxH3FantasticRefModTextEncode] media video {n}: {k} frames at {cw}x{ch} -> "
              f"{tokens_of(blocks[-1])} reference tokens"
              + (f" + {2 * ref_audio_t} audio" if ref_audio_t else "")
              + (" (the crop to mask box)" if box else "")
              + (f"; masked area blurred ({float(edit.get('blur') or 24.0):g} px)" if hide in ("blur", "blur_invert")
                 else "")
              + (" and inverted" if hide == "blur_invert" else "; masked area inverted" if hide == "invert" else "")
              + (f"; reference strength {soft:.2f}" if soft < 1.0 else "")
              + (f" (loaded the saved encode, {time.perf_counter() - t0:.1f}s)" if saved is not None
                 else f" ({time.perf_counter() - t0:.1f}s to encode)")
              + ("; trim the clip in the Media Loader if only a moment of it is the reference"
                 if tokens_of(blocks[-1]) > 12000 else ""))
        if spec and spec.get("edit") and tokens_of(blocks[-1]) > REF_TOKEN_WARN:
            print(f"[MiniMaxH3FantasticRefModTextEncode] citing the clip being edited adds "
                  f"{tokens_of(blocks[-1])} reference tokens to every sampling step. Trim it, or turn on "
                  "crop to mask in its mask settings to cite only the area around the mask.")

    for n, audio in enumerate(seq("audios"), 1):
        counters["audio"] += 1
        mapping.append(f"<Audio {counters['audio']}> = audio {n} (media)")
        items.append({"type": "audio"})
        if audio_vae is not None:
            audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, audio)
            blocks.append({"kind": "audio", "ref_audio_t": ref_audio_t, "audio_latent": audio_latent})
    return items, blocks, mapping


def encoder_view(mod, vae, fps):
    """A visual RefMod's frames for H3's text encoder, at full strength, with
    their timestamps and where they came from: stored in the RefMod when it
    has them, else decoded once and kept in the cache, so no RefMod is
    decoded on every run."""
    rate = None if mod.source == "stack" else fps     # a stack's pictures don't depend on the rate
    if mod.enc_times and (rate is None or abs(mod.enc_fps - rate) < 1e-6):
        packed, times, _fps = stored_record(mod)
        return unpack_frames(packed), times, "stored in the RefMod"
    key = {"v": 1, "latent": hashlib.sha1(mod.latent.detach().cpu().contiguous().view(torch.uint8).numpy()).hexdigest(),
           "shape": list(mod.latent.shape), "kind": mod.kind, "fps": rate, "vae": latent_cache.vae_tag(vae)}
    path = latent_cache.path_for("encframes", key)
    saved = latent_cache.load(path)
    how = "cached"
    if saved is None:
        frames, times = decode_for_encoder(mod, vae, fps)
        saved = {**pack_frames(frames), "times": torch.tensor(times, dtype=torch.float64)}
        latent_cache.save(path, saved)
        how = "decoded once, now cached"
    # every run is shown the same frames: the kept copy, not this run's decode
    return unpack_frames(saved), saved["times"].tolist(), how


STACK_PICTURES = ("every 4th", "up to N", "all")


def stack_picks(n, mode, count):
    """Which of a stack's n pictures the encoder is shown, by stack_pictures;
    `count` is the N of "up to N", spread from the first picture to the last."""
    if mode == "every 4th":
        return list(range(0, n, 4))
    if mode == "up to N" and n > count:
        return [round(i * (n - 1) / (count - 1)) for i in range(count)] if count > 1 else [0]
    return list(range(n))


def build_entries(tokenizer, prompt, items):
    """H3's token stream, built exactly as core's MiniMaxH3Tokenizer builds it
    (comfy/text_encoders/minimax.py), plus one thing: an audio item may carry
    a `caption`, written right after its "<Audio j>: " label. Used for
    voice_description_at_label; with no captions the stream is core's to the token."""
    from comfy.text_encoders.minimax import MiniMaxH3Tokenizer, VISION_START, VISION_END
    import torch
    if not isinstance(tokenizer, MiniMaxH3Tokenizer):
        raise ValueError("Connect an H3 CLIP.")
    sub = tokenizer.qwen3vl_32b
    entries = []

    def add_text(text):
        if not text:
            return
        batches = sub.tokenize_with_weights(text, return_word_ids=False, disable_weights=True)
        if len(batches) != 1:
            raise ValueError("MiniMax H3 text segment exceeds the supported prompt length.")
        entries.extend(batches[0])

    def add_vision(data, video_block=False):
        entries.append((VISION_START, 1.0))
        entries.append((tokenizer._vision_entry(data, video_block), 1.0))
        entries.append((VISION_END, 1.0))

    counters = {"image": 0, "audio": 0, "video": 0}
    for item in items:
        kind = item["type"]
        if kind == "image":
            counters["image"] += 1
            add_text("<Picture %d>: " % counters["image"])
            add_vision(item["data"])
        elif kind == "audio":
            counters["audio"] += 1
            add_text("<Audio %d>: " % counters["audio"])
            cap = " ".join(str(item.get("caption") or "").split())
            if cap:
                add_text(f"{cap} ")
        elif kind == "video":
            frames = item["data"]
            timestamps = item.get("timestamps")
            if timestamps is None:
                timestamps = [i / 2.0 for i in range(frames.shape[0])]
            if frames.shape[0] % 2 == 1:
                frames = torch.cat([frames, frames[-1:]], dim=0)
                timestamps = list(timestamps) + [timestamps[-1]]
            counters["video"] += 1
            add_text("<Video %d>: " % counters["video"])
            for i in range(0, frames.shape[0], 2):
                add_text("<%.1f seconds>" % ((timestamps[i] + timestamps[i + 1]) / 2.0))
                add_vision(frames[i:i + 2], video_block=True)
        else:
            raise ValueError(f"Unknown reference kind {kind!r}.")
    add_text(prompt)
    if not entries:
        entries.append((151643, 1.0))
    return {"qwen3vl_32b": [entries]}


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
                "tooltip": "Playback rate assumed for a RefMod clip, to pick the frames H3's encoder "
                           "is shown (two a second). Stacks use stack_pictures instead."}),
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
            "voice_description_at_label": ("BOOLEAN", {"default": False,
                "tooltip": "Your voice references are used either way; this only decides where their descriptions "
                           "go. On: each voice RefMod's saved Voice description is also written right after its "
                           "<Audio N>: label, where H3's encoder is introduced to the reference. Off: the bare "
                           "label, exactly as core writes it."}),
            "stack_pictures": (list(STACK_PICTURES), {"default": "every 4th",
                "tooltip": "EXPERIMENTAL: How many pictures of a RefMod the text encoder sees (only RefMods made "
                           "from several pictures; clips and single pictures aren't affected). More pictures may "
                           "help lock in identity and reduce bleeding when using several RefMods, but increase "
                           "memory use and generation time.\n\n"
                           "• every 4th (default): the first picture and every 4th after it. Fewest tokens; good "
                           "for a single RefMod.\n"
                           "• up to N: N pictures spread across the stack (set N in stack_pictures_n). Costs more, "
                           "possibly better identity retention.\n"
                           "• all: every picture. The most expensive, and can greatly increase generation time, "
                           "but early tests suggest it helps with bleed between similar-looking characters."}),
            "stack_pictures_n": ("INT", {"default": 8, "min": 1, "max": 1024,
                "tooltip": "How many pictures 'up to N' shows the text encoder, spread evenly across the stack. "
                           "Only used when stack_pictures is 'up to N'."}),
        }, "hidden": {"extra_pnginfo": "EXTRA_PNGINFO"}}

    def encode(self, clip, prompt, width=1344, height=768, length=124, ref_image_size="match",
               reference_fps=24.0, max_total_tokens=0, mods=None, references=None, vae=None, audio_vae=None,
               voice_description_at_label=False, stack_pictures="every 4th", stack_pictures_n=8, extra_pnginfo=None):
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

        # A clip marked for editing in the Media Loader sets the size and
        # length, and its latent (with the mask) replaces the empty one.
        edit = bundle_edit(references, vae, audio_vae, width, height)
        if edit is not None:
            budget = width * height
            width, height, length = edit[1], edit[2], edit[3]
            print(f"[MiniMaxH3FantasticRefModTextEncode] editing {references['edit']['name']}: sampling "
                  f"{width}x{height} (at most {budget / 1e6:.2f} MP, from width x height), {length} frames "
                  "(the clip's length and shape)")
            nodes = ((extra_pnginfo or {}).get("workflow") or {}).get("nodes") or []
            if references["edit"].get("context") and any(n.get("type") == "MiniMaxH3AddGuide" for n in nodes):
                print("[MiniMaxH3FantasticRefModTextEncode] crop to mask is on and this workflow has Add Guide: a "
                      "guide frame is placed on the generated view, which is now the crop, not the whole frame. "
                      "Crop the guide image to match, or turn crop to mask off.")
            if nodes and not any(n.get("type") == "MiniMaxH3FantasticEditComposite" for n in nodes):
                print("[MiniMaxH3FantasticRefModTextEncode] no Fantastic H3 Edit Composite in this workflow: "
                      "outside the mask you'll get the VAE's copy of the footage, not the original pixels. "
                      "Add it between VAE Decode and Create Video.")

        counters = {"image": 0, "video": 0, "audio": 0}
        items, blocks, mapping = [], [], []
        t_start = time.perf_counter()
        if references is not None:
            items, blocks, mapping = media_refs(references, vae, audio_vae, ref_image_size,
                                                width, height, length, counters)
            if items and audio_vae is None and any(i["type"] == "audio" for i in items):
                print("[MiniMaxH3FantasticRefModTextEncode] media audio has no audio VAE: "
                      "it conditions the text encoder only")
        # A copy is the same RefMod again: fetch its frames once and reuse
        # them for every label it gets.
        shown = {}
        voiced = 0
        if voice_description_at_label and not native:
            print("[MiniMaxH3FantasticRefModTextEncode] voice_description_at_label needs the native H3 CLIP; ignored")
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
            item = {"type": kind}
            voice = " ".join(str(getattr(mod, "voice_description", "") or "").split()) \
                if kind == "audio" and voice_description_at_label and native else ""
            if voice:
                item["caption"] = voice
                voiced += 1
            mapping.append(f"<{KIND_LABEL[kind]} {counters[kind]}> = {mod.name}" + (" \u00b7 voice description at label" if voice else ""))
            if kind != "audio":
                first = id(mod) not in shown
                if first:
                    t0 = time.perf_counter()
                    shown[id(mod)] = encoder_view(mod, vae, reference_fps)
                frames, times, how = shown[id(mod)]
                # weakened as the latent the DiT receives is
                frames = soften(frames, strength, mod.latent_h, mod.latent_w)
                if kind == "image":
                    item["data"] = frames[:1].clone()
                    what = "1 picture"
                elif mod.source == "stack":
                    idx = stack_picks(frames.shape[0], stack_pictures, stack_pictures_n)
                    if stack_pictures == "every 4th":
                        # two to a block, as a clip sampled at two frames a second
                        item["data"], item["timestamps"] = frames[idx], [i / 2 for i in range(len(idx))]
                    else:
                        # a block each: every picture held for its second, sampled twice
                        item["data"] = frames[idx].repeat_interleave(2, dim=0)
                        item["timestamps"] = [k + d for k in range(len(idx)) for d in (0.0, 0.5)]
                    what = f"{len(idx)} of {frames.shape[0]} pictures"
                else:
                    item["data"] = frames.clone()
                    item["timestamps"] = times
                    what = f"{frames.shape[0]} frame{'s' if frames.shape[0] != 1 else ''}"
                if first:
                    print(f"[MiniMaxH3FantasticRefModTextEncode] {mod.name} for the encoder: {what}, {how} "
                          f"({time.perf_counter() - t0:.1f}s)")
            items.append(item)
            blocks.append(block)
        del shown
        if blocks:
            # Let the VAE's working memory go before the text encoder loads.
            mm.soft_empty_cache()
            media_tokens = sum(int(b.get("latent_t", 1)) * ((b["latent_h"] + 1) // 2) * ((b["latent_w"] + 1) // 2)
                               for b in blocks if not b.get("refmod") and "latent_h" in b)
            refmod_tokens = sum(m.token_count for m, _s in active)
            print(f"[MiniMaxH3FantasticRefModTextEncode] references ready in {time.perf_counter() - t_start:.1f}s: "
                  f"media {media_tokens} tokens + RefMods {refmod_tokens} tokens = {media_tokens + refmod_tokens}"
                  " riding through every sampling step")

        if voiced:
            tokens = build_entries(clip.tokenizer, prompt, items)
            print(f"[MiniMaxH3FantasticRefModTextEncode] voice descriptions at their labels: {voiced}")
        else:
            tokens = clip.tokenize(prompt, minimax_ref_items=items)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        if blocks:
            print(f"[MiniMaxH3FantasticRefModTextEncode] conditioning: {conditioning[0][0].shape[1]:,} tokens "
                  "(the prompt plus what the encoder was shown), also riding through every sampling step")
        out = []
        for embedding, metadata in conditioning:
            if "minimax_token_tags" not in metadata:
                raise ValueError("The encoder returned no H3 token tags; use an H3 CLIP.")
            metadata = dict(metadata)
            if blocks:
                metadata["minimax_refs"] = list(metadata.get("minimax_refs", [])) + blocks
            out.append([embedding, metadata])
        latent = edit[0] if edit is not None else _empty_av_latent(width, height, length)[0]
        if edit is not None:
            mapping.append(f"Editing {references['edit']['name']} (masked area regenerated)")
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
