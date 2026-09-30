"""Masked video edits: the latent H3 samples, and the pixels put back after.

H3 reads a noise mask on its audio-video latent natively: masked rows are
generated, the rest is held to the source as given content. Nothing in core
builds that latent from footage, so this does — the clip at the generation's
pixel budget, encoded, with the mask brought down to the latent grid.

The Media Loader's clip being edited is built here from its settings by the
RefMod Text Encode and saved (latent_cache), so later runs load it. Edit
Composite then pastes the regenerated area into the original frames, so
everything outside the mask is the source file itself rather than a VAE
round trip of it.

Mask values: 1 (white) is regenerated, 0 is kept. A SAM mask of the object
or person being changed is already the right way round.
"""

import math
import time

import torch
import torch.nn.functional as F

import comfy.model_management as mm
import comfy.nested_tensor

from . import latent_cache, media_io

CATEGORY = "conditioning/video_models"
CHUNK = 16                 # frames per GPU pass when resizing and growing


def usable_frames(n):
    """The longest H3 clip length (17k + 5 frames) that fits in n frames."""
    if n < 5:
        raise ValueError(f"The source clip has {n} frames; H3 needs at least 5.")
    return (n - 5) // 17 * 17 + 5


def budget_size(w, h, width, height):
    """(tw, th, scale): the clip's shape at no more than width x height pixels,
    never enlarged, snapped to 32. No budget keeps the clip's own size."""
    scale = min(1.0, math.sqrt(width * height / float(w * h))) if width and height else 1.0
    return max(32, round(w * scale / 32) * 32), max(32, round(h * scale / 32) * 32), scale


def resize_frames(frames, tw, th):
    """[N, H, W, 3] uint8 or float -> float32 [N, th, tw, 3], a chunk at a time on
    the GPU ('area' when shrinking, bicubic when enlarging)."""
    n, h, w = frames.shape[:3]
    dev = mm.get_torch_device()
    out = torch.empty((n, th, tw, 3), dtype=torch.float32)
    for i in range(0, n, CHUNK):
        x = frames[i:i + CHUNK, ..., :3].to(dev)
        x = x.float() / 255.0 if x.dtype == torch.uint8 else x.float()
        if (h, w) != (th, tw):
            x = x.movedim(-1, 1)
            if th * tw < h * w:
                x = F.interpolate(x, size=(th, tw), mode="area")
            else:
                x = F.interpolate(x, size=(th, tw), mode="bicubic", align_corners=False).clamp(0, 1)
            x = x.movedim(1, -1)
        out[i:i + CHUNK] = x.cpu()
    return out


def resize_mask(mask, tw, th):
    """[N, h, w] -> [N, th, tw], 1 wherever any source pixel was masked, so a
    thin edge never shrinks away."""
    if tuple(mask.shape[1:]) == (th, tw):
        return (mask > 0.5).float()
    dev = mm.get_torch_device()
    out = torch.empty((mask.shape[0], th, tw), dtype=torch.float32)
    for i in range(0, mask.shape[0], CHUNK):
        m = (mask[i:i + CHUNK].to(dev) > 0.5).float()[:, None]
        m = F.interpolate(m, size=(th, tw), mode="area" if th * tw < m.shape[-2] * m.shape[-1] else "nearest")
        out[i:i + CHUNK] = (m[:, 0] > 0).float().cpu()
    return out


def _separable(fn, x, px):
    k = 2 * px + 1
    x = fn(x, (1, k), stride=1, padding=(0, px))
    return fn(x, (k, 1), stride=1, padding=(px, 0))


def _box(x, k, stride, padding):
    return F.avg_pool2d(x, k, stride=stride, padding=padding, count_include_pad=False)


def grow_mask(mask, px):
    """Widen [N, H, W] by px pixels (a square dilation), as two 1-D passes on the
    GPU — the same result as one (2px+1)^2 pass at a fraction of the work."""
    if px <= 0:
        return mask
    dev = mm.get_torch_device()
    out = torch.empty_like(mask)
    for i in range(0, mask.shape[0], CHUNK):
        m = mask[i:i + CHUNK].to(dev, torch.float32)[:, None]
        out[i:i + CHUNK] = _separable(F.max_pool2d, m, px)[:, 0].to(out.device)
    return out


