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

def load_image(annotated):
    from PIL import Image, ImageOps

    path = resolve(annotated)
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")
    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]  # [1, H, W, 3]


# --- audio ------------------------------------------------------------------

def _to_audio_dict(waveform, sr):
    if waveform.ndim == 1:
        waveform = waveform[None, :]
    if waveform.ndim == 2:
        waveform = waveform[None, ...]  # [1, C, L]
    return {"waveform": waveform.float(), "sample_rate": int(sr)}


def load_audio(annotated):
    path = resolve(annotated)
    try:
        import torchaudio

        waveform, sr = torchaudio.load(path)
        return _to_audio_dict(waveform, sr)
    except Exception:
        pass
    return _audio_via_ffmpeg(path)


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

def load_video_frames(annotated, fps=FPS, max_frames=None):
    """Decode to an IMAGE batch [N, H, W, 3] resampled to `fps`."""
    path = resolve(annotated)
    if _have_av():
        try:
            return _frames_via_av(path, fps, max_frames)
        except Exception:
            pass
    if _ffmpeg():
        return _frames_via_ffmpeg(path, fps, max_frames)
    raise RuntimeError(
        f"Can't decode {os.path.basename(path)}: install PyAV (pip install av) "
        "or put ffmpeg on PATH."
    )


def _frames_via_av(path, fps, max_frames):
    import av

    out = []
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        src_fps = float(stream.average_rate or fps)
        step = max(1.0, src_fps / float(fps))
        nxt, i = 0.0, 0
        for frame in container.decode(stream):
            if i >= nxt:
                out.append(frame.to_ndarray(format="rgb24"))
                nxt += step
                if max_frames and len(out) >= max_frames:
                    break
            i += 1
    if not out:
        raise RuntimeError("No video frames decoded.")
    arr = np.stack(out).astype(np.float32) / 255.0
    return torch.from_numpy(arr)


def _frames_via_ffmpeg(path, fps, max_frames):
    exe = _ffmpeg()
    w, h = _dimensions(path)
    cmd = [exe, "-v", "error", "-i", path, "-vf", f"fps={fps}",
           "-f", "rawvideo", "-pix_fmt", "rgb24"]
    if max_frames:
        cmd += ["-frames:v", str(int(max_frames))]
    cmd += ["-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    if not raw:
        raise RuntimeError(f"No video frames decoded from {os.path.basename(path)}.")
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3)
    return torch.from_numpy(arr.astype(np.float32) / 255.0)


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


def extract_audio(annotated):
    """Pull the soundtrack out of a video file."""
    path = resolve(annotated)
    if _have_av():
        try:
            return _audio_via_av(path)
        except Exception:
            pass
    return _audio_via_ffmpeg(path)


def _audio_via_av(path):
    import av

    chunks = []
    sr = AUDIO_SR
    with av.open(path) as container:
        if not container.streams.audio:
            raise RuntimeError("no audio stream")
        stream = container.streams.audio[0]
        sr = int(stream.rate or AUDIO_SR)
        for frame in container.decode(stream):
            chunks.append(frame.to_ndarray())
    if not chunks:
        raise RuntimeError("no audio decoded")
    data = np.concatenate(chunks, axis=-1) if chunks[0].ndim > 1 else \
        np.concatenate(chunks)[None, :]
    if data.ndim == 1:
        data = data[None, :]
    if data.dtype != np.float32:
        info = np.iinfo(data.dtype) if np.issubdtype(data.dtype, np.integer) else None
        data = data.astype(np.float32) / (info.max if info else 1.0)
    return _to_audio_dict(torch.from_numpy(np.ascontiguousarray(data)), sr)


# --- probing for the UI -----------------------------------------------------

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
