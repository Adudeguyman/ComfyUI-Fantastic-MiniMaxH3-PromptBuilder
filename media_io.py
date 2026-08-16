"""Decoding helpers for the MiniMax H3 Media Loader.

Everything here degrades gracefully: if a decoder backend is missing we raise a
message the user can act on rather than failing deep inside a tensor op.
"""

import os
import shutil
import subprocess

try:
    import numpy as np
    import torch
except Exception:  # pragma: no cover - present in every real ComfyUI install
    np = None
    torch = None

try:
    import folder_paths
except Exception:  # pragma: no cover - only outside ComfyUI
    folder_paths = None

FPS = 24
AUDIO_SR = 32000


# --- backend probing --------------------------------------------------------

def _have_av():
    try:
        import av  # noqa: F401
        return True
    except Exception:
        return False


def _ffmpeg():
    return shutil.which("ffmpeg")


def _ffprobe():
    return shutil.which("ffprobe")


def backends():
    return {"av": _have_av(), "ffmpeg": bool(_ffmpeg()), "ffprobe": bool(_ffprobe())}


def can_decode_video():
    return _have_av() or bool(_ffmpeg())


# --- path handling ----------------------------------------------------------

def resolve(annotated):
    """'name [input]' or 'sub/name' -> absolute path inside ComfyUI's dirs."""
    if folder_paths is not None:
        try:
            return folder_paths.get_annotated_filepath(annotated)
        except Exception:
            pass
    name = annotated
    for suffix in (" [input]", " [output]", " [temp]"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    if folder_paths is not None:
        return os.path.join(folder_paths.get_input_directory(), name)
    return name


# --- images -----------------------------------------------------------------

def load_image(annotated, crop=None, mirror=False, rotate=0, resize=0):
    """Decode a still to [1, H, W, 3].

    `rotate` (0/90/180/270, clockwise), `mirror` and `crop` (normalised
    x/y/w/h) are applied here rather than to the file, so the picture on disk
    is never modified. Order matches what the editor shows: rotate, then
    mirror, then crop — the crop rect is drawn on the already-turned image.
    Cropping happens in PIL before the float conversion, so a small crop of a
    huge photo costs a fraction of the memory the full frame would.
    """
    from PIL import Image, ImageOps

    path = resolve(annotated)
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")
    try:
        turn = int(rotate or 0) % 360
    except (TypeError, ValueError):
        turn = 0
    if turn in (90, 180, 270):
        # expand=True so the canvas grows: a quarter turn swaps w/h.
        img = img.rotate(-turn, expand=True)   # PIL turns anticlockwise
        print(f"[MiniMaxH3 media_io] rotated {turn}\u00b0 -> {img.size[0]}x{img.size[1]}")
    if mirror:
        img = ImageOps.mirror(img)          # before crop: rect is screen-space
    if crop:
        try:
            W, H = img.size
            x = float(crop.get("x", 0.0)); y = float(crop.get("y", 0.0))
            x0 = max(0, min(W - 16, int(round(x * W))))
            y0 = max(0, min(H - 16, int(round(y * H))))
            x1 = min(W, max(x0 + 16, int(round((x + float(crop.get("w", 1.0))) * W))))
            y1 = min(H, max(y0 + 16, int(round((y + float(crop.get("h", 1.0))) * H))))
            if (x0, y0, x1, y1) != (0, 0, W, H):
                img = img.crop((x0, y0, x1, y1))
                print(f"[MiniMaxH3 media_io] picture crop {W}x{H} -> "
                      f"{x1 - x0}x{y1 - y0} at ({x0},{y0})")
        except Exception as exc:
            print(f"[MiniMaxH3 media_io] picture crop ignored ({exc})")
    try:
        cap = int(resize or 0)
    except (TypeError, ValueError):
        cap = 0
    if cap > 0:
        w, h = img.size
        if max(w, h) > cap:
            scale = cap / float(max(w, h))
            nw = max(16, int(round(w * scale)))
            nh = max(16, int(round(h * scale)))
            img = img.resize((nw, nh), Image.LANCZOS)
            print(f"[MiniMaxH3 media_io] resized {w}x{h} -> {nw}x{nh} "
                  f"(long edge {cap})")

    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]  # [1, H, W, 3]