def latent_mask(mask, frame_counts, lat_h, lat_w):
    """Pixel mask [F, H, W] -> [1, 1, T, lat_h, lat_w]. Each latent frame and
    each 16x16 cell is masked when any pixel it covers is: a thin edge must
    not round away and leave part of the object held."""
    cells = F.adaptive_max_pool2d(mask[:, None], (lat_h, lat_w))[:, 0]
    rows, at = [], 0
    for n in frame_counts:
        rows.append(cells[at:at + n].amax(dim=0))
        at += n
    return torch.stack(rows)[None, None]


def feather_latent(mask, cells):
    """[1, 1, T, h, w] latent mask -> the same with a ramp `cells` wide outside
    it: a cell k cells away gets 1 - k / (cells + 1), so H3 blends the edge
    instead of cutting it (a cell at 0.5 is only half re-noised). The inside
    stays 1."""
    if cells <= 0:
        return mask
    x = near = mask[0].movedim(0, 1)                            # [T, 1, h, w]
    out = x
    for k in range(1, cells + 1):
        near = F.max_pool2d(near, 3, stride=1, padding=1)
        out = torch.maximum(out, near * (1 - k / (cells + 1)))
    return out.movedim(1, 0)[None]


def crop_box(obj, w, h, context, invert=False):
    """Where crop to mask samples, in frame pixels (x, y, bw, bh), or None:
    the grown object over every frame, padded by `context`, no longer than
    2.5:1, inside the frame. None when inverting, or when the box would cover
    more than 60% of the frame (nothing to zoom into). `obj` is the grown
    object mask [n, mh, mw] at any resolution. The edit builder and Edit
    Composite both call this, so they agree on the box."""
    if not context or invert:
        return None
    any_frame = (obj > 0.5).any(dim=0)
    ys, xs = torch.nonzero(any_frame, as_tuple=True)
    if not len(xs):
        return None
    mh, mw = any_frame.shape
    x0, x1 = float(xs.min()) * w / mw, float(xs.max() + 1) * w / mw
    y0, y1 = float(ys.min()) * h / mh, float(ys.max() + 1) * h / mh
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bw, bh = (x1 - x0) * context, (y1 - y0) * context
    if bw / bh > 2.5:
        bh = bw / 2.5
    elif bh / bw > 2.5:
        bw = bh / 2.5
    bw, bh = min(w, max(64.0, bw)), min(h, max(64.0, bh))
    if bw * bh > 0.6 * w * h:
        return None
    bw, bh = int(round(bw)), int(round(bh))
    x = int(round(min(w - bw, max(0.0, cx - bw / 2))))
    y = int(round(min(h - bh, max(0.0, cy - bh / 2))))
    return x, y, bw, bh


def shape(mask, n, w, h, grow, invert, context):
    """The object mask as the edit uses it: grown (at the mask's own
    resolution, in frame pixels), and where crop to mask samples. Returns
    (grown object [n, mh, mw], box or None)."""
    m = (mask[:n] > 0.5).float()
    g = round(grow * m.shape[-1] / w)
    obj = grow_mask(m, g)
    return obj, crop_box(obj, w, h, context, invert)


def _h3():
    try:
        from comfy.ldm.minimax.model import FRAME_PER_TOKEN
        from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE
        from comfy_extras.nodes_minimax_h3 import temporal_shape, _encode_ref_audio
    except Exception as exc:
        raise RuntimeError("This ComfyUI has no native MiniMax H3 support; update it.") from exc
    return FRAME_PER_TOKEN, MiniMaxH3VideoVAE, temporal_shape, _encode_ref_audio


