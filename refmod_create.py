"""Create RefMods: encode a picture, clip or voice into a reference latent
and save it where the library and the stack will find it.

Encoding steps adapted from ComfyUI-MiniMaxH3Mod by Luisa (luisacaotica),
MIT License, Copyright (c) 2026 — the resize and frame-grid rules, the pooled
"compressed" mode with its model-free refinement, multi-source stacking and the
chunked audio encode. Left out on purpose: masks, multi-reference
merging, motion-only differencing and presets.

Several pictures or clips become one RefMod, stacked one frame per picture;
the first source sets the frame size. Over the token limit the node refuses
instead of dropping frames. It runs in the queue like any other node, so
ComfyUI manages the VAEs' memory; the library submits it as a hidden prompt.
"""

import json
import math
import os
import tempfile
import time

import torch
import torch.nn as nn
import torch.nn.functional as F
from safetensors.torch import save_file

import comfy.utils
import comfy.model_management as mm

from . import media_io
from .refmod_core import H3RefMod
from .refmods import search_dirs, valid_rel, sanitize_name, _contained_target, clean_subject_name, clean_description, PREVIEW_EXT

CONCEPT_TYPES = ("generic", "identity", "pose_motion", "clothing", "background",
                 "voice", "singing", "music_style", "sound_fx", "ambience", "style")
MODES = {"Full Reference": "encode", "Compressed Reference": "training"}
FORMAT_VERSION = 4


# ------------------------------------------------------------ pixels

def resize_ref(image, short_edge):
    """Aspect-preserving downscale (never up) to `short_edge`, dims to /32 —
    what the native reference node does before encoding."""
    h, w = image.shape[1], image.shape[2]
    if h <= 0 or w <= 0:
        raise ValueError(f"reference has an empty frame ({h}x{w})")
    scale = min(1.0, short_edge / min(h, w))
    tw = max(32, round(w * scale / 32) * 32)
    th = max(32, round(h * scale / 32) * 32)
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, tw, th, "lanczos", "disabled")
    return samples.movedim(1, -1)


def ensure_min_size(image, floor=320):
    """The H3 VAE tiles at ~256px; a smaller edge makes a zero-size tile."""
    h, w = image.shape[1], image.shape[2]
    if h >= floor and w >= floor:
        return image
    scale = floor / min(h, w)
    tw = max(floor, round(w * scale / 32) * 32)
    th = max(floor, round(h * scale / 32) * 32)
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, tw, th, "lanczos", "disabled")
    return samples.movedim(1, -1)


def snap_to_h3_grid(n):
    """Frames the H3 video VAE encodes whole: it works in chunks of 17 and
    stores 2 latent frames for the first chunk, then 5 more per chunk, so a
    clip is cut to 5, 22, 39, 56… frames (the same rule core's Reference to
    Video applies). Fewer than 5 frames are taken as they are."""
    if n <= 1:
        return 1
    if n < 5:
        return n
    return n - ((n - 5) % 17)


def h3_latent_frames(n):
    """Latent frames the H3 video VAE stores for n pixel frames."""
    if n <= 1:
        return 1
    return 5 * math.ceil(n / 17) - 3


# kept for callers that still import the old name
snap_to_causal_grid = snap_to_h3_grid


# ------------------------------------------------------------ latents

def aspect_grid(long_edge, aspect):
    """Even pool grid whose long edge is the dial and whose short edge
    follows the source aspect (h/w), so a portrait is not squashed square."""
    if aspect >= 1.0:
        h, w = long_edge, long_edge / aspect
    else:
        w, h = long_edge, long_edge * aspect
    return max(2, round(h / 2) * 2), max(2, round(w / 2) * 2)


def pool_latent(z, t, h, w):
    if z.shape[2] == t and z.shape[3] == h and z.shape[4] == w:
        return z
    return F.adaptive_avg_pool3d(z.float(), (t, h, w)).to(z.dtype)


