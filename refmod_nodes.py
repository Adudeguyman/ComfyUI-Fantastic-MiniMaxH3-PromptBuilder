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

from .refmod_core import check_bundle
from .refmods import KIND_LABEL

CATEGORY = "conditioning/video_models"


def _budget(rows, limit):
    total = sum(m.token_count for m, s in rows if s > 0)
    if limit and total > limit:
        raise ValueError(
            f"RefMods require {total} tokens after copies; the limit is {limit}. "
            "Lower a weight, drop a pick, or raise the limit.")
    return total


class MiniMaxH3FantasticRefModTextEncode:
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "Encode the prompt with the bundle's references presented to H3's "
        "native encoder, so <Picture n>, <Video n> and <Audio n> in the prompt "
        "name them. Already attaches the references: wire the conditioning "
        "straight to the sampler and do not Apply the same bundle again. "
        "Needs the H3 video VAE for visual references."
    )
    RETURN_TYPES = ("CONDITIONING", "STRING")
    RETURN_NAMES = ("conditioning", "reference_map")
    FUNCTION = "encode"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clip": ("CLIP",),
            "mods": ("H3_REF_MODS",),
            "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
            "reference_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0,
                "tooltip": "Playback rate assumed for a reconstructed video reference. "
                           "Compressed or stacked references do not keep their original timing."}),
            "max_total_tokens": ("INT", {"default": 0, "min": 0, "max": 2147483647,
                "tooltip": "Refuse bundles over this many reference tokens. 0 = no limit."}),
        }, "optional": {
            "vae": ("VAE", {"tooltip": "H3 video VAE. Reconstructs visual references for the "
                                       "encoder; not needed for audio-only bundles."}),
        }}

    def encode(self, clip, mods, prompt, reference_fps=24.0, max_total_tokens=0, vae=None):
        try:
            from comfy.text_encoders.minimax import MiniMaxH3Tokenizer
            from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE
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
        if visual and vae is None:
            raise ValueError("Connect the H3 video VAE to present visual RefMods to the encoder.")
        if visual and not isinstance(vae.first_stage_model, MiniMaxH3VideoVAE):
            raise ValueError("Visual RefMods need the MiniMax H3 video VAE.")

        items, blocks, mapping = [], [], []
        counters = {"image": 0, "video": 0, "audio": 0}
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
                # Show the encoder the same weakened latent the DiT receives.
                pixels = vae.decode(block["latent"])
                if pixels.ndim == 5 and pixels.shape[0] == 1:
                    pixels = pixels[0]
                if pixels.ndim != 4 or pixels.shape[-1] != 3 or pixels.shape[0] < 1:
                    raise ValueError(f"Unexpected VAE decode shape {tuple(pixels.shape)}.")
                if kind == "image":
                    item["data"] = pixels[:1].cpu().clone()
                else:
                    # Native H3 presents video at 2 fps, indexed by timestamp.
                    times = [i / 2 for i in range(math.ceil(pixels.shape[0] * 2 / reference_fps))]
                    idx = [min(round(t * reference_fps), pixels.shape[0] - 1) for t in times]
                    item["data"] = pixels[idx].cpu()
                    item["timestamps"] = times
                del pixels
            items.append(item)
            blocks.append(block)

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
        return out, "\n".join(mapping) or "No active RefMods."


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