def hide_area(frames, obj, box, w, h, invert, how, radius):
    """The cited clip with its masked area changed, so the original doesn't
    creep back into the edit: `obj` (from shape(), over the whole w x h frame)
    cut to the crop box and brought to the frames' size, turned inside out
    when the edit is inverted; in there the frames get a Gaussian blur of
    `radius` source pixels ("blur"), become a photographic negative
    ("invert"), or both ("blur_invert"). `frames` [n, th, tw, 3] is left as it
    is; the result is new."""
    if box:
        x, y, bw, bh = box
        mh, mw = obj.shape[1:]
        obj = obj[:, round(y * mh / h):round((y + bh) * mh / h), round(x * mw / w):round((x + bw) * mw / w)]
    n, th, tw = frames.shape[:3]
    dev = mm.get_torch_device()
    if how != "invert":
        sigma = radius * tw / (box[2] if box else w)     # source pixels, on the cited clip's size
        r = max(1, math.ceil(3 * sigma))
        k = torch.exp(-0.5 * (torch.arange(-r, r + 1, device=dev, dtype=torch.float32) / sigma) ** 2)
        k = (k / k.sum()).repeat(3, 1, 1, 1)
    out = torch.empty_like(frames)
    for i in range(0, n, CHUNK):
        m = resize_mask(obj[i:i + CHUNK], tw, th).to(dev)[:, None]
        if invert:
            m = 1.0 - m
        f = frames[i:i + CHUNK].to(dev, torch.float32).movedim(-1, 1)
        if how == "invert":
            hidden = 1.0 - f
        else:
            hidden = F.conv2d(F.pad(f, (r, r, 0, 0), mode="replicate"), k.view(3, 1, 1, -1), groups=3)
            hidden = F.conv2d(F.pad(hidden, (0, 0, r, r), mode="replicate"), k.view(3, 1, -1, 1), groups=3)
            if how == "blur_invert":
                hidden = 1.0 - hidden
        out[i:i + CHUNK] = torch.lerp(f, hidden, m).movedim(1, -1).to(out.device, out.dtype)
    return out