def optimize_latent(z_small, z_full, steps=150, lr=0.02, progress=None):
    """Refine the pooled latent so its trilinear upsample matches the full
    encode. Only the small latent is trainable; no diffusion model."""
    if steps <= 0:
        return z_small
    device = z_full.device
    with torch.inference_mode(False), torch.set_grad_enabled(True):
        target = z_full.clone().float().to(device)
        param = nn.Parameter(z_small.clone().float().to(device))
        opt = torch.optim.Adam([param], lr=lr)
        size = tuple(target.shape[2:])
        for i in range(steps):
            if i % 25 == 0:
                mm.throw_exception_if_processing_interrupted()
            opt.zero_grad()
            up = F.interpolate(param, size=size, mode="trilinear", align_corners=False)
            F.mse_loss(up, target).backward()
            opt.step()
            if progress and (i + 1) % 50 == 0:
                progress(i + 1, steps)
        refined = param.detach().to(z_small.dtype)
    return refined


def check_budget(latent, budget, label):
    """Refuse, never trim: a stack over its cap would otherwise lose whole
    photos without anyone noticing. Raised before anything is saved."""
    if budget <= 0:
        return
    tokens = latent.shape[2] * (latent.shape[3] // 2) * (latent.shape[4] // 2)
    if tokens > budget:
        raise ValueError(
            f"'{label}' needs {tokens} tokens; the limit is {budget}. Raise the limit, "
            "lower the resolution or clip frames, use Compressed, or leave some "
            "sources out. Nothing was saved.")


def _cover(image, tw, th):
    """Scale and centre-crop to exactly tw x th."""
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, tw, th, "lanczos", "center")
    return samples.movedim(1, -1)


def encode_look(vae, sources, *, mode, ref_resolution, grid, latent_frames,
                steps, max_tokens, label, progress=None):
    """One latent from one or more sources, stacked along time.

    `sources` is [(frames [N,H,W,3], is_video)]. Each is encoded on its own
    and the results are joined, one latent frame per picture and a short
    sequence per clip. They must share a frame size, so the first source
    sets it: Full cover-crops the others to its canvas, Compressed pools
    every one to a grid shaped like it — the same rules as
    ComfyUI-MiniMaxH3Mod's Create node."""
    try:
        from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE
        if not isinstance(vae.first_stage_model, MiniMaxH3VideoVAE):
            raise ValueError("Connect the MiniMax H3 video VAE to 'vae'.")
    except ImportError:
        pass
    if not sources:
        raise ValueError("no pictures or clips to encode")
    for frames, _v in sources:
        if frames.ndim != 4 or frames.shape[-1] < 3:
            raise ValueError(f"{label}: expected an IMAGE batch, got {tuple(frames.shape)}")
    h0, w0 = sources[0][0].shape[1], sources[0][0].shape[2]
    canvas = None
    if mode == "encode" and len(sources) > 1:
        scale = min(1.0, ref_resolution / min(h0, w0))
        canvas = (max(32, round(w0 * scale / 32) * 32), max(32, round(h0 * scale / 32) * 32))
    gh, gw = aspect_grid(grid, h0 / w0)

    parts, shapes, notes, first_frame = [], [], [], None
    n = len(sources)
    for i, (src, is_video) in enumerate(sources):
        src = src if is_video else src[:1]
        if is_video:
            # The first `latent_frames` pixel frames of the clip, consecutive
            # so the motion is real, then cut to a whole number of H3 chunks.
            # (Evenly spaced picks across a long clip encoded as if they were
            # consecutive, which stored a jerky, mostly-frozen reference.)
            src = src[:snap_to_h3_grid(min(latent_frames, src.shape[0]))]
        src = _cover(src, *canvas) if canvas else resize_ref(src, ref_resolution)
        src = ensure_min_size(src)
        if first_frame is None:
            first_frame = src[0].detach().cpu()
        mm.throw_exception_if_processing_interrupted()
        z = vae.encode(src)
        if z.dim() != 5 or z.shape[1] != 24:
            raise ValueError(f"Expected an H3 video latent [1,24,T,H,W], got {tuple(z.shape)}; "
                             "the connected VAE is not the H3 video VAE.")
        shapes.append(f"{z.shape[2]}x{z.shape[3]}x{z.shape[4]}")
        if mode == "encode":
            part = z.to(torch.float16)
        else:
            # Compressed pools space only; the clip keeps every stored frame.
            part = pool_latent(z, z.shape[2] if is_video else 1, gh, gw).to(torch.float16)
            if steps > 0:
                part = optimize_latent(part, z.float(), steps=steps,
                    progress=(lambda k, m, i=i: progress((i + k / m) / n)) if progress else None)
        parts.append(part.cpu())
        if progress:
            progress((i + 1) / n)
    latent = torch.cat(parts, dim=2).contiguous()
    check_budget(latent, max_tokens, label)
    if len(sources) > 1:
        notes.append(f"stacked {len(sources)} sources into {latent.shape[2]} frames")
    info = {"source_shape": " +".join(shapes),
            "pool": "" if mode == "encode" else f"{latent.shape[2]}x{gh}x{gw}",
            "notes": notes, "first_frame": first_frame}
    return latent, info


