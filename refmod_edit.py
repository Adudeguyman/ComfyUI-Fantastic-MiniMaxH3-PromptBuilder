"""Edit a saved RefMod without re-encoding what it already holds.

A RefMod's frames were each encoded on their own, so they can be dropped
or reordered exactly, and a new picture can be encoded to the same shape
and grid and appended — nothing stored is ever decoded and re-encoded (a
Compressed frame decodes to a blur; round-tripping it would degrade the
file). The voice half can be replaced or removed on its own.
"""

import json
import os
import shutil
from dataclasses import replace

import torch

import comfy.utils
import comfy.model_management as mm

from .refmod_core import H3RefMod, load_cached
from .refmod_create import (_cover, ensure_min_size, resize_ref, pool_latent, optimize_latent,
                            encode_audio, save_mod, snap_to_causal_grid, parse_sources,
                            load_look, load_voice)
from .refmods import (resolve_file, _split_pair, _root_of, _contained_target, sanitize_name,
                      valid_rel, split_member, read_meta, PREVIEW_EXT)


def _first_source_px(mod):
    """Short edge the original sources were scaled to, read back from the
    first entry of source_shape ('1x24x20 +…' latent dims, x16 px)."""
    try:
        first = str(mod.source_shape or "").split("+")[0].strip()
        _t, h, w = (int(v) for v in first.split("x"))
        return max(256, min(h, w) * 16)
    except Exception:
        return 1024


def encode_like(vae, mod, sources, latent_frames=16, progress=None):
    """Encode pictures/clips to match `mod`'s stored latent: same H x W, same
    mode, same refinement. Returns [1, 24, T_new, H, W] fp16 and the shapes."""
    H, W = mod.latent_h, mod.latent_w
    full = mod.mode == "encode"
    steps = int(mod.optimize_steps or 0)
    res = _first_source_px(mod)
    parts, shapes = [], []
    for i, (src, is_video) in enumerate(sources):
        src = src if is_video else src[:1]
        if full and is_video and latent_frames < src.shape[0]:
            idx = torch.linspace(0, src.shape[0] - 1, latent_frames).round().long()
            src = src[idx]
        if full:
            src = _cover(src, W * 16, H * 16)          # exact canvas: latent H x W
        else:
            src = resize_ref(src, res)
        src = ensure_min_size(src)
        if is_video and src.shape[0] > 1:
            src = src[:snap_to_causal_grid(src.shape[0])]
        mm.throw_exception_if_processing_interrupted()
        z = vae.encode(src)
        if z.dim() != 5 or z.shape[1] != 24:
            raise ValueError("The connected VAE is not the H3 video VAE.")
        shapes.append(f"{z.shape[2]}x{z.shape[3]}x{z.shape[4]}")
        if full:
            if (z.shape[3], z.shape[4]) != (H, W):
                raise ValueError(f"New frame encoded to {z.shape[3]}x{z.shape[4]}, but the file holds {H}x{W}.")
            part = z.to(torch.float16)
        else:
            part = pool_latent(z, min(latent_frames, z.shape[2]) if is_video else 1, H, W).to(torch.float16)
            if steps > 0:
                part = optimize_latent(part, z.float(), steps=steps,
                    progress=(lambda k, m, i=i: progress((i + k / m) / len(sources))) if progress else None)
        parts.append(part.cpu())
        if progress:
            progress((i + 1) / len(sources))
    return torch.cat(parts, dim=2).contiguous(), shapes


