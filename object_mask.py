"""Object Mask: find something in a Media Loader clip with SAM 3.1 and save
its mask next to the clip, so that area can be regenerated: replaced,
changed or removed.

The Media Loader's Mask for editing panel queues this node on its own, the way
the RefMod library queues Create — nothing on the canvas runs. It uses core
ComfyUI's SAM 3 nodes and nothing else: the checkpoint is whatever the user
put in models/checkpoints; this pack never downloads one.

Dots can go on several frames. Each marked frame is segmented from its own
dots (and the typed name, which picks the match under them) and tracked
forward to the next marked frame; the first is also tracked back to the
start, since core's tracker only starts from a first-frame mask. So a mask
that drifts is fixed by adding a dot where it goes wrong. With a name only,
the tracker looks for it on every frame. A run can replace the clip's mask,
add to it or subtract from it, and brush strokes edit a saved mask directly.

Masks are stored one bit per pixel (np.packbits along the width); older
one-byte masks still read.

The editor's mask mode passes its trim. Only the trimmed span is decoded and
masked; the mask is stored against the source frame (no crop, no mirror) with
the frame it starts at, and the loader applies the item's crop and mirror
when it sends the clip, so a later reframe still lines up. A small sprite of
it is saved alongside for the editor's and the loader card's overlay.
"""

import json
import math
import os
import uuid

import numpy as np
import torch
import torch.nn.functional as F

import folder_paths

from . import media_io

SUBFOLDER = "minimax_h3/masks"
DECODE_CAP = 1008          # SAM 3 works at 1008 px; decoding larger only costs memory
SPRITE_W = 320             # the overlay the editor and loader card draw: one small tile per frame
SPRITE_MAX = 600           # longer masks keep every Nth frame


def _stem(annotated):
    name = os.path.basename(str(annotated).split(" [")[0])
    stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in os.path.splitext(name)[0])
    return stem[:60] or "clip"


def _pixels(spec, width, height):
    """Normalised {"x", "y"} points -> [(x, y)] pixel positions."""
    return [(round(float(p["x"]) * (width - 1)), round(float(p["y"]) * (height - 1)))
            for p in spec or [] if isinstance(p, dict) and "x" in p and "y" in p]


def _points(pixels):
    """Pixel positions -> core's point-prompt JSON."""
    return json.dumps([{"x": x, "y": y} for x, y in pixels]) if pixels else None


def _clicked(found, pos, neg):
    """The text detections the clicks pick out: those under a green dot and
    under no red one, joined. None when the clicks miss every detection."""
    hits = [m for m in found if any(m[y, x] > 0 for x, y in pos) and not any(m[y, x] > 0 for x, y in neg)]
    return (torch.stack(hits).amax(dim=0) > 0).float()[None] if hits else None


def _track(sam3, model, frames, **kw):
    track = sam3.SAM3_VideoTrack.execute(images=frames, model=model, **kw).result[0]
    return sam3.SAM3_TrackToMask.execute(track_data=track, object_indices="").result[0]