def join_audio(clips):
    """Several AUDIO dicts -> one, in order, as 32 kHz stereo."""
    import torchaudio
    parts = []
    for a in clips:
        w, sr = a["waveform"], int(a["sample_rate"])
        if w.ndim != 3 or w.shape[0] != 1 or w.shape[1] not in (1, 2) or sr <= 0 or w.shape[-1] < 1:
            raise ValueError("Audio must be one batch of mono or stereo samples.")
        if w.shape[1] == 1:
            w = w.repeat(1, 2, 1)
        if sr != 32000:
            w = torchaudio.functional.resample(w, sr, 32000)
        parts.append(w.float())
    return {"waveform": torch.cat(parts, dim=-1), "sample_rate": 32000}


def encode_audio(vae, audio, max_seconds=30.0, chunk_seconds=10.0):
    """AUDIO dict -> [1,32,2,T] latent: 32 kHz stereo, 40 latent frames/s.

    Goes through ComfyUI's VAE wrapper (`vae.encode`, channels-last), the
    same call core's own reference node makes — so device placement, dtype,
    memory estimates and dynamic VRAM loading are all ComfyUI's business.
    Reaching into `first_stage_model` directly is what the other packs do,
    and it bypasses all of that. Encoded in 10 s pieces (multiples of the
    VAE's 800-sample hop, so no padding lands mid-clip)."""
    from comfy.ldm.minimax.audio_vae import MiniMaxH3AudioVAE
    waveform, sample_rate = audio["waveform"], int(audio["sample_rate"])
    if waveform.ndim != 3 or waveform.shape[0] != 1 or waveform.shape[1] not in (1, 2):
        raise ValueError("Audio must be one batch of mono or stereo samples.")
    if sample_rate <= 0 or waveform.shape[-1] < 1:
        raise ValueError("Audio is empty or has an invalid sample rate.")
    if not isinstance(vae.first_stage_model, MiniMaxH3AudioVAE):
        raise ValueError("Connect the MiniMax H3 audio VAE to 'audio_vae'.")
    stages = [f"in {waveform.shape[-1]}@{sample_rate}"]
    try:
        max_seconds = float(max_seconds)
    except (TypeError, ValueError):
        max_seconds = 30.0
    if not (max_seconds > 0):
        max_seconds = 30.0
    waveform = waveform[..., :max(1, round(max_seconds * sample_rate))].float()
    stages.append(f"limit {max_seconds:g}s -> {waveform.shape[-1]}")
    if waveform.shape[1] == 1:
        waveform = waveform.repeat(1, 2, 1)
    vae_sr = int(getattr(vae, "audio_sample_rate", 32000) or 32000)
    if sample_rate != vae_sr:
        import torchaudio
        waveform = torchaudio.functional.resample(waveform, sample_rate, vae_sr)
        stages.append(f"resample -> {waveform.shape[-1]}@{vae_sr}")
    hop = int(getattr(vae, "downscale_ratio", 800) or 800)
    # The wrapper crops each piece down to whole hops (and a piece shorter
    # than one hop to nothing), so pad once up to a whole hop — as the
    # model itself would — and cut pieces that are always hop multiples.
    rem = waveform.shape[-1] % hop
    if rem:
        waveform = torch.nn.functional.pad(waveform, (0, hop - rem))
    stages.append(f"pad -> {waveform.shape[-1]} (hop {hop})")
    if waveform.shape[-1] < hop * 20:                       # under half a second: nothing usable
        raise ValueError(
            "The voice is too short to encode after the seconds limit — "
            + ", ".join(stages) + ". Check 'audio_max_seconds' and the audio's trim.")
    chunk = max(hop, round(chunk_seconds * vae_sr / hop) * hop)
    print(f"[MiniMaxH3FantasticRefModCreate] voice samples: " + ", ".join(stages) + f", pieces of {chunk}")
    latents = []
    for start in range(0, waveform.shape[-1], chunk):
        mm.throw_exception_if_processing_interrupted()
        piece = waveform[..., start:start + chunk]
        with torch.no_grad():                                # the queue is already grad-free; standalone callers aren't
            z = vae.encode(piece.movedim(1, -1))             # [1, L, 2] in, [1, 32, 2, T] out
        if z.ndim != 4 or tuple(z.shape[:3]) != (1, 32, 2):
            raise ValueError(f"H3 audio VAE returned an invalid latent: {tuple(z.shape)}")
        latents.append(z.detach().cpu())
    out = torch.cat(latents, dim=-1).to(torch.float16).contiguous()
    print(f"[MiniMaxH3FantasticRefModCreate] voice latent: {out.shape[-1]} frames "
          f"({out.shape[-1] / 40:.2f}s) from {waveform.shape[-1] / vae_sr:.2f}s of audio")
    return out


