"""Saved latents for work that doesn't change between runs.

The Text Encode runs again whenever the prompt changes, and building an edit
(decode, resize, mask, VAE encode) or encoding a cited reference clip costs
far more than the prompt itself. Each result is saved once under a key made
of everything that decides it — the source file (by name, size and time),
the trim, crop, mirror and size settings, the mask and its settings, the
sampling size, and which VAE encoded it — and loaded on every later run.
Change any of those and it is built again; change only the prompt, seed or
sampler and it loads in a moment.

Files live in input/minimax_h3/cache. Nothing here deletes them; the Media
Loader's Clean up lists them.
"""

import hashlib
import json
import os

import torch

import folder_paths

from . import media_io

SUBFOLDER = "minimax_h3/cache"

_vae_tags = {}


def folder():
    path = os.path.join(folder_paths.get_input_directory(), SUBFOLDER)
    os.makedirs(path, exist_ok=True)
    return path


def vae_tag(vae):
    """Which VAE this is, so latents from the int8 and fp16 video VAEs (which
    differ slightly) never stand in for each other."""
    if vae is None:
        return None
    model = vae.first_stage_model
    tag = _vae_tags.get(id(model))
    if tag is None:
        parts = [type(model).__name__]
        for name, t in model.state_dict().items():
            if torch.is_tensor(t) and t.numel():
                sample = t.reshape(-1)[:4096].float()
                parts.append(f"{name}:{tuple(t.shape)}:{t.dtype}:{float(sample.sum()):.6g}")
                break
        tag = "|".join(parts)
        _vae_tags[id(model)] = tag
    return tag


def file_stamp(annotated):
    """A file as its name, size and modification time: a changed file is a new key."""
    path = media_io.resolve(annotated)
    st = os.stat(path)
    return [os.path.basename(path), st.st_size, int(st.st_mtime)]


def path_for(kind, key):
    digest = hashlib.sha1(json.dumps(key, sort_keys=True, default=str).encode()).hexdigest()[:24]
    return os.path.join(folder(), f"{kind}_{digest}.safetensors")


def load(path):
    """Tensors saved at `path`, or None when there is no such cache yet."""
    if not os.path.exists(path):
        return None
    from safetensors.torch import load_file
    try:
        return load_file(path)
    except Exception as exc:          # a half-written or foreign file: build it again
        print(f"[MiniMaxH3 cache] ignoring unreadable {os.path.basename(path)} ({exc})")
        return None


def save(path, tensors):
    from safetensors.torch import save_file
    try:
        save_file({k: v.detach().cpu().contiguous() for k, v in tensors.items() if v is not None}, path)
    except OSError as exc:
        print(f"[MiniMaxH3 cache] couldn't save {os.path.basename(path)} ({exc}); it will be built again next run")