def _save_sprite(masks, folder, stem):
    """The mask as one small PNG of tiles, one per frame, white with the mask
    as alpha. The editor and the loader card draw the tile for the frame on
    screen, so the overlay follows scrubbing exactly. Returns its layout."""
    from PIL import Image
    n, h, w = masks.shape
    tw, th = SPRITE_W, max(1, round(h * SPRITE_W / w))
    step = -(-n // SPRITE_MAX)
    picks = masks[::step].float()
    cols = max(1, int(np.ceil(np.sqrt(picks.shape[0]))))
    rows = -(-picks.shape[0] // cols)
    # "area" keeps a thin edge visible at thumbnail size instead of dropping it
    small = (F.interpolate(picks[:, None], size=(th, tw), mode="area")[:, 0] > 0.2).to(torch.uint8) * 255
    alpha = np.zeros((rows * th, cols * tw), dtype=np.uint8)
    for i in range(small.shape[0]):
        r, c = divmod(i, cols)
        alpha[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = small[i].numpy()
    name = f"{stem}.png"
    Image.fromarray(np.stack([np.full_like(alpha, 255), alpha], axis=-1), "LA").save(
        os.path.join(folder, name), optimize=True)
    return {"file": f"{SUBFOLDER}/{name} [input]", "tw": tw, "th": th, "cols": cols,
            "count": int(small.shape[0]), "step": int(step)}


def _keyframes(spec, first, n, w, h):
    """[(frame, positive, negative)] from the panel's points, sorted, one per
    frame. Takes {"frames": [{time, positive, negative}, ...]} or the older
    single {time, positive, negative}. A frame needs a green dot to seed."""
    frames = spec.get("frames") if isinstance(spec.get("frames"), list) else [spec]
    keys = {}
    for f in frames:
        if not isinstance(f, dict):
            continue
        pos, neg = _pixels(f.get("positive"), w, h), _pixels(f.get("negative"), w, h)
        if pos:
            k = min(n - 1, max(0, round(float(f.get("time") or 0) * media_io.FPS) - first))
            keys[k] = (pos, neg)
    return [(k, *keys[k]) for k in sorted(keys)]


def _seed(sam3, model, cond, frame, pos, neg, threshold):
    """A mask on one frame from its dots: with a name, the matches under the
    green dots; otherwise SAM's own segment of the clicked point."""
    if cond is not None:
        # A click alone is ambiguous (a jacket, or the person wearing it).
        # With a name too, SAM finds every match and the clicks choose.
        found = sam3.SAM3_Detect.execute(model=model, image=frame, conditioning=cond, threshold=threshold,
                                         refine_iterations=2, individual_masks=True).result[0]
        seed = _clicked(found.cpu(), pos, neg)
        if seed is not None:
            return seed, True
    # One refine pass only: later passes see the mask without the clicks and
    # tend to grow it to the whole object.
    seed = sam3.SAM3_Detect.execute(model=model, image=frame, positive_coords=_points(pos),
                                    negative_coords=_points(neg), threshold=threshold,
                                    refine_iterations=1, individual_masks=False).result[0]
    return seed, False


def pack(masks):
    """bool [n, h, w] -> uint8 [n, h, ceil(w/8)], one bit per pixel."""
    return torch.from_numpy(np.packbits(masks.numpy().astype(np.uint8), axis=-1))


def read_mask(annotated):
    """(metadata, bool [n, h, w]) for a saved mask, packed or older one-byte."""
    from safetensors import safe_open
    path = media_io.resolve(annotated)
    if not os.path.isfile(path):
        raise ValueError(f"The clip's mask file is missing ({str(annotated).split(' [')[0]}). Mask the clip "
                         "again, or clear its mask in the Media Loader.")
    with safe_open(path, framework="pt") as fh:
        meta = fh.metadata() or {}
        stored = fh.get_tensor("mask")
    if meta.get("format") == "packed1":
        w = int(meta["width"])
        return meta, torch.from_numpy(np.unpackbits(stored.numpy(), axis=-1, count=w).astype(bool))
    return meta, stored > 0


def save_mask(masks, source, first, how):
    """Write bool [n, h, w] as a packed mask plus its overlay sprite; the info
    the panel keeps on the clip."""
    from safetensors.torch import save_file
    n, _h, w = masks.shape
    hit = int(masks.flatten(1).any(dim=1).sum())
    if not hit:
        raise ValueError("The mask is empty on every frame.")
    folder = os.path.join(folder_paths.get_input_directory(), SUBFOLDER)
    os.makedirs(folder, exist_ok=True)
    tag = f"{_stem(source)}_{uuid.uuid4().hex[:8]}"
    name = f"{tag}.safetensors"
    save_file({"mask": pack(masks).contiguous()}, os.path.join(folder, name),
              metadata={"format": "packed1", "width": str(w), "fps": str(media_io.FPS),
                        "start_frame": str(first), "source": os.path.basename(str(source).split(" [")[0])})
    sprite = _save_sprite(masks, folder, tag)
    sprite["start"] = first
    return {"file": f"{SUBFOLDER}/{name} [input]", "frames": n, "hit": hit,
            "share": round(float(masks.float().mean()), 4), "how": how, "sprite": sprite}


def _aligned(base, first, n, h, w):
    """A saved mask on this run's frames and size: frames it doesn't cover are empty."""
    meta, bm = read_mask(base)
    if tuple(bm.shape[1:]) != (h, w):
        bm = F.interpolate(bm[:, None].float(), size=(h, w), mode="nearest")[:, 0] > 0.5
    idx = torch.arange(first - int(meta.get("start_frame", 0)), first - int(meta.get("start_frame", 0)) + n)
    inside = (idx >= 0) & (idx < bm.shape[0])
    out = torch.zeros(n, h, w, dtype=torch.bool)
    out[inside] = bm[idx[inside]]
    return out


class MiniMaxH3FantasticObjectMask:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Used by the Media Loader's Mask for editing panel: finds an object or person in a loaded clip with SAM 3.1 (core "
        "ComfyUI's SAM 3 nodes) and saves its mask beside the clip. You don't need to place this node yourself."
    )
    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "SAM 3.1, from Load Checkpoint."}),
                "clip": ("CLIP", {"tooltip": "SAM 3.1's text encoder, from the same Load Checkpoint."}),
                "video": ("STRING", {"default": "", "tooltip": "A Media Loader file, e.g. minimax_h3/clip.mp4 [input]."}),
                "text": ("STRING", {"default": "", "tooltip": "What to find, e.g. phone. Commas for several."}),
                "points": ("STRING", {"default": "", "tooltip": "Clicked points as JSON: {\"frames\": [{\"time\": "
                    "seconds, \"positive\": [{\"x\", \"y\"}], \"negative\": [...]}]}, x and y from 0 to 1 on the source frame."}),
                "start": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 36000.0, "step": 0.001,
                    "tooltip": "Trim start in seconds: only the kept span is masked."}),
                "end": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 36000.0, "step": 0.001,
                    "tooltip": "Trim end in seconds; 0 is the end of the clip."}),
                "threshold": ("FLOAT", {"default": 0.5, "min": 0.05, "max": 0.95, "step": 0.05}),
                "max_objects": ("INT", {"default": 4, "min": 1, "max": 16}),
            },
            "optional": {
                "mode": (["replace", "add", "subtract"], {"default": "replace",
                    "tooltip": "What to do with the clip's current mask: replace it, add what's found to it, "
                               "or take what's found out of it."}),
                "base": ("STRING", {"default": "", "tooltip": "The clip's current mask file, for add and subtract."}),
            },
        }

    def run(self, model, clip, video, text, points, start=0.0, end=0.0, threshold=0.5, max_objects=4,
            mode="replace", base=""):
        try:
            import comfy_extras.nodes_sam3 as sam3
        except Exception as exc:
            raise RuntimeError("This ComfyUI has no SAM 3 support; update it.") from exc

        frames = media_io.load_video_frames(video, start=start or None, end=end or None, resize=DECODE_CAP)
        first = round(float(start or 0) * media_io.FPS)
        n, h, w = frames.shape[0], frames.shape[1], frames.shape[2]
        keys = _keyframes(json.loads(points) if points.strip() else {}, first, n, w, h)
        text = " ".join(text.split())
        cond = clip.encode_from_tokens_scheduled(clip.tokenize(text)) if text else None

        if keys:
            seeds, named = [], 0
            for k, pos, neg in keys:
                seed, by_name = _seed(sam3, model, cond, frames[k:k + 1], pos, neg, threshold)
                if not seed.any():
                    raise ValueError(f"SAM found nothing at the dots on frame {k + 1}; click on the object itself.")
                seeds.append(seed[:1])
                named += by_name
            parts = []
            if keys[0][0] > 0:
                parts.append(_track(sam3, model, frames[:keys[0][0] + 1].flip(0), initial_mask=seeds[0],
                                    max_objects=max_objects).flip(0)[:keys[0][0]])
            for i, (k, _p, _n) in enumerate(keys):
                stop = keys[i + 1][0] if i + 1 < len(keys) else n
                parts.append(_track(sam3, model, frames[k:stop], initial_mask=seeds[i], max_objects=max_objects))
            masks = torch.cat([m.float().cpu() for m in parts], dim=0)
            how = (f"dots on {len(keys)} frame(s)" + (f", matching {text!r}" if named else "")
                   + (", tracked from each" if len(keys) > 1 else ", tracked both ways"))
        elif text:
            masks = _track(sam3, model, frames, conditioning=cond, detection_threshold=threshold,
                           max_objects=max_objects, detect_interval=1)
            how = f"found by name ({text!r})"
        else:
            raise ValueError("Click the object or type its name first.")

        masks = masks.float().cpu() > 0.5
        if tuple(masks.shape[1:]) != (h, w):
            masks = F.interpolate(masks[:, None].float(), size=(h, w), mode="nearest")[:, 0] > 0.5
        if not masks.any():
            raise ValueError("SAM didn't find the object on any frame. Try other wording or click on it.")
        if mode in ("add", "subtract") and base.strip():
            current = _aligned(base, first, n, h, w)
            masks = current | masks if mode == "add" else current & ~masks
            how = f"{'added' if mode == 'add' else 'subtracted'}: {how}"
            if not masks.any():
                raise ValueError("Subtracting that leaves nothing masked.")
        info = save_mask(masks, video, first, how)
        print(f"[MiniMaxH3FantasticObjectMask] {os.path.basename(str(video))}: masked on {info['hit']} of {n} "
              f"frames ({how}), saved {info['file'].split(' [')[0]}")
        return {"ui": {"mmh3_mask": [info]}}