# ------------------------------------------------------------ files

def target_root():
    """Where new files go: the first registered refmods root."""
    dirs = search_dirs()
    if not dirs:
        raise RuntimeError("No refmods folder is registered.")
    os.makedirs(dirs[0], exist_ok=True)
    return dirs[0]


def save_mod(mod, path_no_ext):
    os.makedirs(os.path.dirname(path_no_ext) or ".", exist_ok=True)
    meta = {
        "name": mod.name, "kind": mod.kind,
        "latent_h": mod.latent_h, "latent_w": mod.latent_w, "latent_t": mod.latent_t,
        "mode": mod.mode, "source": mod.source, "source_shape": mod.source_shape,
        "pool": mod.pool, "optimize_steps": mod.optimize_steps, "tags": mod.tags,
        "description": mod.description, "concept_type": mod.concept_type,
        "_format_version": FORMAT_VERSION, "sample_rate": mod.sample_rate,
    }
    if mod.config:
        meta["refmod_config"] = json.dumps(mod.config)
    for key in ("subject_name", "appearance", "voice_description"):
        if getattr(mod, key, ""):
            meta[key] = getattr(mod, key)
    dest = path_no_ext + ".safetensors"
    fd, tmp = tempfile.mkstemp(prefix=".refmod-", suffix=".tmp", dir=os.path.dirname(dest) or ".")
    os.close(fd)
    try:
        save_file({"latent": mod.latent.contiguous()}, tmp, metadata={"refmod_meta": json.dumps(meta)})
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return dest


def save_preview(path_no_ext, frame, max_edge=512):
    """PNG beside the file from one [H,W,3] float frame; other preview
    extensions for the same stem are removed so the library shows this one."""
    from PIL import Image
    arr = (frame.clamp(0, 1) * 255).round().to(torch.uint8).numpy()
    im = Image.fromarray(arr)
    im.thumbnail((max_edge, max_edge))
    for ext in PREVIEW_EXT:
        if ext != ".png" and os.path.isfile(path_no_ext + ext):
            os.remove(path_no_ext + ext)
    im.save(path_no_ext + ".png", optimize=True)
    return path_no_ext + ".png"


# ------------------------------------------------------------ the node

def _trim(item):
    t = item.get("trim") if isinstance(item, dict) else None
    if not isinstance(t, dict):
        return None, None
    def num(v):
        try:
            v = float(v)
            return v if v > 0 else None
        except (TypeError, ValueError):
            return None
    return num(t.get("start")), num(t.get("end"))