def cell_mask(obj, box, w, h, tw, th, invert, feather):
    """What an edit regenerates, on H3's latent grid: the grown object mask
    (`obj` [n, mh, mw] from shape(), over the whole w x h frame) cut to the
    crop box, brought to the sampling size tw x th, then any-pixel pooled to
    16x16 cells and to latent frames (one per 1 or 4 pixel frames). Inverted
    after the resize, as the edit samples it. `feather` source pixels become
    a ramp rounded up to whole cells. The edit and Edit Composite both use
    this, so the composite pastes back exactly the area that was sampled.
    Returns ([1, 1, T, th/16, tw/16], pixel frames per latent frame)."""
    FRAME_PER_TOKEN, _vae, temporal_shape, _enc = _h3()
    if box:
        x, y, bw, bh = box
        mh, mw = obj.shape[1:]
        obj = obj[:, round(y * mh / h):round((y + bh) * mh / h), round(x * mw / w):round((x + bw) * mw / w)]
    rows = []
    for i in range(0, obj.shape[0], CHUNK):
        m = resize_mask(obj[i:i + CHUNK], tw, th)
        rows.append(F.adaptive_max_pool2d((1.0 - m if invert else m)[:, None], (th // 16, tw // 16))[:, 0])
    counts = [FRAME_PER_TOKEN[k % 5] for k in range(temporal_shape(obj.shape[0])[1])]
    cells = latent_mask(torch.cat(rows), counts, th // 16, tw // 16)
    return feather_latent(cells, math.ceil(feather * tw / (box[2] if box else w) / 16)), counts


def build_latent(vae, frames, mask, grow=16, audio_vae=None, audio=None, width=0, height=0,
                 feather=0, invert=False, context=0):
    """Encode an edit: `frames` [N, H, W, 3] (uint8 or float) at the source size,
    `mask` [N or 1, h, w] at any size, `grow` and `feather` in source pixels,
    `audio` held when given. Samples at no more than width x height pixels.
    `invert` regenerates everything but the (grown) object; `context` > 0
    samples only the box around it, enlarged up to 4x. Returns the tensors and
    (tw, th, frames)."""
    _fpt, MiniMaxH3VideoVAE, temporal_shape, _encode_ref_audio = _h3()
    if vae is None or not isinstance(vae.first_stage_model, MiniMaxH3VideoVAE):
        raise ValueError("Editing a clip needs the MiniMax H3 video VAE.")
    if audio is not None and audio_vae is None:
        raise ValueError("Keeping the source audio needs the H3 audio VAE.")

    n = usable_frames(frames.shape[0])
    h, w = frames.shape[1], frames.shape[2]
    m = mask.reshape(-1, mask.shape[-2], mask.shape[-1]).float()
    if m.shape[0] == 1:
        m = m.expand(n, -1, -1)
    elif m.shape[0] < n:
        raise ValueError(f"The mask has {m.shape[0]} frames and the clip {n}; give one mask per frame, "
                         "or a single frame for the whole clip.")
    obj, box = shape(m, n, w, h, grow, invert, context)
    if not obj.any():
        raise ValueError("The mask is empty on every frame, so nothing would change.")
    src = frames[:n]
    if box:
        x, y, bw, bh = box
        src = src[:, y:y + bh, x:x + bw]
        scale = min(4.0, math.sqrt(width * height / float(bw * bh))) if width and height else 1.0
        tw, th = max(32, round(bw * scale / 32) * 32), max(32, round(bh * scale / 32) * 32)
    else:
        tw, th, scale = budget_size(w, h, width, height)

    clip = resize_frames(src, tw, th)
    video = vae.encode(clip).to(mm.intermediate_device())
    del clip
    _frame_count, latent_t, audio_t = temporal_shape(n)
    if video.shape[2] != latent_t:
        raise ValueError(f"The VAE gave {video.shape[2]} latent frames for {n} pixel frames; H3 expects {latent_t}.")
    video_mask = cell_mask(obj, box, w, h, tw, th, invert, feather)[0].to(video.device)

    audio_latent = torch.zeros([1, 32, 2, audio_t], device=video.device)
    audio_mask = torch.ones_like(audio_latent)
    if audio is not None:
        z, _t = _encode_ref_audio(audio_vae, audio)
        z = z.to(video.device)[..., :audio_t]
        audio_latent[..., :z.shape[-1]] = z
        audio_mask[..., :z.shape[-1]] = 0.0
    where = (f"the {box[2]}x{box[3]} box at ({box[0]},{box[1]}) of {w}x{h}, {tw / box[2]:.1f}x detail"
             if box else f"{w}x{h}" + ("; crop to mask skipped: the area the mask moves through over the clip, "
                                       "with context, covers most of the frame" if context and not invert else ""))
    print(f"[MiniMaxH3FantasticVideoEditLatent] {n} frames at {tw}x{th} from {where}"
          + ("; inverted" if invert else "") + (f"; feather {feather}px" if feather else "")
          + f" ({frames.shape[0] - n} trailing frame(s) dropped to fit H3's clip lengths); "
          f"{float(video_mask.mean()):.0%} of the video regenerated; audio {'held' if audio is not None else 'generated'}")
    return video, video_mask, audio_latent, audio_mask, (tw, th, n)


def as_latent(video, video_mask, audio_latent, audio_mask):
    return {"samples": comfy.nested_tensor.NestedTensor((video, audio_latent)),
            "noise_mask": comfy.nested_tensor.NestedTensor((video_mask, audio_mask))}


def _trim(spec):
    t = spec.get("trim") if isinstance(spec.get("trim"), dict) else {}
    start = float(t.get("start") or 0) or None
    end = float(t["end"]) if t.get("end") else None
    return start, end


def source_frames(spec):
    """The clip being edited as the loader frames it (trim, crop, mirror, size
    cap), in the decoder's own 8-bit values."""
    start, end = _trim(spec)
    return media_io.load_video_frames(spec["file"], start=start, end=end, crop=spec.get("crop"),
                                      mirror=bool(spec.get("mirror")), resize=spec.get("resize"), as_uint8=True)


def spec_mask(spec, n):
    from .object_mask import load_mask
    start, _end = _trim(spec)
    return load_mask(spec["mask"], n, start=start, mirror=bool(spec.get("mirror")), crop=spec.get("crop"))


def bundle_edit(references, vae, audio_vae, width=0, height=0):
    """The Media Loader bundle's clip being edited, as (latent, tw, th, frames),
    or None when the bundle has none. Built once per set of settings and saved;
    later runs load it."""
    spec = references.get("edit") if isinstance(references, dict) else None
    if spec is None:
        return None
    _h3()
    keep_audio = bool(spec.get("keep_audio", True)) and bool(spec.get("has_audio"))
    try:
        mask_stamp = latent_cache.file_stamp(spec["mask"])
    except FileNotFoundError as exc:
        raise ValueError(f"The mask file for {spec.get('name')} is missing. Mask the clip again, or clear its "
                         "mask in the Media Loader.") from exc
    key = {"v": 2, "clip": latent_cache.file_stamp(spec["file"]), "mask": mask_stamp,
           "trim": _trim(spec), "crop": spec.get("crop"), "mirror": bool(spec.get("mirror")),
           "resize": spec.get("resize"), "grow": int(spec.get("grow", 16)), "budget": [int(width), int(height)],
           "feather": int(spec.get("feather") or 0), "invert": bool(spec.get("invert")),
           "context": float(spec.get("context") or 0),
           "audio": keep_audio, "vae": latent_cache.vae_tag(vae),
           "audio_vae": latent_cache.vae_tag(audio_vae) if keep_audio else None}
    path = latent_cache.path_for("edit", key)
    t0 = time.perf_counter()
    saved = latent_cache.load(path)
    if saved is not None:
        dev = mm.intermediate_device()
        video = saved["video"].to(dev)
        tw, th = video.shape[4] * 16, video.shape[3] * 16
        n = int(saved["frames"].item())
        print(f"[MiniMaxH3FantasticVideoEditLatent] {spec.get('name')}: loaded the saved edit "
              f"({n} frames at {tw}x{th}, {time.perf_counter() - t0:.1f}s)")
        return (as_latent(video, saved["video_mask"].to(dev), saved["audio"].to(dev), saved["audio_mask"].to(dev)),
                tw, th, n)
    frames = source_frames(spec)
    mask = spec_mask(spec, frames.shape[0])
    start, end = _trim(spec)
    audio = media_io.extract_audio(spec["file"], start=start, end=end) if keep_audio else None
    video, video_mask, audio_latent, audio_mask, (tw, th, n) = build_latent(
        vae, frames, mask, int(spec.get("grow", 16)), audio_vae, audio, width, height,
        feather=int(spec.get("feather") or 0), invert=bool(spec.get("invert")), context=float(spec.get("context") or 0))
    del frames, mask
    latent_cache.save(path, {"video": video, "video_mask": video_mask, "audio": audio_latent,
                             "audio_mask": audio_mask, "frames": torch.tensor([n])})
    print(f"[MiniMaxH3FantasticVideoEditLatent] {spec.get('name')}: built and saved the edit "
          f"({time.perf_counter() - t0:.1f}s); later runs load it until its settings change")
    return as_latent(video, video_mask, audio_latent, audio_mask), tw, th, n


class MiniMaxH3FantasticVideoEditLatent:
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "Turn a source clip and a mask into the latent MiniMax H3 samples for an edit: white areas of the mask "
        "are regenerated, everything else is held to the source. Use it in place of the empty latent, and wire "
        "width, height and length into the Text Encode. The Media Loader's Mask for editing does this for you "
        "through the RefMod Text Encode; this node is for masks made elsewhere."
    )
    RETURN_TYPES = ("LATENT", "INT", "INT", "INT")
    RETURN_NAMES = ("latent", "width", "height", "length")
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": ("VAE", {"tooltip": "The H3 video VAE."}),
                "images": ("IMAGE", {"tooltip": "The source clip's frames, at 24 fps."}),
                "mask": ("MASK", {"tooltip": "White where the clip is regenerated: whatever is being replaced, "
                                             "changed or removed. One mask per frame, or a single frame for the whole clip."}),
                "grow": ("INT", {"default": 16, "min": 0, "max": 256, "step": 1,
                    "tooltip": "Widen the mask by this many source pixels, so edges and shadows are replaced too."}),
                "keep_audio": ("BOOLEAN", {"default": True,
                    "tooltip": "On: the source audio is held unchanged. Off, or no audio connected: the "
                               "soundtrack is generated fresh."}),
            },
            "optional": {
                "audio_vae": ("VAE", {"tooltip": "The H3 audio VAE, needed to keep the source audio."}),
                "audio": ("AUDIO", {"tooltip": "The source clip's soundtrack."}),
                "megapixels": ("FLOAT", {"default": 0.98, "min": 0.0, "max": 16.0, "step": 0.01,
                    "tooltip": "Sample at no more than this many megapixels, keeping the clip's shape; never "
                               "enlarged. 0 samples at the clip's own size."}),
            },
        }

    def build(self, vae, images, mask, grow=16, keep_audio=True, audio_vae=None, audio=None, megapixels=0.98):
        side = int(math.sqrt(megapixels * 1_000_000)) if megapixels > 0 else 0
        video, video_mask, audio_latent, audio_mask, (tw, th, n) = build_latent(
            vae, images, mask, grow, audio_vae, audio if keep_audio else None, side, side)
        return (as_latent(video, video_mask, audio_latent, audio_mask), tw, th, n)


class MiniMaxH3FantasticEditComposite:
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "Put the edit back into the original footage: the area H3 regenerated (the mask, grown and rounded out "
        "to the latent's 16-pixel cells, feather included) is pasted into the Media Loader's clip through a soft "
        "edge, and everything else is the source file's own pixels, untouched by the VAE. Wire it between VAE Decode and Create Video, with the same references the Text Encode gets. "
        "With no clip being edited it passes the frames through."
    )
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "composite"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "The decoded frames from VAE Decode."}),
                "references": ("H3_REFS", {"tooltip": "The Media Loader bundle, from the loader or the Prompt "
                                                      "Builder's references output — the same one the Text Encode gets."}),
                "blend": ("INT", {"default": 8, "min": 0, "max": 64, "step": 1,
                    "tooltip": "Extra soft edge, in output pixels, on top of the one the latent cells give."}),
                "max_size": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 32,
                    "tooltip": "Cap the output's long edge. 0 keeps the source clip's size (after the loader's "
                               "crop and size cap)."}),
            },
        }

    def composite(self, images, references, blend=8, max_size=0):
        spec = references.get("edit") if isinstance(references, dict) else None
        if spec is None:
            print("[MiniMaxH3FantasticEditComposite] no clip is being edited; frames passed through")
            return (images,)
        t0 = time.perf_counter()
        src = source_frames(spec)
        n = min(images.shape[0], src.shape[0])
        if n != usable_frames(n):
            raise ValueError(f"Edit Composite got {images.shape[0]} frames; wire it straight after VAE Decode, "
                             "before anything that adds or drops frames.")
        src = src[:n]
        h, w = src.shape[1], src.shape[2]
        if max_size and max(w, h) > max_size:
            k = max_size / max(w, h)
            ow, oh = max(2, round(w * k / 2) * 2), max(2, round(h * k / 2) * 2)
        else:
            ow, oh = w, h
        invert = bool(spec.get("invert"))
        obj, box = shape(spec_mask(spec, n), n, w, h, int(spec.get("grow", 16)), invert, float(spec.get("context") or 0))
        # The decoded frames are at the sampling size, so the cells the edit
        # regenerated can be worked out again exactly; each pixel frame takes
        # its latent frame's cells.
        cells, counts = cell_mask(obj, box, w, h, images.shape[2], images.shape[1], invert,
                                  int(spec.get("feather") or 0))
        cells = cells[0, 0]
        latent_of = [t for t, c in enumerate(counts) for _ in range(c)]
        k = ow / w
        r = blend // 2
        bx, by, bw, bh = 0, 0, ow, oh
        if box:
            bx, by, bw, bh = (round(v * k) for v in box)
            bw, bh = max(1, min(bw, ow - bx)), max(1, min(bh, oh - by))
        dev = mm.get_torch_device()
        out = torch.empty((n, oh, ow, 3), dtype=torch.float32)
        held = 0.0
        for i in range(0, n, CHUNK):
            j = min(n, i + CHUNK)
            # bilinear: the cells' edges and any feather ramp fade smoothly
            a = F.interpolate(cells[latent_of[i:j]].to(dev)[:, None], size=(bh, bw), mode="bilinear", align_corners=False)
            if r:
                a = _separable(_box, a, r)
            orig = resize_frames(src[i:j], ow, oh).to(dev)
            if box:
                # the generated frames are the box, enlarged: scale them back into it
                gen = orig.clone()
                gen[:, by:by + bh, bx:bx + bw] = resize_frames(images[i:j], bw, bh).to(dev)
                alpha = torch.zeros((j - i, 1, oh, ow), device=dev)
                alpha[..., by:by + bh, bx:bx + bw] = a
            else:
                gen, alpha = resize_frames(images[i:j], ow, oh).to(dev), a
            alpha = alpha.movedim(1, -1)
            out[i:j] = (alpha * gen + (1 - alpha) * orig).cpu()
            held += float((alpha == 0).sum())
        print(f"[MiniMaxH3FantasticEditComposite] {spec.get('name')}: {n} frames at {ow}x{oh}; "
              f"{held / (n * ow * oh):.0%} of every frame is the original footage "
              f"({time.perf_counter() - t0:.1f}s)")
        return (out,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3FantasticVideoEditLatent": MiniMaxH3FantasticVideoEditLatent,
    "MiniMaxH3FantasticEditComposite": MiniMaxH3FantasticEditComposite,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3FantasticVideoEditLatent": "Fantastic H3 Video Edit Latent",
    "MiniMaxH3FantasticEditComposite": "Fantastic H3 Edit Composite",
}
