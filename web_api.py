"""HTTP routes backing the Media Loader's drag-drop and file picker."""

import hashlib
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


def _storage_base():
    """The user-data root every store hangs off: user dir, else output dir,
    else the pack dir (dev fallback — wiped on update, better than nothing)."""
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
    return base


def _preset_dir():
    """Presets live with the user's data so they survive extension updates."""
    base = _storage_base()
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "minimax_h3_presets")
    os.makedirs(path, exist_ok=True)
    return path


def _prompt_dir():
    base = _storage_base()
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "minimax_h3_prompts")
    os.makedirs(path, exist_ok=True)
    return path


def _pack_version():
    """Version from pyproject.toml, so the UI can report the running build.

    A bug report that says "1.5.4" is only useful if 1.5.4 means one thing;
    reading it from the file the registry publishes keeps them in step.
    """
    try:
        import tomllib
    except Exception:                       # Python < 3.11
        try:
            import tomli as tomllib
        except Exception:
            return "unknown"
    try:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "pyproject.toml")
        with open(path, "rb") as fh:
            return str(tomllib.load(fh)["project"]["version"])
    except Exception:
        return "unknown"


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


def _draft_dir():
    """Scratch drafts live beside the user libraries but in their own
    directory, so no listing route can ever surface them: the library and
    preset routes simply never look here. One JSON file holds every draft,
    keyed by a node-minted id — thousands of tiny files was the failure mode
    this avoids."""
    base = _storage_base()
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "minimax_h3_drafts")
    os.makedirs(path, exist_ok=True)
    return path


def _drafts_file():
    return os.path.join(_draft_dir(), "drafts.json")


DRAFT_CAP = 25          # LRU by updated stamp; abandoned drafts fall off

# Fields that describe the reference set itself. Anything outside this list —
# uid (per-session identity), learned dimensions, cached probe data — must not
# make two otherwise-identical sets look different.
def _canonical_items(items):
    """The comparable shape of a media set, order preserved because
    reference numbering is positional.

    Compares EFFECTIVE values, not literal ones. A field that is absent and
    a field that holds its default describe the same reference set, and the
    two turn up on opposite sides constantly: presets/load backfills
    audio_mode and probe data into items whose stored form never had them,
    so a freshly loaded preset would otherwise never match the file it came
    from — every load reported itself as edited."""
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        row = {"kind": it.get("kind"), "file": it.get("file"),
               "name": it.get("name") or it.get("file")}
        # Absent means on; only "enabled": false switches an item off.
        row["enabled"] = it.get("enabled") is not False
        # nodes.py reads a missing audio_mode as "paired"; so must this.
        if it.get("kind") == "video":
            row["audio_mode"] = it.get("audio_mode") or "paired"
        # Empty edits are the same as no edits.
        for k in ("trim", "crop", "size"):
            v = it.get(k)
            if v:
                row[k] = v
        for k in ("rotate", "mirror"):
            v = it.get(k)
            if v:
                row[k] = v
        out.append(row)
    return out