def parse_sources(source):
    """`source` JSON: one Media Loader item, or a list of them (a stack)."""
    if not source or not str(source).strip():
        return []
    try:
        data = json.loads(source)
    except Exception:
        raise ValueError("'source' is not valid JSON.")
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise ValueError("'source' must be an item or a list of items.")
    return [d for d in data if isinstance(d, dict) and d.get("file")]


def load_look(item):
    """(frames, is_video) for a picture or clip item, else None."""
    kind, (start, end) = item.get("kind"), _trim(item)
    if kind == "picture":
        return media_io.load_image(item["file"], crop=item.get("crop"),
                                   mirror=bool(item.get("mirror")),
                                   rotate=item.get("rotate") or 0,
                                   resize=item.get("resize") or 0), False
    if kind == "video":
        return media_io.load_video_frames(item["file"], start=start, end=end,
                                          crop=item.get("crop"),
                                          mirror=bool(item.get("mirror")),
                                          resize=item.get("resize")), True
    return None


MIN_VOICE_SECONDS = 0.5


def load_voice(item):
    """AUDIO for an audio item, or a clip's soundtrack unless switched off.
    Says what it decoded, and refuses a sliver: a voice a few samples long
    encodes to one silent latent frame and nobody notices until the RefMod
    is used."""
    kind, (start, end) = item.get("kind"), _trim(item)
    if kind == "audio":
        voice = media_io.load_audio(item["file"], start=start, end=end)
    elif kind == "video" and item.get("has_audio") and (item.get("audio_mode") or "paired") != "off":
        voice = media_io.extract_audio(item["file"], start=start, end=end)
    else:
        return None
    w, sr = voice["waveform"], int(voice["sample_rate"])
    secs = w.shape[-1] / sr if sr else 0.0
    trim = f", trim {start or 0:.2f}\u2013{end if end is not None else 'end'}" if (start or end) else ""
    print(f"[MiniMaxH3FantasticRefModCreate] voice from {item['file']}: "
          f"{secs:.2f}s, {sr} Hz, {w.shape[1]} ch{trim}")
    if secs < MIN_VOICE_SECONDS:
        raise ValueError(
            f"The voice from '{item['file']}' is only {secs:.2f} s long"
            f"{' after its trim' if (start or end) else ''} (needs at least "
            f"{MIN_VOICE_SECONDS} s). Check the file and its trim. Nothing was saved.")
    return voice


