"""RefMod runtime: load a saved reference, weaken it, hand it to the model.

Adapted from ComfyUI-MiniMaxH3Mod by Luisa (luisacaotica), MIT License,
Copyright (c) 2026 — https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod.
Kept deliberately small: the parts a bundle needs to *consume* RefMod files
(load, strength, frame curve, native block). Creating RefMods, step curves,
scrambling and graph presets stay with that pack.

Compatibility contract. That pack's nodes hold a bundle as a list of
(mod, strength) pairs and call `mod.kind`, `mod.name`, `mod.token_count`,
`mod.latent`, `mod.latent_t`, `mod.description`, `mod.concept_type`,
`mod.config` and `mod.ref_block(strength, curve=None)`. This class keeps all
of them, with the same meaning, so a bundle from our stack works in their
Apply / Step Curve / Config / Inspect and theirs works in ours. Nothing here
checks the object's class — only its shape — because both packs share the
`H3_REF_MODS` link type and ComfyUI never inspects what travels on it.

The block dicts returned by `ref_block` are ComfyUI core's own H3 reference
format (consumed in comfy/model_base.py), the same shape the native
reference node builds.
"""

import json
import math
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import torch
import torch.nn.functional as F
from safetensors.torch import load_file

from .refmods import read_meta

MODE_ALIASES = {"full": "encode", "pooled": "training",
                "Full Reference": "encode", "Compressed Reference": "training"}

CURVE_DIRECTIONS = ("constant", "concept_at_start", "concept_at_middle",
                    "concept_at_end", "concept_at_ends")
CURVE_SHAPES = ("linear", "ease", "sigmoid", "tanh", "quadratic", "cubic",
                "exponential", "stair", "elastic", "bump", "dip")
_LEGACY_CURVES = {
    "flat": ("constant", "linear", 1.0),
    "fade_in": ("concept_at_end", "linear", 1.0),
    "fade_out": ("concept_at_start", "linear", 1.0),
    "bump": ("concept_at_end", "bump", 1.0),
    "dip": ("constant", "dip", 1.0),
}


