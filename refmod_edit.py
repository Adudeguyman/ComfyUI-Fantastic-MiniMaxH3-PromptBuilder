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
import torch.nn.functional as F

import comfy.utils
import comfy.model_management as mm

from .object_mask import drop_subject_masks, subject_mask
from .refmod_core import H3RefMod, load_cached, encoder_record, stored_record, blur_latent_outside
from .refmod_create import (_cover, ensure_min_size, resize_ref, pool_latent, optimize_latent,
                            encode_audio, save_mod, snap_to_h3_grid, parse_sources,
                            load_look, load_voice, blur_subject, subject_record, _trim)
from .refmods import (resolve_file, _split_pair, _root_of, _contained_target, name_taken, sanitize_name,
                      valid_rel, split_member, read_meta, clean_subject_name, clean_description, rewrite_stem_meta,
                      bundle_members, PREVIEW_EXT)
from .video_edit import grow_mask


def _first_source_px(mod):
    """Short edge the original sources were scaled to, read back from the
    first entry of source_shape ('1x24x20 +…' latent dims, x16 px)."""
    try:
        first = str(mod.source_shape or "").split("+")[0].strip()
        _t, h, w = (int(v) for v in first.split("x"))
        return max(256, min(h, w) * 16)
    except Exception:
        return 1024


def _first_source_canvas(mod):
    """The first source's own encode canvas in pixels, (w, h), from
    source_shape; None when the header doesn't say. Compressed files pool
    each source to one grid, so an added picture is cover-cropped to this
    canvas first — trimmed to the file's shape, never squeezed into it."""
    try:
        first = str(mod.source_shape or "").split("+")[0].strip()
        _t, h, w = (int(v) for v in first.split("x"))
        return (w * 16, h * 16) if h > 0 and w > 0 else None
    except Exception:
        return None


def encode_like(vae, mod, sources, latent_frames=16, progress=None, items=None):
    """Encode pictures/clips to match `mod`'s stored latent: same H x W, same
    mode, same refinement. `items` are the Media Loader items they came from,
    for the Create tab's subject blur. Returns [1, 24, T_new, H, W] fp16 and
    the shapes."""
    H, W = mod.latent_h, mod.latent_w
    full = mod.mode == "encode"
    steps = int(mod.optimize_steps or 0)
    res = _first_source_px(mod)
    canvas = (W * 16, H * 16) if full else _first_source_canvas(mod)    # full: exactly latent H x W
    parts, shapes = [], []
    for i, (src, is_video) in enumerate(sources):
        src = src if is_video else src[:1]
        if is_video:
            src = src[:snap_to_h3_grid(min(latent_frames, src.shape[0]))]
        # the file's frame shape, edges trimmed
        src = ensure_min_size(_cover(src, *canvas) if canvas else resize_ref(src, res))
        if items:
            src = blur_subject(src, items[i], canvas)
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
            part = pool_latent(z, z.shape[2] if is_video else 1, H, W).to(torch.float16)
            if steps > 0:
                part = optimize_latent(part, z.float(), steps=steps,
                    progress=(lambda k, m, i=i: progress((i + k / m) / len(sources))) if progress else None)
        parts.append(part.cpu())
        if progress:
            progress((i + 1) / len(sources))
    return torch.cat(parts, dim=2).contiguous(), shapes


def stored_keep(entry, grow, lat_h, lat_w):
    """A stored frame's subject (its SAM mask and brush strokes, drawn on the
    decoded frame) as the share of each latent cell it covers, after widening
    it by `grow` pixels of the frame as it was encoded (lat_w x 16 wide).
    Returns [lat_h, lat_w]."""
    m = subject_mask(entry, 1, size=(lat_w * 16, lat_h * 16))
    px = round(grow * m.shape[-1] / (lat_w * 16))
    if px > 0:
        m = grow_mask(m, px)
    return F.adaptive_avg_pool2d(m[:, None].float(), (lat_h, lat_w))[0, 0]


# Header fields the prompt builder reads, and how each one is checked.
PROMPT_FIELDS = (("subject_name", clean_subject_name),
                 ("appearance", lambda v: clean_description(v, "appearance")),
                 ("voice_description", lambda v: clean_description(v, "voice description")),
                 ("retained_attributes", lambda v: clean_description(v, "retained attributes")))


def _changes(subject_name="", appearance="", voice_description="", retained_attributes=""):
    """The header fields to change: empty keeps a field, '-' clears it."""
    out = {}
    for (key, clean), raw in zip(PROMPT_FIELDS, (subject_name, appearance, voice_description, retained_attributes)):
        text = (raw or "").strip()
        if text:
            out[key] = "" if text == "-" else clean(text)
    return out