class MiniMaxH3FantasticRefModCreate:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Encode pictures, clips or a voice into one RefMod and save it under "
        "models/refmods, with a preview image beside it. Several pictures or "
        "clips are stacked into a single RefMod, one frame each; the first one "
        "sets the frame size. 'source' is written by the RefMod library (one "
        "Media Loader item or a list); the image / audio inputs replace it for "
        "graph use. Over the token limit it refuses rather than dropping frames."
    )
    OUTPUT_NODE = True
    RETURN_TYPES = ("H3_REF_MODS", "STRING")
    RETURN_NAMES = ("mods", "saved")
    FUNCTION = "create"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "name": ("STRING", {"default": "", "tooltip": "File name. A look plus a voice is saved as <name>_visual and <name>_audio."}),
                "subfolder": ("STRING", {"default": "", "tooltip": "Folder under models/refmods, e.g. characters."}),
                "mode": (list(MODES.keys()), {"default": "Compressed Reference",
                    "tooltip": "Full keeps the most detail and is heavier to use. Compressed keeps the overall look and is much lighter."}),
                "ref_resolution": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 32,
                    "tooltip": "Short edge each source is scaled down to before encoding (never up)."}),
                "grid": ("INT", {"default": 16, "min": 2, "max": 64, "step": 2,
                    "tooltip": "Compressed: size of the small grid on its long edge. 16 is up to 64 tokens per frame."}),
                "latent_frames": ("INT", {"default": 22, "min": 1, "max": 1024,
                    "tooltip": "Clips: how many frames to take from the start of the clip (after its trim). "
                               "H3 stores 2 frames for up to 17 and 5 more per 17 after that, so 22 stores 7, "
                               "39 stores 12, 56 stores 17; anything between is cut down to the last of those."}),
                "refinement_steps": ("INT", {"default": 500, "min": 0, "max": 5000,
                    "tooltip": "Compressed: how long the small grid is refined toward the full encode."}),
                "max_tokens": ("INT", {"default": 5120, "min": 0, "max": 1048576,
                    "tooltip": "Refuse to save a look over this many tokens. 0 = no limit."}),
                "audio_max_seconds": ("FLOAT", {"default": 30.0, "min": 0.5, "max": 600.0, "step": 0.5,
                    "tooltip": "Voice: seconds kept from the start of the joined audio."}),
                "concept_type": (list(CONCEPT_TYPES), {"default": "generic"}),
                "description": ("STRING", {"default": "", "multiline": True,
                    "tooltip": "Shown in the library."}),
                "write_preview": ("BOOLEAN", {"default": True,
                    "tooltip": "Save the first frame as <name>.png beside the file for the library's thumbnail."}),
                "source": ("STRING", {"default": "", "multiline": False,
                    "tooltip": "Media Loader item, or a list of them, as JSON. Filled by the RefMod library."}),
            },
            "optional": {
                "subject_name": ("STRING", {"default": "", "tooltip": "Optional one-word name used in prompts: the Prompt Builder's "
                    "Draft from RefMods names the subject this, and !Name stands for it. Kept in the file's header."}),
                "appearance": ("STRING", {"default": "", "tooltip": "Optional: how the subject looks. Draft from RefMods writes it "
                    "into the subject's definition line. Kept in the file's header."}),
                "voice_description": ("STRING", {"default": "", "tooltip": "Optional: how the voice sounds. Draft from RefMods adds it to "
                    "the voice line, and the speaker buttons use it. Kept in the file's header."}),
                "image": ("IMAGE", {"tooltip": "Look: one image, or a clip's frames at 24 fps. Replaces the source's pictures and clips."}),
                "audio": ("AUDIO", {"tooltip": "Voice. Replaces the source's audio."}),
                "vae": ("VAE", {"tooltip": "MiniMax H3 video VAE."}),
                "audio_vae": ("VAE", {"tooltip": "MiniMax H3 audio VAE."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")            # a save is a side effect: always run

    @classmethod
    def VALIDATE_INPUTS(cls, name="", subfolder="", subject_name="", appearance="", voice_description=""):
        # No **kwargs here on purpose: ComfyUI skips every input's min/max
        # check for a node whose validator takes **kwargs, which is how a
        # cleared "Voice seconds" box once reached the encoder as 0.
        rel = "/".join(p for p in (sanitize_name(subfolder, folder=True), sanitize_name(name)) if p)
        if not sanitize_name(name):
            return "Give the RefMod a name."
        if not valid_rel(rel):
            return f"'{rel}' is not a valid RefMod name."
        try:
            clean_subject_name(subject_name)
            clean_description(appearance, "appearance")
            clean_description(voice_description, "voice description")
        except ValueError as exc:
            return str(exc)
        return True

    def create(self, name, subfolder, mode, ref_resolution, grid, latent_frames,
               refinement_steps, max_tokens, audio_max_seconds, concept_type,
               description, write_preview, source, image=None, audio=None,
               vae=None, audio_vae=None, subject_name="", appearance="", voice_description=""):
        subject_name = clean_subject_name(subject_name)
        described = {"subject_name": subject_name,
                     "appearance": clean_description(appearance, "appearance"),
                     "voice_description": clean_description(voice_description, "voice description")}
        mode_key = MODES.get(mode, "training")
        audio_max_seconds = max(0.5, min(600.0, float(audio_max_seconds or 0) or 30.0))
        items = parse_sources(source)

        # --- gather: connected inputs replace what the source list provides
        if image is not None:
            looks = [(image, image.shape[0] > 1)]
        else:
            looks = [lk for lk in (load_look(it) for it in items) if lk is not None]
        if audio is not None:
            voice = audio
        else:
            voices = [v for v in (load_voice(it) for it in items) if v is not None] if audio_vae is not None else []
            voice = voices[0] if len(voices) == 1 else (join_audio(voices) if voices else None)
        if not looks and voice is None:
            raise ValueError("Nothing to encode: connect an image or audio, or give source items.")
        if looks and vae is None:
            raise ValueError("Connect the MiniMax H3 video VAE to 'vae' to encode the look.")
        if voice is not None and audio_vae is None:
            raise ValueError("Connect the MiniMax H3 audio VAE to 'audio_vae' to encode the voice.")

        clean = sanitize_name(name)
        folder = sanitize_name(subfolder, folder=True)
        base = f"{folder}/{clean}" if folder else clean
        if not valid_rel(base):
            raise ValueError(f"'{base}' is not a valid RefMod name.")
        root = target_root()
        # valid_rel already refused '..', drives and absolute paths; check the
        # resolved target against the root as well, and refuse, never rewrite.
        _contained_target(root, base)
        both = bool(looks) and voice is not None
        pbar = comfy.utils.ProgressBar(100)

        # --- encode everything first: a refusal must leave no files behind
        look = None
        if looks:
            latent, info = encode_look(
                vae, looks, mode=mode_key, ref_resolution=ref_resolution, grid=grid,
                latent_frames=latent_frames, steps=refinement_steps, max_tokens=max_tokens,
                label=clean, progress=lambda f: pbar.update_absolute(int(70 * f)))
            n_img = sum(1 for _f, v in looks if not v)
            n_vid = len(looks) - n_img
            tag = ", ".join(t for t in (f"{n_img} img" if n_img else "", f"{n_vid} vid" if n_vid else "") if t)
            look = (H3RefMod(
                name=clean, kind="video" if latent.shape[2] > 1 else "image", latent=latent,
                latent_h=latent.shape[3], latent_w=latent.shape[4], latent_t=latent.shape[2],
                mode=mode_key,
                source="stack" if len(looks) > 1 else ("video" if looks[0][1] else "image"),
                source_shape=info["source_shape"], pool=info["pool"],
                optimize_steps=refinement_steps if mode_key == "training" else 0,
                tags=[tag], description=description or "", concept_type=concept_type,
                **described), info)
        pbar.update_absolute(75)
        vmod = None
        if voice is not None:
            alat = encode_audio(audio_vae, voice, max_seconds=audio_max_seconds)
            vmod = H3RefMod(
                name=clean, kind="audio", latent=alat, mode="encode", source="audio",
                source_shape=f"audio:{alat.shape[-1]}", pool=f"{alat.shape[-1]} audio",
                tags=[f"{alat.shape[-1] / 40:.1f}s audio"], description=description or "",
                concept_type=concept_type if concept_type in ("voice", "singing", "music_style", "sound_fx", "ambience") else "voice",
                sample_rate=32000, **described)

        # --- save; a failure part-way removes what was already written
        saved, mods = [], []
        try:
            if look:
                mod, info = look
                stem = os.path.join(root, base + ("_visual" if both else ""))
                mod.path = stem
                saved.append(save_mod(mod, stem))
                mods.append((mod, 1.0))
                for n in info["notes"]:
                    print(f"[MiniMaxH3FantasticRefModCreate] {clean}: {n}")
                if write_preview and info["first_frame"] is not None:
                    saved.append(save_preview(os.path.join(root, base), info["first_frame"]))
            if vmod:
                stem = os.path.join(root, base + ("_audio" if both else ""))
                vmod.path = stem
                saved.append(save_mod(vmod, stem))
                mods.append((vmod, 1.0))
        except Exception:
            for path in saved:
                try:
                    os.remove(path)
                except OSError:
                    pass
            raise
        pbar.update_absolute(100)

        rel = [os.path.relpath(p, root).replace("\\", "/") for p in saved]
        print(f"[MiniMaxH3FantasticRefModCreate] saved " + ", ".join(rel)
              + f" ({sum(m.token_count for m, _s in mods)} tokens)")
        return {"ui": {"refmod_saved": rel}, "result": (mods, "\n".join(rel))}


NODE_CLASS_MAPPINGS = {"MiniMaxH3FantasticRefModCreate": MiniMaxH3FantasticRefModCreate}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3FantasticRefModCreate": "Fantastic H3 Create RefMod"}