def _blur_latent(z: torch.Tensor, factor: int = 8) -> torch.Tensor:
    """Heavy low-pass (down then up) used as the target when weakening a
    reference. Mixing toward a blurred copy stays on the latent manifold —
    it reads as a softer reference, where mixing toward noise reads as
    garbled texture."""
    if z.dim() == 4:
        b, c, stereo, t = z.shape
        if t <= 1:
            return z
        flat = z.reshape(b * c * stereo, 1, t).float()
        down = F.adaptive_avg_pool1d(flat, max(1, t // factor))
        return F.interpolate(down, size=t, mode="linear",
                             align_corners=False).reshape_as(z).to(z.dtype)
    if z.dim() != 5:
        raise ValueError(f"Unsupported RefMod latent shape: {tuple(z.shape)}")
    t, h, w = z.shape[2], z.shape[3], z.shape[4]
    sh, sw = max(1, h // factor), max(1, w // factor)
    down = F.adaptive_avg_pool3d(z.float(), (t, sh, sw))
    up = F.interpolate(down, size=(t, h, w), mode="trilinear", align_corners=False)
    return up.to(z.dtype)


def _ease(shape: str, x: float) -> float:
    if shape == "linear":
        return x
    if shape == "ease":
        return x * x * (3.0 - 2.0 * x)
    if shape == "sigmoid":
        return 1.0 / (1.0 + math.exp(-12.0 * (x - 0.5)))
    if shape == "tanh":
        return 0.5 * (math.tanh(8.0 * (x - 0.5)) + 1.0)
    if shape == "quadratic":
        return x * x
    if shape == "cubic":
        return x * x * x
    if shape == "exponential":
        return 2.0 ** x - 1.0
    if shape == "stair":
        return min(1.0, math.floor(x * 4) / 3.0)
    if shape == "elastic":
        if x <= 0.0:
            return 0.0
        if x >= 1.0:
            return 1.0
        return 2.0 ** (-10.0 * x) * math.sin((x * 10.0 - 0.75) * (2.0 * math.pi / 3.0)) + 1.0
    if shape == "bump":
        return 1.0 - abs(2.0 * x - 1.0)
    if shape == "dip":
        return abs(2.0 * x - 1.0)
    return x


def curve_strengths(spec, t: int) -> Optional[List[float]]:
    """Per-frame strength multipliers in [0, 1] for a curve spec, or None
    for flat. Accepts the (direction, shape, value) tuple their Apply
    passes, a legacy preset name, a list of per-frame floats, (x, y) control
    points, or anything with interp(x)."""
    if t <= 1 or spec is None or spec == "":
        return None
    if isinstance(spec, str):
        legacy = _LEGACY_CURVES.get(spec)
        return curve_strengths(legacy, t) if legacy is not None else None
    if (isinstance(spec, tuple) and len(spec) == 3
            and isinstance(spec[0], str) and isinstance(spec[1], str)):
        direction, shape, value = spec
        value = float(value)
        if direction == "constant":
            if shape == "linear":
                return None if value >= 1.0 else [value] * t
            p = [_ease(shape, i / (t - 1)) for i in range(t)]
            return [max(0.0, min(1.0, value * y)) for y in p]
        p = [_ease(shape, i / (t - 1)) for i in range(t)]
        if direction in ("concept_at_end", "increase"):
            return [max(0.0, min(1.0, value * y)) for y in p]
        if direction in ("concept_at_start", "decrease"):
            return [max(0.0, min(1.0, value * (1.0 - y))) for y in p]
        if direction == "concept_at_middle":
            return [max(0.0, min(1.0, value * (1.0 - abs(2.0 * y - 1.0)))) for y in p]
        if direction == "concept_at_ends":
            return [max(0.0, min(1.0, value * abs(2.0 * y - 1.0))) for y in p]
        return None
    if isinstance(spec, (list, tuple)):
        if len(spec) == t and all(isinstance(v, (int, float)) for v in spec):
            return [float(v) for v in spec]
        pts = [(float(x), float(y)) for x, y in spec
               if isinstance(x, (int, float)) and isinstance(y, (int, float))]
        if pts:
            pts = sorted(pts, key=lambda p: p[0])
            out = []
            for i in range(t):
                x = i * (1.0 / (t - 1))
                if x <= pts[0][0]:
                    out.append(pts[0][1])
                elif x >= pts[-1][0]:
                    out.append(pts[-1][1])
                else:
                    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                        if x0 <= x <= x1:
                            out.append(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
                            break
            return out
    interp = getattr(spec, "interp", None)
    if callable(interp):
        return [float(interp(i / (t - 1))) for i in range(t)]
    return None


@dataclass
class H3RefMod:
    """One saved reference: a VAE latent plus what the file says about it.

    Visual latents are [1, 24, T, H, W]; audio latents are [1, 32, 2, T]."""

    name: str
    kind: str
    latent: torch.Tensor
    latent_h: int = 4
    latent_w: int = 4
    latent_t: int = 1
    mode: str = "training"
    source: str = ""
    source_shape: str = ""
    pool: str = ""
    optimize_steps: int = 0
    tags: List[str] = field(default_factory=list)
    description: str = ""
    concept_type: str = "generic"
    config: Dict = field(default_factory=dict)
    sample_rate: int = 32000
    subject_name: str = ""    # used in prompts (!Name); description stays a personal note
    appearance: str = ""      # drafted into the subject's definition line
    voice_description: str = ""   # drafted onto the voice line and the speaker buttons
    path: str = ""

    def __post_init__(self):
        if self.kind == "audio":
            if (self.latent.ndim != 4 or tuple(self.latent.shape[:3]) != (1, 32, 2)
                    or self.latent.shape[-1] < 1):
                raise ValueError("H3 audio RefMod must contain [1,32,2,T] with T >= 1.")
            self.latent_t = self.latent.shape[-1]
            self.latent_h = self.latent_w = 0
            return
        if self.kind not in ("image", "video"):
            raise ValueError(f"kind must be 'image', 'video' or 'audio' (got {self.kind!r})")
        if self.latent.ndim != 5:
            raise ValueError("H3 visual RefMod must contain [1,24,T,H,W].")
        if self.kind == "image":
            self.latent_t = 1

    @property
    def token_count(self) -> int:
        if self.kind == "audio":
            return 2 * self.latent_t
        return self.latent_t * (self.latent_h // 2) * (self.latent_w // 2)

    def ref_block(self, strength: float = 1.0, curve=None) -> Optional[Dict]:
        """The block dict the model consumes. `strength` <= 0 drops the
        reference; below 1 it is mixed toward a blurred copy of itself;
        `curve` gives each latent frame its own strength (see
        curve_strengths). Same signature as ComfyUI-MiniMaxH3Mod's."""
        if strength <= 0.0:
            return None
        latent = self.latent
        strengths = curve_strengths(curve, self.latent_t) if curve is not None else None
        if strengths is not None:
            weights = [max(0.0, min(1.0, strength * value)) for value in strengths]
            if any(value < 1.0 for value in weights):
                shape = ((1, 1, 1, self.latent_t) if self.kind == "audio"
                         else (1, 1, self.latent_t, 1, 1))
                st = latent.new_tensor(weights).view(shape)
                latent = st * latent + (1.0 - st) * _blur_latent(latent)
        elif strength < 1.0:
            latent = strength * latent + (1.0 - strength) * _blur_latent(latent)
        if self.kind == "audio":
            return {"kind": "audio", "ref_audio_t": self.latent_t, "audio_latent": latent}
        block: Dict = {"kind": self.kind, "latent_h": self.latent_h,
                       "latent_w": self.latent_w, "latent": latent}
        if self.kind == "video":
            block["latent_t"] = self.latent_t
            block["ref_audio_t"] = 0
            block["audio_latent"] = None
        return block

    @classmethod
    def load(cls, path_no_ext: str, device: str = "cpu", member=None) -> "H3RefMod":
        meta, _tensors = read_meta(path_no_ext)
        if not isinstance(meta, dict):
            raise ValueError(f"{path_no_ext}.safetensors has no RefMod metadata.")
        if meta.get("kind") == "bundle":
            # ComfyUI-MiniMaxH3Mod's single-file bundle (format 5): members are
            # ordinary references stored as ref_0, ref_1… with their own
            # metadata. Read only the one asked for.
            from .refmods import bundle_members
            refs = bundle_members(meta)
            if member is None or not 0 <= member < len(refs):
                raise ValueError(f"{os.path.basename(path_no_ext)} is a RefMod bundle; "
                                 "pick one of its members from the library.")
            from safetensors import safe_open
            with safe_open(path_no_ext + ".safetensors", framework="pt", device=device) as fh:
                latent = fh.get_tensor(f"ref_{member}").clone()
            meta = refs[member]
        else:
            latent = load_file(path_no_ext + ".safetensors", device=device)["latent"].clone()
        raw_config = meta.get("refmod_config")
        try:
            config = json.loads(raw_config) if isinstance(raw_config, str) else {}
        except ValueError:
            config = {}
        five = latent.ndim == 5
        return cls(
            name=meta.get("name", os.path.basename(path_no_ext)),
            kind=meta.get("kind", "image"),
            latent=latent,
            latent_h=int(meta.get("latent_h", latent.shape[3] if five else 0)),
            latent_w=int(meta.get("latent_w", latent.shape[4] if five else 0)),
            latent_t=int(meta.get("latent_t", latent.shape[2] if five else latent.shape[-1])),
            mode=MODE_ALIASES.get(meta.get("mode", "training"), meta.get("mode", "training")),
            source=meta.get("source", ""),
            source_shape=meta.get("source_shape", ""),
            pool=meta.get("pool", ""),
            optimize_steps=int(meta.get("optimize_steps", 0) or 0),
            tags=list(meta.get("tags", []) or []),
            description=str(meta.get("description", "") or ""),
            concept_type=str(meta.get("concept_type", "generic") or "generic"),
            config=config if isinstance(config, dict) else {},
            sample_rate=int(meta.get("sample_rate", 32000) or 32000),
            subject_name=str(meta.get("subject_name", "") or ""),
            appearance=str(meta.get("appearance", "") or ""),
            voice_description=str(meta.get("voice_description", "") or ""),
            path=path_no_ext,
        )


# ---------------------------------------------------------------- cache

_CACHE: Dict[str, H3RefMod] = {}
_STAMPS: Dict[str, tuple] = {}
_CACHE_MAX = 24
_CACHE_BYTES = 256 << 20


def _stamp(path_no_ext):
    out = [os.path.normcase(os.path.abspath(path_no_ext))]
    for ext in (".safetensors", ".json"):
        try:
            st = os.stat(path_no_ext + ext)
            out.append((st.st_size, st.st_mtime_ns))
        except OSError:
            out.append(None)
    return tuple(out)


def load_cached(path_no_ext: str, member=None) -> H3RefMod:
    """Load once per file version; a rewritten file is picked up by stamp."""
    key = os.path.normcase(os.path.abspath(path_no_ext)) + (f"#{member}" if member is not None else "")
    if key in _CACHE and _STAMPS.get(key) == _stamp(path_no_ext):
        return _CACHE[key]
    mod = H3RefMod.load(path_no_ext, device="cpu", member=member)
    _CACHE[key] = mod
    _STAMPS[key] = _stamp(path_no_ext)
    while _CACHE and (len(_CACHE) > _CACHE_MAX or sum(
            m.latent.numel() * m.latent.element_size() for m in _CACHE.values()) > _CACHE_BYTES):
        evicted = next(iter(_CACHE))
        _CACHE.pop(evicted)
        _STAMPS.pop(evicted, None)
    return mod


# ---------------------------------------------------------- bundle guard

def check_bundle(mods, where: str):
    """A bundle is a list of (mod, strength). Both packs share the link
    type, so say plainly when something else arrives instead of failing
    deep inside with an attribute error."""
    if mods is None:
        return []
    if not isinstance(mods, (list, tuple)):
        raise ValueError(f"{where}: 'mods' is not a RefMod bundle.")
    out = []
    for i, entry in enumerate(mods):
        try:
            mod, strength = entry
        except (TypeError, ValueError):
            raise ValueError(f"{where}: bundle entry {i + 1} is not a (mod, strength) pair.")
        for attr in ("kind", "name", "token_count", "ref_block"):
            if not hasattr(mod, attr):
                raise ValueError(
                    f"{where}: bundle entry {i + 1} ({type(mod).__name__}) has no "
                    f"'{attr}'. It came from a pack this node doesn't understand.")
        try:
            strength = float(strength)
        except (TypeError, ValueError):
            raise ValueError(f"{where}: bundle entry {i + 1} has a non-numeric strength.")
        if not math.isfinite(strength) or not 0.0 <= strength <= 1.0:
            raise ValueError(f"{where}: RefMod strength must be between 0 and 1 (entry {i + 1}).")
        out.append((mod, strength))
    return out
