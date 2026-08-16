"""HTTP routes backing the Media Loader's drag-drop and file picker."""

import json
import os
import re
import time

from . import media_io

try:
    from server import PromptServer
    from aiohttp import web
except Exception:  # pragma: no cover - only outside ComfyUI
    PromptServer = None
    web = None

try:
    import folder_paths
except Exception:  # pragma: no cover
    folder_paths = None

SUBFOLDER = "minimax_h3"

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg"}
AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"}


def kind_for(name):
    ext = os.path.splitext(name)[1].lower()
    if ext in IMAGE_EXT:
        return "picture"
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return None


def _safe(name):
    name = os.path.basename(name or "")
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "upload"
    return name[:120]


def _target_dir():
    base = folder_paths.get_input_directory() if folder_paths else "input"
    path = os.path.join(base, SUBFOLDER)
    os.makedirs(path, exist_ok=True)
    return path


def _preset_dir():
    """Presets live with the user's data so they survive extension updates."""
    base = None
    if folder_paths is not None:
        for getter in ("get_user_directory", "get_output_directory"):
            fn = getattr(folder_paths, getter, None)
            if callable(fn):
                try:
                    base = fn()
                    break
                except Exception:
                    continue
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "minimax_h3_presets")
    os.makedirs(path, exist_ok=True)
    return path


def _prompt_dir():
    base = None
    if folder_paths is not None:
        for getter in ("get_user_directory", "get_output_directory"):
            fn = getattr(folder_paths, getter, None)
            if callable(fn):
                try:
                    base = fn()
                    break
                except Exception:
                    continue
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "minimax_h3_prompts")
    os.makedirs(path, exist_ok=True)
    return path


def _phrase_file():
    """One JSON file holding every saved phrase.

    Phrases are short and there may be many, so a single file beats a file
    each — unlike prompts, which are large and edited one at a time.
    """
    return os.path.join(os.path.dirname(_prompt_dir()), "minimax_h3_phrases.json")