def _set_digest(items):
    blob = json.dumps(_canonical_items(items), sort_keys=True,
                      separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _read_drafts():
    try:
        with open(_drafts_file(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("drafts"), dict):
            return data
    except Exception:
        pass
    return {"contract": 1, "drafts": {}}


def _write_json(path, record):
    """Write via a sibling tmp file: a crash mid-write must not corrupt the
    file, because the readers treat corrupt JSON as "no entry" and the prompt
    or preset silently vanishes from its list."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=1)
    os.replace(tmp, path)


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

    @routes.post("/minimax_h3/bake")
    async def bake(request):
        """Write a resized copy of a picture and hand back the new file.

        Explicit only: nothing calls this on upload or on render. The source
        file is left exactly as it was — the copy is a new entry in the input
        folder, so the original stays usable elsewhere.
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)

        annotated = str(body.get("file") or "")
        try:
            cap = int(body.get("resize") or 0)
        except (TypeError, ValueError):
            cap = 0
        if not annotated:
            return web.json_response({"error": "no file given"}, status=400)
        has_edit = bool(body.get("crop") or body.get("mirror")
                        or int(body.get("rotate") or 0) % 360)
        if cap <= 0 and not has_edit:
            return web.json_response(
                {"error": "nothing to write: set a size, crop, rotation or "
                          "mirror first"}, status=400)

        try:
            from PIL import Image, ImageOps

            path = media_io.resolve(annotated)
            img = Image.open(path)
            img = ImageOps.exif_transpose(img).convert("RGB")
            was = img.size
            turn = int(body.get("rotate") or 0) % 360
            if turn in (90, 180, 270):
                img = img.rotate(-turn, expand=True)
            if body.get("mirror"):
                img = ImageOps.mirror(img)
            crop = body.get("crop")
            if isinstance(crop, dict):
                W, H = img.size
                x0 = max(0, min(W - 16, int(round(float(crop.get("x", 0)) * W))))
                y0 = max(0, min(H - 16, int(round(float(crop.get("y", 0)) * H))))
                x1 = min(W, max(x0 + 16,
                         int(round((float(crop.get("x", 0)) + float(crop.get("w", 1))) * W))))
                y1 = min(H, max(y0 + 16,
                         int(round((float(crop.get("y", 0)) + float(crop.get("h", 1))) * H))))
                if (x0, y0, x1, y1) != (0, 0, W, H):
                    img = img.crop((x0, y0, x1, y1))
            w, h = img.size
            # cap == 0 means "no size cap" — a crop-only copy. Without the
            # cap > 0 test the scale factor became 0 and every copy came out
            # as the 16px floor.
            if cap > 0 and max(w, h) > cap:
                k = cap / float(max(w, h))
                img = img.resize((max(16, int(round(w * k))),
                                  max(16, int(round(h * k)))), Image.LANCZOS)
        except Exception as exc:
            return web.json_response({"error": f"couldn't read that picture: {exc}"},
                                     status=400)

        base = os.path.splitext(os.path.basename(annotated.split(" [")[0]))[0]
        name = _unique(_target_dir(), _safe(f"{base}_{img.size[0]}x{img.size[1]}.png"))
        out_path = os.path.join(_target_dir(), name)
        try:
            img.save(out_path, "PNG")
        except Exception as exc:
            if os.path.exists(out_path):
                os.remove(out_path)
            return web.json_response({"error": f"couldn't write: {exc}"}, status=500)

        out = f"{SUBFOLDER}/{name} [input]"
        print(f"[MiniMaxH3] baked {was[0]}x{was[1]} -> {img.size[0]}x{img.size[1]} "
              f"as {name}")
        return web.json_response({
            "file": out, "name": name,
            "width": img.size[0], "height": img.size[1],
            "was": [was[0], was[1]],
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
        caps["version"] = _pack_version()
        return web.json_response(caps)

    @routes.get("/minimax_h3/presets")
    async def list_presets(request):
        """Presets with their categories.

        Categories are a VIEW over one flat namespace, never folders: a
        prompt links to a preset by name and the filename is the name, so
        two presets sharing a name in different categories would collide on
        disk and make the link ambiguous. Same rule the prompt library
        follows."""
        entries, categories = [], set()
        base = _preset_dir()
        try:
            names = [f[:-5] for f in os.listdir(base) if f.endswith(".json")]
        except Exception:
            names = []
        for n in sorted(names, key=str.lower):
            data = _read_prompt(os.path.join(base, n + ".json")) or {}
            cat = (data.get("category") or "").strip()
            if cat:
                categories.add(cat)
            items = [i for i in (data.get("items") or []) if isinstance(i, dict)]
            entries.append({
                "name": n,
                "category": cat,
                "count": len(items),
                "counts": {k: sum(1 for i in items
                                  if i.get("kind") == k
                                  and i.get("enabled") is not False)
                           for k in ("picture", "video", "audio")},
            })
        return web.json_response({
            "presets": entries,
            # Kept so an older client (or a stale browser cache) still gets
            # a usable list rather than an empty picker.
            "names": [e["name"] for e in entries],
            "categories": sorted(categories, key=str.lower),
        })

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
        previous = _read_prompt(path) or {}
        # Absent category means "leave it alone" — re-saving a set from the
        # loader shouldn't silently strip the category someone filed it under.
        category = body.get("category")
        if category is None:
            category = previous.get("category") or ""
        record = {"version": 1, "items": items,
                  "category": str(category).strip()}
        try:
            _write_json(path, record)
        except Exception as exc:
            return web.json_response({"error": f"save failed: {exc}"}, status=500)
        return web.json_response({"name": name, "count": len(items),
                                  "category": record["category"]})

    @routes.post("/minimax_h3/presets/meta")
    async def preset_meta(request):
        """Set one preset's category without touching its items.

        Without this the only way to file an existing preset is to load it
        and save it again, which is a lot of ceremony for a label — and it
        rewrites the items, so it can't be done safely from a picker."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        name, path = _preset_path(body.get("name"))
        if not path or not os.path.exists(path):
            return web.json_response({"error": "preset not found"}, status=404)
        data = _read_prompt(path)
        if not data:
            return web.json_response({"error": "preset unreadable"}, status=500)
        data["category"] = str(body.get("category") or "").strip()
        try:
            _write_json(path, data)
        except Exception as exc:
            return web.json_response({"error": f"save failed: {exc}"}, status=500)
        return web.json_response({"name": name, "category": data["category"]})

    @routes.post("/minimax_h3/presets/category")
    async def preset_category(request):
        """Rename a category across every preset, or clear it (to = "")."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        src_cat = (body.get("from") or "").strip()
        dst_cat = (body.get("to") or "").strip()
        if not src_cat:
            return web.json_response({"error": "missing category"}, status=400)
        base = _preset_dir()
        changed = 0
        try:
            names = [f[:-5] for f in os.listdir(base) if f.endswith(".json")]
        except Exception:
            names = []
        for n in names:
            p = os.path.join(base, n + ".json")
            data = _read_prompt(p)
            if not data or (data.get("category") or "").strip() != src_cat:
                continue
            data["category"] = dst_cat
            try:
                _write_json(p, data)
                changed += 1
            except Exception:
                pass
        return web.json_response({"changed": changed})

    @routes.post("/minimax_h3/presets/match")
    async def match_preset(request):
        """Which saved preset, if any, IS this media set?

        Asked server-side on purpose: the client would otherwise need its own
        digest implementation that has to agree with this one forever, and
        that kind of cross-language parity is where silent drift lives."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "expected JSON body"}, status=400)
        items = body.get("items")
        if not isinstance(items, list):
            return web.json_response({"error": "items must be a list"}, status=400)
        want = _set_digest(items)
        base = _preset_dir()
        try:
            names = [f[:-5] for f in os.listdir(base) if f.endswith(".json")]
        except Exception:
            names = []
        for n in sorted(names, key=str.lower):
            data = _read_prompt(os.path.join(base, n + ".json")) or {}
            if _set_digest(data.get("items")) == want:
                return web.json_response({"name": n, "digest": want})
        return web.json_response({"name": None, "digest": want})

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
        # Presets saved before dimensions/duration were stored carry items
        # with no width/height — the panel then shows thumbnails with no
        # aspect data and leans on per-image learners to fill the gaps.
        # Heal the data here instead: probe never raises, and items that
        # already carry their metadata cost nothing.
        for item in kept:
            kind = item.get("kind")
            needs = (not item.get("width") or not item.get("height")
                     or (kind in ("video", "audio") and not item.get("duration"))
                     or (kind == "video" and "has_audio" not in item))
            if needs:
                info = media_io.probe(item["file"])
                if not item.get("width") and info.get("width"):
                    item["width"] = info["width"]
                if not item.get("height") and info.get("height"):
                    item["height"] = info["height"]
                if not item.get("duration") and info.get("duration"):
                    item["duration"] = info["duration"]
                if kind == "video" and "has_audio" not in item:
                    item["has_audio"] = bool(info.get("has_audio"))
            # nodes.py treats a missing audio_mode as "paired"; make that
            # explicit so every client-side count agrees with what is sent.
            if kind == "video" and item.get("has_audio") \
                    and not item.get("audio_mode"):
                item["audio_mode"] = "paired"
        return web.json_response({"name": name, "items": kept,
                                 "missing": missing,
                                 "category": (data.get("category") or "").strip(),
                                 "digest": _set_digest(items)})

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

    # -- drafts -----------------------------------------------------------
    # Scratch space for the editor's Draft mode. One file, a keyed map, an
    # LRU cap. The client never sends the whole map — each save replaces one
    # key server-side — so two tabs writing different drafts can't clobber
    # each other by holding stale copies.

    @routes.post("/minimax_h3/drafts/load")
    async def draft_load(request):
        body = await request.json()
        draft_id = str(body.get("id") or "").strip()
        if not draft_id:
            return web.json_response({"error": "missing draft id"}, status=400)
        entry = _read_drafts()["drafts"].get(draft_id)
        return web.json_response({"exists": entry is not None,
                                  "draft": entry})

    @routes.post("/minimax_h3/drafts/save")
    async def draft_save(request):
        body = await request.json()
        draft_id = str(body.get("id") or "").strip()
        if not draft_id:
            return web.json_response({"error": "missing draft id"}, status=400)
        payload = body.get("draft")
        data = _read_drafts()
        if not isinstance(payload, dict):
            # An empty payload is a clear — the no-empty-drafts rule lives
            # client-side, but honour the shape here too.
            data["drafts"].pop(draft_id, None)
        else:
            payload["updated"] = time.time()
            data["drafts"][draft_id] = payload
            if len(data["drafts"]) > DRAFT_CAP:
                keep = sorted(data["drafts"].items(),
                              key=lambda kv: kv[1].get("updated", 0),
                              reverse=True)[:DRAFT_CAP]
                data["drafts"] = dict(keep)
        try:
            _write_json(_drafts_file(), data)
        except Exception as exc:
            return web.json_response({"error": f"save failed: {exc}"},
                                     status=500)
        return web.json_response({"saved": bool(isinstance(payload, dict)),
                                  "count": len(data["drafts"])})

    @routes.get("/minimax_h3/drafts")
    async def draft_count(request):
        return web.json_response({"count": len(_read_drafts()["drafts"])})

    @routes.post("/minimax_h3/drafts/clear_all")
    async def draft_clear_all(request):
        data = _read_drafts()
        n = len(data["drafts"])
        data["drafts"] = {}
        try:
            _write_json(_drafts_file(), data)
        except Exception as exc:
            return web.json_response({"error": f"clear failed: {exc}"},
                                     status=500)
        return web.json_response({"cleared": n, "count": 0})

    @routes.post("/minimax_h3/drafts/clear")
    async def draft_clear(request):
        body = await request.json()
        draft_id = str(body.get("id") or "").strip()
        data = _read_drafts()
        existed = data["drafts"].pop(draft_id, None) is not None
        try:
            _write_json(_drafts_file(), data)
        except Exception as exc:
            return web.json_response({"error": f"clear failed: {exc}"},
                                     status=500)
        return web.json_response({"cleared": existed,
                                  "count": len(data["drafts"])})

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
        # Counts for linked presets, read fresh rather than stored on the
        # prompt: a preset edited after linking would otherwise show the
        # composition it had at link time, which is exactly the kind of
        # quietly-stale number this pack keeps getting bitten by. Each
        # distinct preset is read once per request.
        preset_counts = {}

        def counts_for(preset_name):
            if preset_name in preset_counts:
                return preset_counts[preset_name]
            out = None
            data = _read_prompt(os.path.join(_preset_dir(),
                                             _slug(preset_name) + ".json"))
            if data:
                items = [i for i in (data.get("items") or [])
                         if isinstance(i, dict) and i.get("enabled") is not False]
                out = {k: sum(1 for i in items if i.get("kind") == k)
                       for k in ("picture", "video", "audio")}
            preset_counts[preset_name] = out
            return out

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
                "media_preset": data.get("media_preset") or None,
                "media_counts": (counts_for(data["media_preset"])
                                 if data.get("media_preset") else None),
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
        # A save that believes it is creating a prompt must not quietly land
        # on an existing file: two names can slug to the same id, and a
        # colliding save used to overwrite the older prompt without a word.
        # The client resends without the flag once the user confirms.
        if body.get("expect_new") and os.path.exists(path):
            return web.json_response(
                {"error": f'a prompt named "{name or entry_id}" already exists',
                 "exists": True}, status=409)
        previous = _read_prompt(path) or {}
        record = {
            "version": 1,
            "name": name or entry_id,
            "category": (body.get("category") or "").strip(),
            "favorite": bool(body.get("favorite", previous.get("favorite"))),
            "mode": body.get("mode") or "",
            "refs": body.get("refs") or 0,
            # Optional link to a media preset, plus the digest of that preset
            # as it stood when linked. Reference tags are positional, so a
            # preset edited afterwards can silently retarget <Picture 3> —
            # the digest is what lets the load path say so.
            "media_preset": (body.get("media_preset") or "").strip() or None,
            "media_digest": (body.get("media_digest") or "").strip() or None,
            "prompt": body.get("prompt") or "",
            "state": body["state"],
            "created": previous.get("created") or time.time(),
            "updated": time.time(),
        }
        try:
            _write_json(path, record)
        except Exception as exc:
            return web.json_response({"error": f"save failed: {exc}"}, status=500)
        # Renaming writes a new file; drop the old one — but ONLY when the
        # client says this save IS a rename. Deleting on every name change
        # ate the loaded prompt whenever someone saved a variant under a new
        # name, which read as "the library is losing prompts".
        old = _slug(body.get("rename_from"))
        if body.get("rename") and old and old != entry_id:
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
            _write_json(path, data)
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
                _write_json(path, data)
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
