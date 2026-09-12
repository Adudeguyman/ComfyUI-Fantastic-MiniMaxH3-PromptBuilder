"""Inspect a RefMod: decode what's stored back into pictures and sound.

A RefMod is a latent, not a picture, so the only way to see what the model
is being given is to run it back through the H3 VAE. Frames are decoded one
at a time for photo stacks (each photo was encoded on its own) or together
as a clip; a voice is decoded to audio. `strength` below 1 shows the same
softening a weight below 1 applies. Adapted in spirit from
ComfyUI-MiniMaxH3Mod's Inspect node (MIT, Luisa / luisacaotica).
"""

import json
import os
import time
import wave

import numpy as np
import torch

import folder_paths
import comfy.model_management as mm

from .refmod_core import check_bundle, load_cached, _blur_latent
from .refmods import resolve_file

SUBFOLDER = "minimax_h3_inspect"
MAX_FRAMES = 48


def _weaken(z, strength):
    if strength >= 1.0:
        return z
    return strength * z + (1.0 - strength) * _blur_latent(z)


def _to_frames(pixels):
    """Any decoded shape to [N, H, W, 3] float in 0..1."""
    if pixels.ndim == 5:
        pixels = pixels.reshape(-1, *pixels.shape[-3:])
    if pixels.ndim != 4 or pixels.shape[-1] != 3:
        raise ValueError(f"Expected decoded RGB frames, got {tuple(pixels.shape)}.")
    return pixels.float().clamp(0, 1).cpu()


def _out_dir():
    path = os.path.join(folder_paths.get_temp_directory(), SUBFOLDER)
    os.makedirs(path, exist_ok=True)
    return path


def _save_png(frame, stem):
    from PIL import Image
    arr = (frame.numpy() * 255).round().astype(np.uint8)
    name = f"{stem}.png"
    Image.fromarray(arr).save(os.path.join(_out_dir(), name), compress_level=1)
    return {"filename": name, "subfolder": SUBFOLDER, "type": "temp"}


def _save_webp(frames, stem, fps=24):
    from PIL import Image
    ims = [Image.fromarray((f.numpy() * 255).round().astype(np.uint8)) for f in frames]
    name = f"{stem}.webp"
    ims[0].save(os.path.join(_out_dir(), name), save_all=True, append_images=ims[1:],
                duration=round(1000 / fps), loop=0, quality=80)
    return {"filename": name, "subfolder": SUBFOLDER, "type": "temp"}


def _save_wav(waveform, sample_rate, stem):
    """[1, C, L] float -> 16-bit PCM WAV, no extra dependencies."""
    w = waveform[0].float().clamp(-1, 1).cpu().numpy()          # [C, L]
    pcm = (w.T * 32767).round().astype("<i2")                   # [L, C] interleaved
    name = f"{stem}.wav"
    with wave.open(os.path.join(_out_dir(), name), "wb") as fh:
        fh.setnchannels(w.shape[0]); fh.setsampwidth(2); fh.setframerate(int(sample_rate))
        fh.writeframes(pcm.tobytes())
    return {"filename": name, "subfolder": SUBFOLDER, "type": "temp"}