class MiniMaxH3FantasticRefModEdit:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Edit a saved RefMod: keep, drop or reorder its stored frames ('frames' "
        "is a JSON list of frame indices and \"a<k>\" entries in the new order), "
        "add pictures or clips encoded to the same shape ('add' is a JSON list "
        "of Media Loader items), and replace or remove its voice. Nothing "
        "already stored is re-encoded. Overwrites the file unless 'save_as' "
        "names a copy. Queued by the RefMod library's edit mode; the VAEs are "
        "only needed for additions."
    )
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved",)
    FUNCTION = "edit"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file": ("STRING", {"default": "", "tooltip": "The look's file under models/refmods, e.g. characters/hero_visual. May be a voice-only file when only the voice changes."}),
                "frames": ("STRING", {"default": "", "tooltip": "JSON list giving the new frame order: stored frame indices (0-based) and \"a0\", \"a1\"… for the items in 'add'. Empty = stored frames unchanged, additions appended."}),
                "add": ("STRING", {"default": "", "tooltip": "JSON list of Media Loader items (pictures/clips) to encode and add."}),
                "voice": ("STRING", {"default": "", "tooltip": "A Media Loader item (audio, or a clip with sound) to replace the voice; 'remove' to drop it; empty = unchanged."}),
                "latent_frames": ("INT", {"default": 16, "min": 1, "max": 1024, "tooltip": "Most latent frames an added clip contributes."}),
                "audio_max_seconds": ("FLOAT", {"default": 30.0, "min": 0.5, "max": 600.0, "step": 0.5}),
                "save_as": ("STRING", {"default": "", "tooltip": "Save the result as a new RefMod with this name (folders allowed, e.g. characters/hero_v2) and leave the original untouched. Empty = overwrite the original."}),
            },
            "optional": {
                "vae": ("VAE", {"tooltip": "MiniMax H3 video VAE, for added pictures."}),
                "audio_vae": ("VAE", {"tooltip": "MiniMax H3 audio VAE, for a new voice."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, file=""):
        if not (file or "").strip():
            return "Give the RefMod's file name."
        return True

    def edit(self, file, frames, add, voice, latent_frames, audio_max_seconds, save_as="", vae=None, audio_vae=None):
        audio_max_seconds = max(0.5, min(600.0, float(audio_max_seconds or 0) or 30.0))
        latent_frames = max(1, int(latent_frames or 16))
        rel = file.strip().replace("\\", "/")
        path = resolve_file(rel, (".safetensors",))
        if not path:
            raise FileNotFoundError(f"RefMod '{rel}' was not found under models/refmods.")
        stem = path[:-len(".safetensors")]
        root = _root_of(path)
        if root is None:
            raise ValueError("That file is outside every RefMod folder.")
        head, _t = read_meta(stem)
        if isinstance(head, dict) and head.get("kind") == "bundle":
            raise ValueError(
                f"'{split_member(rel)[0]}' is a single-file bundle from ComfyUI-MiniMaxH3Mod. "
                "It can be used and inspected here, but not edited: save its members as "
                "standalone files with that pack's Save H3 RefMods node first.")
        mod = load_cached(stem)
        root_dir, base_name = os.path.dirname(stem), os.path.basename(stem)
        pair_base, role = _split_pair(base_name)
        # The other half of a pair, when there is one.
        partner_stem = None
        if role:
            for suf in (("_audio", "_Audio") if role == "visual" else ("_visual", "_Video")):
                cand = os.path.join(root_dir, pair_base + suf)
                if os.path.isfile(cand + ".safetensors"):
                    partner_stem = cand
                    break
        look_mod = mod if mod.kind != "audio" else (load_cached(partner_stem) if partner_stem else None)
        look_stem = stem if mod.kind != "audio" else partner_stem
        voice_mod = mod if mod.kind == "audio" else (load_cached(partner_stem) if partner_stem else None)
        voice_stem = stem if mod.kind == "audio" else partner_stem
        saved = []
        pbar = comfy.utils.ProgressBar(100)

        # --- the look: stored frames by index, additions by "a<k>", in order
        edited = None
        if look_mod is not None:
            items = parse_sources(add)
            looks = [lk for lk in (load_look(it) for it in items) if lk is not None]
            order = None
            if frames and frames.strip():
                try:
                    raw = json.loads(frames)
                    order = [int(v) if not (isinstance(v, str) and v.startswith("a")) else v for v in raw]
                except Exception:
                    raise ValueError("'frames' must be a JSON list of frame indices and \"a<k>\" entries.")
                for v in order:
                    if isinstance(v, int) and not 0 <= v < look_mod.latent_t:
                        raise ValueError(f"'frames' names a frame outside 0–{look_mod.latent_t - 1}.")
                    if isinstance(v, str) and not (v[1:].isdigit() and int(v[1:]) < len(looks)):
                        raise ValueError(f"'frames' entry {v!r} has no matching item in 'add'.")
            if order is None:
                order = list(range(look_mod.latent_t)) + [f"a{k}" for k in range(len(looks))]
            used = sorted({int(v[1:]) for v in order if isinstance(v, str)})
            shapes = [s.strip() for s in str(look_mod.source_shape or "").split("+") if s.strip()]
            per_frame = len(shapes) == look_mod.latent_t
            new_parts, new_shapes = {}, {}
            if used:
                if vae is None:
                    raise ValueError("Connect the MiniMax H3 video VAE to 'vae' to add pictures.")
                enc, enc_shapes = encode_like(vae, look_mod, [looks[k] for k in used], latent_frames,
                                              progress=lambda f: pbar.update_absolute(int(60 * f)))
                # encode_like joins its sources along time; split them back apart
                t0 = 0
                for k, shp in zip(used, enc_shapes):
                    n = int(shp.split("x")[0])
                    new_parts[k] = enc[:, :, t0:t0 + n]
                    new_shapes[k] = shp
                    t0 += n
            parts, out_shapes = [], []
            for v in order:
                if isinstance(v, int):
                    parts.append(look_mod.latent[:, :, v:v + 1])
                    out_shapes.append(shapes[v] if per_frame else None)
                else:
                    parts.append(new_parts[int(v[1:])])
                    out_shapes.append(new_shapes[int(v[1:])])
            if not parts:
                raise ValueError("That would leave no frames. Delete the RefMod instead.")
            latent = torch.cat(parts, dim=2).contiguous()
            kept = sum(1 for v in order if isinstance(v, int))
            if per_frame:
                shapes = [s for s in out_shapes if s]
            else:
                # source_shape wasn't one per frame (a clip): say what remains
                shapes = ([f"{kept}x" + "x".join(shapes[0].split("x")[1:])] if shapes and kept else []) + [s for s in out_shapes if s]
            unchanged = not used and order == list(range(look_mod.latent_t))
            if not unchanged:
                edited = H3RefMod(
                    name=look_mod.name, kind="video" if latent.shape[2] > 1 else "image", latent=latent,
                    latent_h=look_mod.latent_h, latent_w=look_mod.latent_w, latent_t=latent.shape[2],
                    mode=look_mod.mode, source="stack" if latent.shape[2] > 1 else look_mod.source,
                    source_shape=" +".join(s.strip() for s in shapes),
                    pool=(f"{latent.shape[2]}x{look_mod.latent_h}x{look_mod.latent_w}" if look_mod.mode != "encode" else ""),
                    optimize_steps=look_mod.optimize_steps, tags=[f"{latent.shape[2]} frame{'s' if latent.shape[2] != 1 else ''}"],
                    description=look_mod.description, concept_type=look_mod.concept_type, config=look_mod.config)
                print(f"[MiniMaxH3FantasticRefModEdit] {rel}: {look_mod.latent_t} -> {latent.shape[2]} frames"
                      + (f" ({len(used)} added)" if used else ""))
        pbar.update_absolute(70)

        # --- the voice: a new one, or none
        v = (voice or "").strip()
        vmod, remove_voice = None, v == "remove"
        if v and not remove_voice:
            items = parse_sources(v)
            clip = next((c for c in (load_voice(it) for it in items) if c is not None), None)
            if clip is None:
                raise ValueError("'voice' has no usable audio.")
            if audio_vae is None:
                raise ValueError("Connect the MiniMax H3 audio VAE to 'audio_vae' to set a voice.")
            alat = encode_audio(audio_vae, clip, max_seconds=audio_max_seconds)
            src = look_mod or mod
            vmod = H3RefMod(
                name=src.name, kind="audio", latent=alat, mode="encode", source="audio",
                source_shape=f"audio:{alat.shape[-1]}", pool=f"{alat.shape[-1]} audio",
                tags=[f"{alat.shape[-1] / 40:.1f}s audio"], description=src.description,
                concept_type=src.concept_type if src.concept_type in ("voice", "singing", "music_style", "sound_fx", "ambience") else "voice",
                sample_rate=32000)
        pbar.update_absolute(90)

        target = sanitize_name(save_as, folder=True) if (save_as or "").strip() else ""
        if target:
            # --- a copy under a new name: the original is left alone
            if not valid_rel(target):
                raise ValueError("That name is not allowed.")
            base = os.path.basename(target)
            out_look = edited or look_mod
            out_voice = None if remove_voice else (vmod or voice_mod)
            if out_look is None and out_voice is None:
                raise ValueError("Nothing to save.")
            dest = _contained_target(root, target)
            look_dest = dest + ("_visual" if (out_look is not None and out_voice is not None) else "")
            voice_dest = dest + "_audio"
            for d in ([look_dest] if out_look is not None else []) + ([voice_dest] if out_voice is not None else []):
                if os.path.exists(d + ".safetensors"):
                    raise FileExistsError(f"'{os.path.relpath(d, root)}' already exists — pick another name.")
            os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
            if out_look is not None:
                out_look = replace(out_look, name=base)
                saved.append(save_mod(out_look, look_dest))
            if out_voice is not None:
                out_voice = replace(out_voice, name=base)
                saved.append(save_mod(out_voice, voice_dest))
            # the preview image travels with the copy
            for pv in (pair_base, base_name):
                for ext in PREVIEW_EXT:
                    src_pv = os.path.join(root_dir, pv + ext)
                    if os.path.isfile(src_pv):
                        shutil.copyfile(src_pv, dest + ext)
                        break
                else:
                    continue
                break
            print(f"[MiniMaxH3FantasticRefModEdit] {rel}: saved a copy as {target}")
        else:
            # --- in place
            if edited is not None:
                saved.append(save_mod(edited, look_stem))
            if v:
                if voice_stem is None and look_stem is not None:
                    # A plain <name> file gets the pair suffix once it has a voice.
                    if role == "visual":
                        voice_stem = os.path.join(root_dir, pair_base + ("_audio" if base_name.endswith("_visual") else "_Audio"))
                    else:
                        new_look = os.path.join(root_dir, base_name + "_visual")
                        voice_stem = os.path.join(root_dir, base_name + "_audio")
                        if not remove_voice:
                            for ext in (".safetensors", ".json"):
                                if os.path.isfile(look_stem + ext):
                                    os.replace(look_stem + ext, new_look + ext)
                            print(f"[MiniMaxH3FantasticRefModEdit] {rel}: renamed to {os.path.basename(new_look)} to pair with its voice")
                if remove_voice:
                    if voice_stem:
                        for ext in (".safetensors", ".json"):
                            if os.path.isfile(voice_stem + ext):
                                os.remove(voice_stem + ext)
                                saved.append(f"removed {os.path.basename(voice_stem)}{ext}")
                else:
                    saved.append(save_mod(vmod, voice_stem))
        pbar.update_absolute(100)
        rel_saved = [os.path.relpath(os.path.realpath(p), os.path.realpath(root)).replace("\\", "/")
                     if os.path.isabs(p) else p for p in saved]
        print(f"[MiniMaxH3FantasticRefModEdit] saved " + ", ".join(rel_saved))
        return {"ui": {"refmod_saved": rel_saved}, "result": ("\n".join(rel_saved),)}


NODE_CLASS_MAPPINGS = {"MiniMaxH3FantasticRefModEdit": MiniMaxH3FantasticRefModEdit}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3FantasticRefModEdit": "Fantastic H3 Edit RefMod"}