class MiniMaxH3FantasticRefModEdit:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Edit a saved RefMod: keep, drop or reorder its stored frames ('frames' "
        "is a JSON list of frame indices and \"a<k>\" entries in the new order), "
        "add pictures or clips encoded to the same shape ('add' is a JSON list "
        "of Media Loader items), replace or remove its voice, and set its "
        "subject name, appearance, voice description and retained attributes. Nothing already stored is re-encoded. Overwrites the file unless 'save_as' "
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
                "latent_frames": ("INT", {"default": 22, "min": 1, "max": 1024, "tooltip": "Frames taken from the start of an added clip; 22 stores 7 frames, 39 stores 12, 56 stores 17."}),
                "audio_max_seconds": ("FLOAT", {"default": 30.0, "min": 0.5, "max": 600.0, "step": 0.5}),
                "save_as": ("STRING", {"default": "", "tooltip": "Save the result as a new RefMod with this name (folders allowed, e.g. characters/hero_v2) and leave the original untouched. Empty = overwrite the original, except for a ComfyUI-MiniMaxH3Mod bundle, which is always saved as a copy."}),
            },
            "optional": {
                "vae": ("VAE", {"tooltip": "MiniMax H3 video VAE, for added pictures."}),
                "audio_vae": ("VAE", {"tooltip": "MiniMax H3 audio VAE, for a new voice."}),
                "subject_name": ("STRING", {"default": "", "tooltip": "One-word name used in prompts, saved inside the file "
                                            "(the Prompt Builder's Draft from RefMods names the subject this). "
                                            "Empty keeps the stored name; '-' clears it."}),
                "appearance": ("STRING", {"default": "", "tooltip": "How the subject looks, drafted into their definition line. "
                                          "Empty keeps the stored text; '-' clears it."}),
                "voice_description": ("STRING", {"default": "", "tooltip": "How the voice sounds, drafted onto the voice line and "
                                                 "the speaker buttons. Empty keeps the stored text; '-' clears it."}),
                "retained_attributes": ("STRING", {"default": "", "tooltip": "Specific small details that should be kept, drafted "
                                                   "onto the end of the subject's retention note. Empty keeps the stored text; "
                                                   "'-' clears it."}),
                "stored_blur": ("STRING", {"default": "", "tooltip": "Full RefMods: blur the background of stored frames, "
                    "as JSON {\"background\": 0-1, \"grow\": pixels, \"word\": ..., \"masks\": {frame index: {\"mask\", "
                    "\"strokes\", \"background\", \"grow\"}}}; the top-level values are Batch Masking's, for the record. "
                    "The frames stay their size; background 0 blurs everything outside the subject."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, file="", subject_name="", appearance="", voice_description="", retained_attributes=""):
        if not (file or "").strip():
            return "Give the RefMod's file name."
        try:
            _changes(subject_name, appearance, voice_description, retained_attributes)
        except ValueError as exc:
            return str(exc)
        return True

    def edit(self, file, frames, add, voice, latent_frames, audio_max_seconds, save_as="", vae=None, audio_vae=None,
             subject_name="", appearance="", voice_description="", retained_attributes="", stored_blur=""):
        # Header fields: empty keeps what's stored, '-' clears, anything else sets it.
        changes = _changes(subject_name, appearance, voice_description, retained_attributes)
        blur = json.loads(stored_blur) if stored_blur.strip() else {}
        blur_masks = {int(k): v for k, v in (blur.get("masks") or {}).items() if v}
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
        root_dir, base_name = os.path.dirname(stem), os.path.basename(stem)
        members = bundle_members(head)
        if members:
            # A ComfyUI-MiniMaxH3Mod bundle: its first look and first voice, as its
            # library card shows them. The bundle stays as that pack wrote it.
            if not (save_as or "").strip():
                raise ValueError(f"'{split_member(rel)[0]}' is a single-file bundle from ComfyUI-MiniMaxH3Mod, "
                                 "so an edit is saved as a copy: give save_as a name.")
            look_i = next((i for i, m in enumerate(members) if m.get("kind") != "audio"), None)
            voice_i = next((i for i, m in enumerate(members) if m.get("kind") == "audio"), None)
            look_mod = load_cached(stem, look_i) if look_i is not None else None
            voice_mod = load_cached(stem, voice_i) if voice_i is not None else None
            mod, pair_base, role = look_mod or voice_mod, base_name, None
            look_stem = voice_stem = None
        else:
            mod = load_cached(stem)
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
        edited, look_items = None, []
        if look_mod is not None:
            loaded = [(it, load_look(it)) for it in parse_sources(add)]
            looks = [lk for _it, lk in loaded if lk is not None]
            look_items = [it for it, lk in loaded if lk is not None]
            if blur_masks and look_mod.mode != "encode":
                raise ValueError("Blurring the background of stored frames needs a Full RefMod; a Compressed one "
                                 "holds too little detail to mask.")
            background = min(1.0, max(0.0, float(blur.get("background") or 0.0)))
            grow = int(blur.get("grow") or 0)
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
                                              progress=lambda f: pbar.update_absolute(int(60 * f)),
                                              items=[look_items[k] for k in used])
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
                    frame = look_mod.latent[:, :, v:v + 1]
                    if v in blur_masks:
                        e = blur_masks[v]
                        keep = stored_keep(e, int(e.get("grow") or 0), look_mod.latent_h, look_mod.latent_w)
                        frame = blur_latent_outside(frame, keep[None], min(1.0, max(0.0, float(e.get("background") or 0.0))))
                    parts.append(frame)
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
            unchanged = not used and not blur_masks and order == list(range(look_mod.latent_t))
            if not unchanged:
                spec = next((look_items[k]["subject"] for k in used if isinstance(look_items[k].get("subject"), dict)), None)
                record = {**look_mod.subject_blur, **(subject_record(spec) if spec else {})}
                if blur_masks:
                    record.update(subject_record({"word": blur.get("word") or "", "grow": grow}),
                                  background=round(background, 2))
                edited = H3RefMod(
                    name=look_mod.name, kind="video" if latent.shape[2] > 1 else "image", latent=latent,
                    latent_h=look_mod.latent_h, latent_w=look_mod.latent_w, latent_t=latent.shape[2],
                    mode=look_mod.mode, source="stack" if latent.shape[2] > 1 else look_mod.source,
                    source_shape=" +".join(s.strip() for s in shapes),
                    pool=(f"{latent.shape[2]}x{look_mod.latent_h}x{look_mod.latent_w}" if look_mod.mode != "encode" else ""),
                    optimize_steps=look_mod.optimize_steps, tags=[f"{latent.shape[2]} frame{'s' if latent.shape[2] != 1 else ''}"],
                    description=look_mod.description, concept_type=look_mod.concept_type, config=look_mod.config,
                    subject_blur=record, **{**{k: getattr(look_mod, k) for k, _c in PROMPT_FIELDS}, **changes})
                print(f"[MiniMaxH3FantasticRefModEdit] {rel}: {look_mod.latent_t} -> {latent.shape[2]} frames"
                      + (f" ({len(used)} added)" if used else "")
                      + (f", background blurred on {len(blur_masks)} stored" if blur_masks else ""))
        pbar.update_absolute(70)

        # --- the voice: a new one, or none
        v = (voice or "").strip()
        vmod, remove_voice = None, v == "remove"
        if v and not remove_voice:
            found = next(((it, c) for it, c in ((it, load_voice(it)) for it in parse_sources(v)) if c is not None), None)
            if found is None:
                raise ValueError("'voice' has no usable audio.")
            if audio_vae is None:
                raise ValueError("Connect the MiniMax H3 audio VAE to 'audio_vae' to set a voice.")
            item, clip = found
            # a trimmed voice keeps its whole trim; Voice seconds limits the others
            alat = encode_audio(audio_vae, clip, max_seconds=None if any(_trim(item)) else audio_max_seconds)
            src = look_mod or mod
            vmod = H3RefMod(
                name=src.name, kind="audio", latent=alat, mode="encode", source="audio",
                source_shape=f"audio:{alat.shape[-1]}", pool=f"{alat.shape[-1]} audio",
                tags=[f"{alat.shape[-1] / 40:.1f}s audio"], description=src.description,
                concept_type=src.concept_type if src.concept_type in ("voice", "singing", "music_style", "sound_fx", "ambience") else "voice",
                sample_rate=32000,
                **{**{k: getattr(src, k) or (getattr(voice_mod, k) if voice_mod else "") for k, _c in PROMPT_FIELDS},
                   **changes})
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
            if name_taken(target):
                raise FileExistsError(f"A RefMod named '{target}' already exists — pick another name.")
            os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
            if out_look is not None:
                out_look = replace(out_look, name=base, **changes)
                # changed frames are shown to the encoder anew (without a VAE the Text
                # Encode decodes them once later); an unchanged look keeps its own
                frames = (encoder_record(out_look, vae) if vae is not None else None) if edited is not None \
                    else stored_record(out_look)
                saved.append(save_mod(out_look, look_dest, frames))
            if out_voice is not None:
                out_voice = replace(out_voice, name=base, **changes)
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
            final_look = look_stem
            if edited is not None:
                saved.append(save_mod(edited, look_stem, encoder_record(edited, vae) if vae is not None else None))
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
                            final_look = new_look
                            print(f"[MiniMaxH3FantasticRefModEdit] {rel}: renamed to {os.path.basename(new_look)} to pair with its voice")
                if remove_voice:
                    if voice_stem:
                        for ext in (".safetensors", ".json"):
                            if os.path.isfile(voice_stem + ext):
                                os.remove(voice_stem + ext)
                                saved.append(f"removed {os.path.basename(voice_stem)}{ext}")
                else:
                    saved.append(save_mod(vmod, voice_stem))
            if changes:
                # Halves not rewritten above get the changed fields in their
                # header only; their tensors are copied as they are.
                for half_stem, written, half in ((final_look, edited is not None, look_mod),
                                                 (None if remove_voice else voice_stem, bool(v), voice_mod)):
                    if (half_stem and not written and half is not None
                            and any(getattr(half, k) != val for k, val in changes.items())
                            and os.path.isfile(half_stem + ".safetensors")):
                        rewrite_stem_meta(half_stem, **changes)
                        saved.append(half_stem + ".safetensors")
                        print(f"[MiniMaxH3FantasticRefModEdit] {os.path.basename(half_stem)}: updated "
                              + ", ".join(k.replace("_", " ") for k in changes))
        drop_subject_masks([*(e.get("mask") for e in blur_masks.values()),
                            *(it["subject"].get("mask") for it in look_items if isinstance(it.get("subject"), dict))])
        pbar.update_absolute(100)
        rel_saved = [os.path.relpath(os.path.realpath(p), os.path.realpath(root)).replace("\\", "/")
                     if os.path.isabs(p) else p for p in saved]
        print(f"[MiniMaxH3FantasticRefModEdit] saved " + ", ".join(rel_saved))
        return {"ui": {"refmod_saved": rel_saved}, "result": ("\n".join(rel_saved),)}


class MiniMaxH3FantasticRefModStoreFrames:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Add the frames H3's text encoder is shown to RefMods saved before they "
        "carried them, so the RefMod Text Encode reads them instead of decoding "
        "the RefMod. Each file is decoded once; its latent is not touched. Files "
        "that already have them and voice files are left alone. Queued by the "
        "RefMod library's Store encoder frames."
    )
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    FUNCTION = "store"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "files": ("STRING", {"default": "", "multiline": True, "tooltip": "RefMod files under models/refmods, one per line, e.g. characters/hero_visual."}),
                "vae": ("VAE", {"tooltip": "MiniMax H3 video VAE."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def store(self, files, vae):
        rels = [r.strip().replace("\\", "/") for r in files.splitlines() if r.strip()]
        pbar = comfy.utils.ProgressBar(len(rels))
        saved = []
        for i, rel in enumerate(rels):
            mm.throw_exception_if_processing_interrupted()
            path = resolve_file(rel, (".safetensors",))
            if not path:
                raise FileNotFoundError(f"RefMod '{rel}' was not found under models/refmods.")
            stem = path[:-len(".safetensors")]
            mod = load_cached(stem)
            if mod.kind != "audio" and not mod.enc_times:
                packed, times, fps = encoder_record(mod, vae)
                made = os.stat(path)
                rewrite_stem_meta(stem, rel, add=packed, enc_times=times, enc_fps=fps)
                # the library's Newest sort still means when the RefMod was made
                os.utime(path, ns=(made.st_atime_ns, made.st_mtime_ns))
                saved.append(rel)
            pbar.update_absolute(i + 1)
        print(f"[MiniMaxH3FantasticRefModStoreFrames] stored encoder frames in {len(saved)} of {len(rels)} files")
        return {"ui": {"refmod_saved": saved}}


NODE_CLASS_MAPPINGS = {"MiniMaxH3FantasticRefModEdit": MiniMaxH3FantasticRefModEdit,
                       "MiniMaxH3FantasticRefModStoreFrames": MiniMaxH3FantasticRefModStoreFrames}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3FantasticRefModEdit": "Fantastic H3 Edit RefMod",
                              "MiniMaxH3FantasticRefModStoreFrames": "Fantastic H3 Store RefMod Encoder Frames"}