# --- audio ------------------------------------------------------------------

def _normalize_scale(waveform):
    """Force samples into [-1, 1] whatever the decoder produced.

    Some packs globally monkey-patch torchaudio.load (e.g. via scipy), which
    returns raw integer samples as floats. Feeding int16-scale audio to the
    audio VAE silently yields garbage conditioning, so guard every path.
    """
    peak = float(waveform.abs().max()) if waveform.numel() else 0.0
    if peak <= 1.5:
        return waveform
    if peak <= 132.0:
        scale = 128.0            # int8-scale
    elif peak <= 33000.0:
        scale = 32768.0          # int16-scale (the common case)
    elif peak >= 1e6:
        scale = 2147483648.0     # int32-scale
    else:
        scale = peak             # loud float data: bring the peak to 1.0
    print(f"[MiniMaxH3 media_io] audio arrived out of range "
          f"(peak {peak:.0f}); normalising by {scale:.0f}")
    return waveform / scale


def _to_audio_dict(waveform, sr):
    if waveform.ndim == 1:
        waveform = waveform[None, :]
    if waveform.ndim == 2:
        waveform = waveform[None, ...]  # [1, C, L]
    return {"waveform": _normalize_scale(waveform.float()), "sample_rate": int(sr)}


def _audio_via_comfy(annotated, path):
    """Delegate to ComfyUI's own LoadAudio machinery when available.

    This is byte-for-byte the decode the native node performs, so anything
    that works with a native LoadAudio works identically through us. Import
    paths are tried defensively because comfy_extras is not a stable API.
    """
    last = None
    try:
        from comfy_extras import nodes_audio as na
    except Exception as exc:
        raise RuntimeError(f"comfy audio module unavailable: {exc}")

    # 1) module-level helper, present in several ComfyUI versions
    for name in ("load_audio", "load"):
        fn = getattr(na, name, None)
        if callable(fn):
            try:
                out = fn(path)
                d = _unwrap_audio(out)
                if d is not None:
                    return d
            except Exception as exc:
                last = exc

    # 2) the LoadAudio node itself, fed the same annotated name the UI would use
    cls = getattr(na, "LoadAudio", None)
    if cls is not None:
        for attr in ("execute", getattr(cls, "FUNCTION", None), "load"):
            fn = getattr(cls, attr, None) if isinstance(attr, str) else None
            if not callable(fn):
                continue
            for arg in (annotated, path):
                try:
                    d = _unwrap_audio(fn(arg))
                    if d is not None:
                        return d
                except Exception as exc:
                    last = exc
    raise RuntimeError(f"comfy LoadAudio path failed: {last}")


def _unwrap_audio(out):
    """Dig the {'waveform','sample_rate'} dict out of whatever wrapper."""
    seen = 0
    while out is not None and seen < 5:
        if isinstance(out, dict) and "waveform" in out:
            return {"waveform": _normalize_scale(out["waveform"].float()),
                    "sample_rate": int(out["sample_rate"])}
        if isinstance(out, (tuple, list)) and out:
            out = out[0]
        elif hasattr(out, "args"):          # io.NodeOutput
            out = out.args
        elif hasattr(out, "audio"):
            out = out.audio
        else:
            return None
        seen += 1
    return None


def _audio_via_av(path):
    """Decode with PyAV, the same route ComfyUI's own LoadAudio takes.

    Preferred over torchaudio, which other extensions are known to globally
    monkey-patch into returning unnormalised integer samples.
    """
    import av

    with av.open(path) as container:
        stream = next(s for s in container.streams if s.type == "audio")
        chunks = []
        for frame in container.decode(stream):
            arr = frame.to_ndarray()
            if arr.dtype.kind == "i":
                arr = arr.astype(np.float32) / float(np.iinfo(arr.dtype).max)
            elif arr.dtype.kind == "u":
                arr = (arr.astype(np.float32) - 128.0) / 128.0
            else:
                arr = arr.astype(np.float32)
            if arr.ndim == 1:
                arr = arr[None, :]
            # Packed layouts arrive as ONE interleaved row of C*samples.
            # frame.samples is the per-channel count, so the channel count is
            # arithmetic — never trust stream.channels, which newer PyAV
            # builds return as None (that misread stereo as half-speed mono).
            per_channel = int(getattr(frame, "samples", 0) or 0)
            if arr.shape[0] == 1 and per_channel and arr.shape[1] > per_channel:
                ch = arr.shape[1] // per_channel
                if ch * per_channel == arr.shape[1]:
                    arr = arr.reshape(per_channel, ch).T
            chunks.append(arr)
        if not chunks:
            raise RuntimeError("no decodable audio frames")
        data = np.concatenate(chunks, axis=1)
        sr = stream.rate
    return _to_audio_dict(torch.from_numpy(data), sr)