def _read_phrases():
    try:
        with open(_phrase_file(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_phrases(items):
    path = _phrase_file()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)          # never leave a half-written library


def _slug(text):
    out = re.sub(r"[^A-Za-z0-9 ._-]+", "_", str(text or "")).strip(" ._-")
    return out[:80] or None


def _prompt_path(entry_id):
    slug = _slug(entry_id)
    if not slug:
        return None, None
    return slug, os.path.join(_prompt_dir(), slug + ".json")


def _read_prompt(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _preset_path(name):
    safe = re.sub(r"[^A-Za-z0-9 ._-]+", "_", str(name or "")).strip(" ._-")
    if not safe:
        return None, None
    return safe[:80], os.path.join(_preset_dir(), safe[:80] + ".json")


def _unique(directory, name):
    stem, ext = os.path.splitext(name)
    candidate = name
    if os.path.exists(os.path.join(directory, candidate)):
        candidate = f"{stem}_{int(time.time() * 1000) % 100000}{ext}"
    return candidate


if PromptServer is not None and web is not None:

    routes = PromptServer.instance.routes

    @routes.post("/minimax_h3/upload")
    async def upload(request):
        """Accept one file, store it under input/minimax_h3, return its metadata."""
        try:
            reader = await request.multipart()
        except Exception:
            return web.json_response({"error": "expected multipart form data"},
                                     status=400)
        field = await reader.next()
        while field is not None and field.name != "file":
            field = await reader.next()
        if field is None:
            return web.json_response({"error": "no file field in request"}, status=400)

        original = field.filename or "upload"
        kind = kind_for(original)
        if kind is None:
            return web.json_response(
                {"error": f"unsupported file type: {os.path.splitext(original)[1]}"},
                status=400)

        directory = _target_dir()
        name = _unique(directory, _safe(original))
        path = os.path.join(directory, name)
        size = 0
        try:
            with open(path, "wb") as fh:
                while True:
                    chunk = await field.read_chunk()
                    if not chunk:
                        break
                    size += len(chunk)
                    fh.write(chunk)
        except Exception as exc:
            if os.path.exists(path):
                os.remove(path)
            return web.json_response({"error": f"write failed: {exc}"}, status=500)

        annotated = f"{SUBFOLDER}/{name} [input]"
        info = media_io.probe(annotated) if kind in ("video", "audio") else {}
        return web.json_response({
            "file": annotated,
            "name": name,
            "original": original,
            "kind": kind,
            "size": size,
            "duration": info.get("duration"),
            "has_audio": bool(info.get("has_audio")),
            "width": info.get("width"),
            "height": info.get("height"),
        })

    @routes.post("/minimax_h3/extract_audio")
    async def extract_audio_route(request):
        """Write the trimmed audio of an existing item out as its own WAV.

        Decoding goes through media_io, so this inherits the same channel and
        scale handling as every other audio path in the pack.
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)

        annotated = str(body.get("file") or "")
        if not annotated:
            return web.json_response({"error": "no file given"}, status=400)
        try:
            start = float(body.get("start") or 0.0)
        except (TypeError, ValueError):
            start = 0.0
        end = body.get("end")
        try:
            end = float(end) if end is not None else None
        except (TypeError, ValueError):
            end = None

        kind = kind_for(annotated)
        try:
            if kind == "video":
                data = media_io.extract_audio(annotated, start=start, end=end)
            else:
                data = media_io.load_audio(annotated, start=start, end=end)
        except Exception as exc:
            return web.json_response(
                {"error": f"couldn't read audio from that clip: {exc}"}, status=400)

        wave = data.get("waveform")
        rate = int(data.get("sample_rate") or 0)
        if wave is None or not rate:
            return web.json_response({"error": "that clip has no audio"}, status=400)

        try:
            import numpy as np

            arr = wave.detach().cpu().numpy() if hasattr(wave, "detach") else wave
            arr = np.asarray(arr)
            while arr.ndim > 2:                 # [1, C, N] -> [C, N]
                arr = arr[0]
            if arr.ndim == 1:
                arr = arr[None, :]
            if arr.shape[1] == 0:
                return web.json_response({"error": "that range is empty"}, status=400)
            peak = float(np.abs(arr).max()) or 1.0
            if peak > 1.0:                      # belt and braces; media_io guards too
                arr = arr / peak
            pcm = (np.clip(arr, -1.0, 1.0) * 32767.0).astype("<i2")
            interleaved = pcm.T.reshape(-1)     # [C, N] -> L,R,L,R...
        except Exception as exc:
            return web.json_response({"error": f"conversion failed: {exc}"}, status=500)

        base = os.path.splitext(os.path.basename(annotated.split(" [")[0]))[0]
        span = f"{start:.2f}".replace(".", "-")
        directory = _target_dir()
        name = _unique(directory, _safe(f"{base}_audio_{span}s.wav"))
        path = os.path.join(directory, name)
        try:
            import wave as wavemod

            with wavemod.open(path, "wb") as fh:
                fh.setnchannels(int(arr.shape[0]))
                fh.setsampwidth(2)
                fh.setframerate(rate)
                fh.writeframes(interleaved.tobytes())
        except Exception as exc:
            if os.path.exists(path):
                os.remove(path)
            return web.json_response({"error": f"write failed: {exc}"}, status=500)

        out = f"{SUBFOLDER}/{name} [input]"
        info = media_io.probe(out)
        print(f"[MiniMaxH3] extracted audio -> {name} "
              f"({arr.shape[0]}ch {rate}Hz {arr.shape[1] / rate:.2f}s)")
        return web.json_response({
            "file": out, "name": name, "original": name, "kind": "audio",
            "duration": info.get("duration"), "has_audio": True,
        })

    def _output_root():
        if folder_paths is None:
            raise RuntimeError("folder_paths unavailable")
        return os.path.realpath(folder_paths.get_output_directory())

    def _safe_dir(rel):
        """Resolve a browser path, refusing anything outside the output dir."""
        root = _output_root()
        target = os.path.realpath(os.path.join(root, rel or ""))
        if target != root and not target.startswith(root + os.sep):
            return root, ""                     # escape attempt -> back to root
        if target == root:
            return root, ""
        return target, os.path.relpath(target, root).replace(os.sep, "/")

    @routes.get("/minimax_h3/browse")
    async def browse(request):
        """List folders under the output directory, for the folder picker."""
        rel = request.query.get("path", "")
        try:
            target, rel = _safe_dir(rel)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        dirs = []
        try:
            with os.scandir(target) as it:
                for entry in it:
                    if entry.is_dir() and not entry.name.startswith("."):
                        dirs.append(entry.name)
        except Exception as exc:
            return web.json_response({"error": f"unreadable: {exc}"}, status=500)
        dirs.sort(key=str.lower)
        return web.json_response({"path": "" if rel in (".", "") else rel,
                                  "dirs": dirs})

    @routes.post("/minimax_h3/mkdir")
    async def mkdir(request):
        """Create a folder from the picker, inside the output directory."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        name = re.sub(r"[^A-Za-z0-9 ._-]+", "_", str(body.get("name") or "")).strip()
        if not name:
            return web.json_response({"error": "give the folder a name"},
                                     status=400)
        try:
            parent, _ = _safe_dir(body.get("path", ""))
            path = os.path.realpath(os.path.join(parent, name))
            root = _output_root()
            if not path.startswith(root + os.sep):
                return web.json_response({"error": "outside the output folder"},
                                         status=400)
            os.makedirs(path, exist_ok=True)
        except Exception as exc:
            return web.json_response({"error": f"could not create: {exc}"},
                                     status=500)
        return web.json_response({"created": name})

    @routes.get("/minimax_h3/capabilities")
    async def capabilities(request):
        caps = media_io.backends()
        caps["video"] = media_io.can_decode_video()
        return web.json_response(caps)

    @routes.get("/minimax_h3/presets")
    async def list_presets(request):
        names = []
        try:
            for fn in os.listdir(_preset_dir()):
                if fn.endswith(".json"):
                    names.append(fn[:-5])
        except Exception:
            pass
        return web.json_response({"presets": sorted(names, key=str.lower)})

    @routes.post("/minimax_h3/presets/save")
    async def save_preset(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        name, path = _preset_path(body.get("name"))
        if not path:
            return web.json_response({"error": "give the preset a name"}, status=400)
        items = body.get("items")
        if not isinstance(items, list):
            return web.json_response({"error": "items must be a list"}, status=400)
        try:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"version": 1, "items": items}, fh, indent=1)
        except Exception as exc:
            return web.json_response({"error": f"save failed: {exc}"}, status=500)
        return web.json_response({"name": name, "count": len(items)})

    @routes.post("/minimax_h3/presets/load")
    async def load_preset(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        name, path = _preset_path(body.get("name"))
        if not path or not os.path.exists(path):
            return web.json_response({"error": "preset not found"}, status=404)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception as exc:
            return web.json_response({"error": f"unreadable preset: {exc}"},
                                     status=500)
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return web.json_response({"error": "preset has no item list"},
                                     status=500)
        # Report files that have since been deleted rather than failing later.
        kept, missing = [], []
        for item in items:
            target = item.get("file") if isinstance(item, dict) else None
            if target and os.path.exists(media_io.resolve(target)):
                kept.append(item)
            elif target:
                missing.append(item.get("name") or target)
        return web.json_response({"name": name, "items": kept, "missing": missing})

    @routes.post("/minimax_h3/presets/delete")
    async def delete_preset(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        name, path = _preset_path(body.get("name"))
        if not path or not os.path.exists(path):
            return web.json_response({"error": "preset not found"}, status=404)
        try:
            os.remove(path)
        except Exception as exc:
            return web.json_response({"error": f"delete failed: {exc}"}, status=500)
        return web.json_response({"deleted": name})

    # -- prompt library ---------------------------------------------------

    @routes.get("/minimax_h3/phrases")
    async def list_phrases(request):
        items = _read_phrases()
        cats = sorted({(i.get("category") or "").strip()
                       for i in items if (i.get("category") or "").strip()},
                      key=str.lower)
        return web.json_response({"phrases": items, "categories": cats})

    @routes.post("/minimax_h3/phrases/save")
    async def save_phrase(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        name = str(body.get("name") or "").strip()
        text = str(body.get("text") or "")
        if not name:
            return web.json_response({"error": "give the phrase a name"}, status=400)
        if not text.strip():
            return web.json_response({"error": "the phrase is empty"}, status=400)

        items = _read_phrases()
        entry = {
            "id": str(body.get("id") or "").strip() or f"p{int(time.time() * 1000)}",
            "name": name[:120],
            "category": str(body.get("category") or "").strip()[:80],
            "text": text,
            "updated": int(time.time()),
        }
        items = [i for i in items if i.get("id") != entry["id"]]
        items.append(entry)
        items.sort(key=lambda i: ((i.get("category") or "").lower(),
                                  (i.get("name") or "").lower()))
        try:
            _write_phrases(items)
        except Exception as exc:
            return web.json_response({"error": f"could not save: {exc}"}, status=500)
        return web.json_response({"saved": entry["id"]})

    @routes.post("/minimax_h3/phrases/delete")
    async def delete_phrase(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        pid = str(body.get("id") or "").strip()
        items = _read_phrases()
        keep = [i for i in items if i.get("id") != pid]
        if len(keep) == len(items):
            return web.json_response({"error": "no such phrase"}, status=404)
        try:
            _write_phrases(keep)
        except Exception as exc:
            return web.json_response({"error": f"could not delete: {exc}"}, status=500)
        return web.json_response({"deleted": pid})

    @routes.get("/minimax_h3/prompts")
    async def list_prompts(request):
        entries, categories = [], set()
        directory = _prompt_dir()
        try:
            names = [f for f in os.listdir(directory) if f.endswith(".json")]
        except Exception:
            names = []
        for fn in names:
            data = _read_prompt(os.path.join(directory, fn))
            if not data:
                continue
            category = (data.get("category") or "").strip()
            if category:
                categories.add(category)
            text = data.get("prompt") or ""
            entries.append({
                "id": fn[:-5],
                "name": data.get("name") or fn[:-5],
                "category": category,
                "favorite": bool(data.get("favorite")),
                "mode": data.get("mode") or "",
                "updated": data.get("updated") or 0,
                "refs": data.get("refs") or 0,
                "preview": " ".join(text.split())[:150],
            })
        entries.sort(key=lambda e: (not e["favorite"], -float(e["updated"] or 0),
                                    e["name"].lower()))
        return web.json_response({
            "prompts": entries,
            "categories": sorted(categories, key=str.lower),
        })

    @routes.post("/minimax_h3/prompts/save")
    async def save_prompt(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        name = (body.get("name") or "").strip()
        entry_id, path = _prompt_path(body.get("id") or name)
        if not path:
            return web.json_response({"error": "give the prompt a name"},
                                     status=400)
        if not isinstance(body.get("state"), dict):
            return web.json_response({"error": "missing editor state"}, status=400)
        previous = _read_prompt(path) or {}
        record = {
            "version": 1,
            "name": name or entry_id,
            "category": (body.get("category") or "").strip(),
            "favorite": bool(body.get("favorite", previous.get("favorite"))),
            "mode": body.get("mode") or "",
            "refs": body.get("refs") or 0,
            "prompt": body.get("prompt") or "",
            "state": body["state"],
            "created": previous.get("created") or time.time(),
            "updated": time.time(),
        }
        try:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(record, fh, indent=1)
        except Exception as exc:
            return web.json_response({"error": f"save failed: {exc}"}, status=500)
        # Renaming writes a new file; drop the old one.
        old = _slug(body.get("rename_from"))
        if old and old != entry_id:
            try:
                os.remove(os.path.join(_prompt_dir(), old + ".json"))
            except Exception:
                pass
        return web.json_response({"id": entry_id, "name": record["name"]})

    @routes.post("/minimax_h3/prompts/load")
    async def load_prompt(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        entry_id, path = _prompt_path(body.get("id"))
        data = _read_prompt(path) if path else None
        if not data:
            return web.json_response({"error": "prompt not found"}, status=404)
        return web.json_response({"id": entry_id, **data})

    @routes.post("/minimax_h3/prompts/meta")
    async def update_prompt_meta(request):
        """Toggle favourite or move to another category without a full save."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        entry_id, path = _prompt_path(body.get("id"))
        data = _read_prompt(path) if path else None
        if not data:
            return web.json_response({"error": "prompt not found"}, status=404)
        if "favorite" in body:
            data["favorite"] = bool(body["favorite"])
        if "category" in body:
            data["category"] = (body.get("category") or "").strip()
        data["updated"] = time.time()
        try:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=1)
        except Exception as exc:
            return web.json_response({"error": f"update failed: {exc}"}, status=500)
        return web.json_response({"id": entry_id, "favorite": data["favorite"],
                                  "category": data["category"]})

    @routes.post("/minimax_h3/prompts/category")
    async def rename_category(request):
        """Rename a category across every prompt, or clear it entirely."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        source = (body.get("from") or "").strip()
        target = (body.get("to") or "").strip()
        if not source:
            return web.json_response({"error": "missing category"}, status=400)
        directory = _prompt_dir()
        changed = 0
        try:
            names = [f for f in os.listdir(directory) if f.endswith(".json")]
        except Exception:
            names = []
        for fn in names:
            path = os.path.join(directory, fn)
            data = _read_prompt(path)
            if not data or (data.get("category") or "").strip() != source:
                continue
            data["category"] = target
            data["updated"] = time.time()
            try:
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, indent=1)
                changed += 1
            except Exception:
                pass
        return web.json_response({"from": source, "to": target, "changed": changed})

    @routes.post("/minimax_h3/prompts/delete")
    async def delete_prompt(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        entry_id, path = _prompt_path(body.get("id"))
        if not path or not os.path.exists(path):
            return web.json_response({"error": "prompt not found"}, status=404)
        try:
            os.remove(path)
        except Exception as exc:
            return web.json_response({"error": f"delete failed: {exc}"}, status=500)
        return web.json_response({"deleted": entry_id})

    @routes.post("/minimax_h3/probe")
    async def probe_route(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        target = body.get("file")
        if not target:
            return web.json_response({"error": "missing 'file'"}, status=400)
        return web.json_response(media_io.probe(target))