def _stamp(stroke, h, w):
    """One brush stroke as bool [h, w]: disks along its path."""
    r = max(1.0, float(stroke.get("r", 0.02)) * h)
    pts = [(float(p["x"]) * (w - 1), float(p["y"]) * (h - 1)) for p in stroke.get("points") or []
           if isinstance(p, dict) and "x" in p and "y" in p]
    out = np.zeros((h, w), dtype=bool)
    if not pts:
        return out
    path = [pts[0]]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / max(1.0, r / 2)))
        path += [(x0 + (x1 - x0) * t / steps, y0 + (y1 - y0) * t / steps) for t in range(1, steps + 1)]
    for x, y in path:
        x0, x1 = max(0, int(x - r)), min(w, int(x + r) + 1)
        y0, y1 = max(0, int(y - r)), min(h, int(y + r) + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.ogrid[y0:y1, x0:x1]
        out[y0:y1, x0:x1] |= (xx - x) ** 2 + (yy - y) ** 2 <= r * r
    return out


def apply_strokes(annotated, strokes, reach):
    """Paint onto a saved mask and save the result as a new mask. Each stroke
    is {time, erase, r (fraction of the frame height), points [{x, y}] on the
    source frame}; `reach` is "frame", "forward" (to the end) or "all"."""
    meta, masks = read_mask(annotated)
    n, h, w = masks.shape
    first = int(meta.get("start_frame", 0))
    masks = masks.clone()
    for stroke in strokes or []:
        k = min(n - 1, max(0, round(float(stroke.get("time") or 0) * media_io.FPS) - first))
        span = slice(k, k + 1) if reach == "frame" else slice(k, n) if reach == "forward" else slice(0, n)
        stamp = torch.from_numpy(_stamp(stroke, h, w))
        if stroke.get("erase"):
            masks[span] &= ~stamp
        else:
            masks[span] |= stamp
    return save_mask(masks, meta.get("source") or annotated, first, "brush edit")


def load_mask(annotated, n, start=None, mirror=False, crop=None):
    """A saved mask cut and framed the way the Media Loader sends its clip: the
    trim's `n` frames, mirrored then cropped. It stays at the resolution it was
    saved at; callers bring it to the size they work at. Frames it doesn't
    cover (the trim was widened after masking) come out empty, so they are
    kept as filmed. Returns [n, h, w] float."""
    meta, stored = read_mask(annotated)
    at = round(float(start or 0) * media_io.FPS) - int(meta.get("start_frame", 0))
    idx = torch.arange(at, at + n)
    inside = (idx >= 0) & (idx < stored.shape[0])
    m = torch.zeros(n, *stored.shape[1:])
    m[inside] = stored[idx[inside]].float()
    if not bool(inside.all()):
        print(f"[MiniMaxH3 mask] the mask covers {int(inside.sum())} of the {n} frames sent; the rest "
              "stay as filmed. Mask the clip again to cover the new trim.")
    return media_io._apply_crop(media_io._apply_mirror(m[..., None], mirror), crop)[..., 0]


NODE_CLASS_MAPPINGS = {"MiniMaxH3FantasticObjectMask": MiniMaxH3FantasticObjectMask}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3FantasticObjectMask": "Fantastic H3 Object Mask (SAM 3.1)"}