def _slice_audio(d, start, end):
    """Trim a decoded {'waveform','sample_rate'} dict to [start, end] seconds."""
    if not start and not end:
        return d
    sr = d["sample_rate"]
    total = d["waveform"].shape[-1]
    a = max(0, int(round((start or 0.0) * sr)))
    b = min(total, int(round(end * sr))) if end else total
    if b <= a:
        raise RuntimeError(
            f"Audio trim {start or 0:.2f}-{end:.2f}s selects nothing "
            f"(clip is {total / sr:.2f}s).")
    return {"waveform": d["waveform"][..., a:b], "sample_rate": sr}


def load_audio(annotated, start=None, end=None):
    path = resolve(annotated)
    errors = []
    try:
        d = _audio_via_comfy(annotated, path)
        print(f"[MiniMaxH3 media_io] {os.path.basename(path)}: decoded via "
              "ComfyUI's own LoadAudio")
        return _slice_audio(d, start, end)
    except Exception as exc:
        errors.append(f"comfy: {exc}")
    try:
        d = _audio_via_av(path)
        print(f"[MiniMaxH3 media_io] {os.path.basename(path)}: decoded via PyAV")
        return _slice_audio(d, start, end)
    except Exception as exc:
        errors.append(f"av: {exc}")
    try:
        return _slice_audio(_audio_via_ffmpeg(path), start, end)
    except Exception as exc:
        errors.append(f"ffmpeg: {exc}")
    try:
        import torchaudio

        waveform, sr = torchaudio.load(path)
        return _slice_audio(_to_audio_dict(waveform, sr), start, end)
    except Exception as exc:
        errors.append(f"torchaudio: {exc}")
    raise RuntimeError(
        f"Can't decode audio from {os.path.basename(path)} — " + "; ".join(errors))