class MiniMaxH3FantasticRefModInspect:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Decode a RefMod back into pictures and sound to see what the model is "
        "given. Give it a file name (as the library does) or a bundle and an "
        "index. 'frames' shows each stored frame on its own — right for a stack "
        "of photos; 'video' plays them as a clip. Strength below 1 previews the "
        "softening a lower weight applies."
    )
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING", "IMAGE", "AUDIO")
    RETURN_NAMES = ("details", "frames", "audio")
    FUNCTION = "inspect"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file": ("STRING", {"default": "", "tooltip": "RefMod file name under models/refmods, e.g. characters/hero_visual. Leave empty to use 'mods'."}),
                "view": (["frames", "video"], {"default": "frames",
                    "tooltip": "frames: each stored frame decoded on its own (photo stacks). video: decoded together as a clip."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Preview at this strength: below 1 shows the softening a lower weight applies."}),
                "audio_seconds": ("FLOAT", {"default": 30.0, "min": 0.5, "max": 600.0, "step": 0.5}),
            },
            "optional": {
                "mods": ("H3_REF_MODS",),
                "index": ("INT", {"default": 0, "min": 0, "max": 10000, "tooltip": "Which entry of 'mods' to inspect."}),
                "vae": ("VAE", {"tooltip": "MiniMax H3 video VAE, for a look."}),
                "audio_vae": ("VAE", {"tooltip": "MiniMax H3 audio VAE, for a voice."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def inspect(self, file, view, strength, audio_seconds, mods=None, index=0,
                vae=None, audio_vae=None):
        if file and file.strip():
            path = resolve_file(file.strip(), (".safetensors",))
            if not path:
                raise FileNotFoundError(f"RefMod '{file}' was not found under models/refmods.")
            mod = load_cached(path[:-len(".safetensors")])
            where = file.strip()
        else:
            rows = check_bundle(mods, "RefMod Inspect")
            if not rows:
                raise ValueError("Give a RefMod file name, or connect a bundle to 'mods'.")
            if not 0 <= index < len(rows):
                raise ValueError(f"'index' {index} is outside the bundle (0–{len(rows) - 1}).")
            mod = rows[index][0]
            where = getattr(mod, "path", "") or mod.name
        strength = max(0.0, min(1.0, float(strength)))
        details = {
            "name": mod.name, "file": where, "kind": mod.kind,
            "shape": list(mod.latent.shape), "tokens": mod.token_count,
            "mode": getattr(mod, "mode", ""), "pool": getattr(mod, "pool", ""),
            "source": getattr(mod, "source", ""), "source_shape": getattr(mod, "source_shape", ""),
            "description": getattr(mod, "description", ""), "concept_type": getattr(mod, "concept_type", ""),
            "strength_previewed": strength,
        }
        stem = f"{int(time.time() * 1000)}_{abs(hash((where, view, strength))) % 100000}"
        ui = {"images": [], "audio": []}
        frames = torch.zeros(1, 64, 64, 3)
        audio = {"waveform": torch.zeros(1, 2, 1), "sample_rate": 32000}

        if mod.kind == "audio":
            if audio_vae is None:
                raise ValueError("Connect the MiniMax H3 audio VAE to 'audio_vae' to hear a voice.")
            from comfy.ldm.minimax.audio_vae import MiniMaxH3AudioVAE
            from comfy_extras.nodes_audio import vae_decode_audio
            if not isinstance(audio_vae.first_stage_model, MiniMaxH3AudioVAE):
                raise ValueError("'audio_vae' is not the MiniMax H3 audio VAE.")
            z = _weaken(mod.latent[..., :max(1, round(audio_seconds * 40))], strength)
            out = vae_decode_audio(audio_vae, {"samples": z})
            audio = {"waveform": out["waveform"], "sample_rate": out["sample_rate"]}
            ui["audio"].append(_save_wav(out["waveform"], out["sample_rate"], stem))
            details["seconds"] = round(z.shape[-1] / 40, 2)
        else:
            if vae is None:
                raise ValueError("Connect the MiniMax H3 video VAE to 'vae' to see a look.")
            z = _weaken(mod.latent, strength)
            t = z.shape[2]
            if view == "video" and t > 1:
                mm.throw_exception_if_processing_interrupted()
                frames = _to_frames(vae.decode(z))
                ui["images"].append(_save_webp(list(frames), f"{stem}_clip"))
                details["decoded"] = f"{frames.shape[0]} frames as a clip"
            else:
                picked = list(range(min(t, MAX_FRAMES)))
                out = []
                for i in picked:
                    mm.throw_exception_if_processing_interrupted()
                    f = _to_frames(vae.decode(z[:, :, i:i + 1]))[:1]
                    out.append(f)
                    ui["images"].append(_save_png(f[0], f"{stem}_{i:03d}"))
                frames = torch.cat(out, dim=0)
                details["decoded"] = f"{len(picked)} of {t} stored frame{'s' if t != 1 else ''}"

        report = json.dumps(details, indent=2, ensure_ascii=False)
        ui["refmod_inspect"] = [report]
        return {"ui": ui, "result": (report, frames, audio)}


NODE_CLASS_MAPPINGS = {"MiniMaxH3FantasticRefModInspect": MiniMaxH3FantasticRefModInspect}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3FantasticRefModInspect": "Fantastic H3 Inspect RefMod"}