def _audio_via_ffmpeg(path):
    exe = _ffmpeg()
    if not exe:
        raise RuntimeError(
            f"Can't decode audio from {os.path.basename(path)}: no torchaudio and "
            "no ffmpeg on PATH. Install ffmpeg or supply a WAV file."
        )
    cmd = [exe, "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le",
           "-ac", "2", "-ar", str(AUDIO_SR), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    if not raw:
        raise RuntimeError(f"{os.path.basename(path)} contains no decodable audio.")
    data = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()
    return _to_audio_dict(torch.from_numpy(data), AUDIO_SR)


# --- video ------------------------------------------------------------------

def _apply_mirror(frames, mirror):
    """Flip [T, H, W, C] frames left-to-right.

    Applied BEFORE the crop, because the crop rect is drawn on the mirrored
    preview — so what you framed on screen is what gets sent.
    """
    if not mirror:
        return frames
    try:
        out = torch.flip(frames, dims=[2])
        print("[MiniMaxH3 media_io] mirrored horizontally")
        return out
    except Exception as exc:
        print(f"[MiniMaxH3 media_io] mirror ignored ({exc})")
        return frames


def _apply_crop(frames, crop):
    """Crop [T, H, W, C] frames by a normalised {x, y, w, h} rect (0..1).

    Applied after decode so both decode paths behave identically. The rect is
    clamped to at least 16px per axis so a stray drag can't produce an
    unusable sliver.
    """
    if not crop:
        return frames
    try:
        H, W = int(frames.shape[1]), int(frames.shape[2])
        x = float(crop.get("x", 0.0))
        y = float(crop.get("y", 0.0))
        x0 = max(0, min(W - 16, int(round(x * W))))
        y0 = max(0, min(H - 16, int(round(y * H))))
        x1 = min(W, max(x0 + 16, int(round((x + float(crop.get("w", 1.0))) * W))))
        y1 = min(H, max(y0 + 16, int(round((y + float(crop.get("h", 1.0))) * H))))
        if (x0, y0, x1, y1) == (0, 0, W, H):
            return frames
        print(f"[MiniMaxH3 media_io] crop {W}x{H} -> "
              f"{x1 - x0}x{y1 - y0} at ({x0},{y0})")
        return frames[:, y0:y1, x0:x1, :]
    except Exception as exc:
        print(f"[MiniMaxH3 media_io] crop ignored ({exc})")
        return frames


def load_video_frames(annotated, fps=FPS, max_frames=None, start=None, end=None,
                      crop=None, mirror=False, resize=None):
    """Decode to an IMAGE batch [N, H, W, 3] resampled to `fps`.

    `start`/`end` (seconds) trim the source before sampling; only the trimmed
    span is decoded, so trimming a long file is cheap. `crop` is a normalised
    {x, y, w, h} rect applied after decode.
    """
    path = resolve(annotated)
    try:
        cap = max(0, int(resize or 0))       # 0 / unset = decode as-is
    except (TypeError, ValueError):
        cap = 0
    if _have_av():
        try:
            return _apply_crop(
                _apply_mirror(
                    _frames_via_av(path, fps, max_frames, start, end, cap),
                    mirror), crop)
        except Exception:
            pass
    if _ffmpeg():
        return _apply_crop(
            _apply_mirror(
                _frames_via_ffmpeg(path, fps, max_frames, start, end, cap),
                mirror), crop)
    raise RuntimeError(
        f"Can't decode {os.path.basename(path)}: install PyAV (pip install av) "
        "or put ffmpeg on PATH."
    )


# Long-edge caps for reference video. The native H3 node rescales every
# reference to the generation's pixel area anyway, so decoding above this
# spends RAM on detail the model never sees.
# No default cap: a clip is decoded at its own resolution unless its size is
# set in the trim editor. Nothing here resizes media the user didn't ask to
# have resized.


def _scaled_size(w, h, cap):
    """Target size for a long-edge cap, even numbers, never upscaling."""
    if not cap or not w or not h or max(w, h) <= cap:
        return None
    scale = cap / float(max(w, h))
    nw = max(16, int(round(w * scale / 2)) * 2)
    nh = max(16, int(round(h * scale / 2)) * 2)
    return nw, nh


def _frames_to_tensor(frames):
    """[uint8 HxWx3, ...] -> float32 [N, H, W, 3] in 0..1.

    Fills one preallocated buffer and releases each source frame as it goes.
    The obvious `np.stack(x).astype(np.float32) / 255` costs three arrays at
    once (uint8 stack, float copy, divided copy) — on a 1080p clip that is
    gigabytes of avoidable peak.
    """
    if not frames:
        raise RuntimeError("no frames to convert")
    h, w, c = frames[0].shape
    out = np.empty((len(frames), h, w, c), dtype=np.float32)
    for i in range(len(frames)):
        np.divide(frames[i], 255.0, out=out[i])
        frames[i] = None          # drop the uint8 frame immediately
    return torch.from_numpy(out)


def _frames_via_av(path, fps, max_frames, start=None, end=None, cap=0):
    """Sample frames on the target-fps time grid using frame timestamps.

    Timestamp-based sampling handles variable-frame-rate sources correctly
    (index-based stepping does not), and trims decode from the nearest
    keyframe rather than reading the whole file.
    """
    import av

    t0 = float(start or 0.0)
    out = []
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        target = _scaled_size(stream.codec_context.width,
                              stream.codec_context.height, cap)
        if t0 > 0:
            # Lands on the keyframe at or before t0; frames before t0 are
            # decoded (they must be, for reference frames) but not kept.
            container.seek(int(t0 / stream.time_base), stream=stream,
                           backward=True, any_frame=False)
        grid = 1.0 / float(fps)
        want = t0
        for frame in container.decode(stream):
            t = frame.time
            if t is None:
                continue
            if end is not None and t > end + grid / 2:
                break
            if t < want - grid / 2:
                continue
            # Scale inside the decoder: the full-size frame is never turned
            # into a numpy array, so peak memory follows the target size.
            out.append(frame.to_ndarray(format="rgb24", width=target[0],
                                        height=target[1])
                       if target else frame.to_ndarray(format="rgb24"))
            want += grid
            if max_frames and len(out) >= max_frames:
                break
    if not out:
        raise RuntimeError(
            "No video frames decoded"
            + (f" in {t0:.2f}-{end:.2f}s" if (start or end) else "") + ".")
    return _frames_to_tensor(out)


def _frames_via_ffmpeg(path, fps, max_frames, start=None, end=None, cap=0):
    exe = _ffmpeg()
    w, h = _dimensions(path)
    target = _scaled_size(w, h, cap)
    if target:
        w, h = target
    cmd = [exe, "-v", "error"]
    if start:
        cmd += ["-ss", f"{float(start):.3f}"]     # before -i: keyframe-fast seek
    cmd += ["-i", path]
    if end:
        span = float(end) - float(start or 0.0)
        if span <= 0:
            raise RuntimeError(f"Video trim {start}-{end}s selects nothing.")
        cmd += ["-t", f"{span:.3f}"]
    vf = f"fps={fps}"
    if target:
        vf += f",scale={target[0]}:{target[1]}:flags=lanczos"
    cmd += ["-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24"]
    if max_frames:
        cmd += ["-frames:v", str(int(max_frames))]
    cmd += ["-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    if not raw:
        raise RuntimeError(f"No video frames decoded from {os.path.basename(path)}.")
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3)
    # Convert in one pass into a preallocated buffer; astype() followed by a
    # division would hold two float copies of the whole clip at once.
    out = np.empty(arr.shape, dtype=np.float32)
    for i in range(arr.shape[0]):
        np.divide(arr[i], 255.0, out=out[i])
    del raw
    return torch.from_numpy(out)


def _dimensions(path):
    if _have_av():
        import av

        with av.open(path) as c:
            s = c.streams.video[0]
            return int(s.codec_context.width), int(s.codec_context.height)
    exe = _ffprobe()
    if not exe:
        raise RuntimeError("ffprobe not found; can't determine video dimensions.")
    out = subprocess.run(
        [exe, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True, check=True).stdout.strip()
    w, h = out.split("x")[:2]
    return int(w), int(h)


def extract_audio(annotated, start=None, end=None):
    """Pull the soundtrack out of a video file."""
    path = resolve(annotated)
    if _have_av():
        try:
            return _slice_audio(_audio_via_av(path), start, end)
        except Exception:
            pass
    return _slice_audio(_audio_via_ffmpeg(path), start, end)


def probe(annotated):
    """Duration / stream info shown on the node. Never raises."""
    path = resolve(annotated)
    info = {"duration": None, "has_audio": False, "width": None, "height": None}
    if not os.path.exists(path):
        return info
    if _have_av():
        try:
            import av

            with av.open(path) as c:
                if c.duration:
                    info["duration"] = round(c.duration / 1000000.0, 2)
                info["has_audio"] = len(c.streams.audio) > 0
                if c.streams.video:
                    s = c.streams.video[0]
                    info["width"] = int(s.codec_context.width)
                    info["height"] = int(s.codec_context.height)
            return info
        except Exception:
            pass
    exe = _ffprobe()
    if exe:
        try:
            out = subprocess.run(
                [exe, "-v", "error", "-show_entries",
                 "format=duration:stream=codec_type,width,height",
                 "-of", "default=nw=1", path],
                capture_output=True, text=True, check=True).stdout
            for line in out.splitlines():
                k, _, v = line.partition("=")
                if k == "duration" and v:
                    info["duration"] = round(float(v), 2)
                elif k == "codec_type" and v == "audio":
                    info["has_audio"] = True
                elif k == "width" and v and not info["width"]:
                    info["width"] = int(v)
                elif k == "height" and v and not info["height"]:
                    info["height"] = int(v)
        except Exception:
            pass
    return info
