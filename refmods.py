"""RefMod Stack: pick saved MiniMax H3 RefMods and emit one bundle.

RefMods are the `.safetensors` reference files written by Luisacaotica's
ComfyUI-MiniMaxH3Mod (and its forks). This module does two things:

* Lists what is on disk for the library browser — reading only the
  safetensors header, so the scan needs neither torch nor the other pack.
* Runs the stack node, which loads each pick through refmod_core (a small
  vendored copy of that pack's runtime) and returns an H3_REF_MODS bundle
  of (mod, strength) pairs — the same shape that pack's Apply, Text Encode,
  Step Curve and Inspect nodes consume, so the two can be mixed freely.
"""

import json
import ntpath
import os
import re
import struct
import sys

try:
    import folder_paths
except Exception:  # pragma: no cover - outside ComfyUI
    folder_paths = None

ORIGIN_LOADER = "MiniMaxH3RefModsLoader"      # a class ComfyUI-MiniMaxH3Mod registers
MAX_WEIGHT = 10.0
MAX_COPIES = 10
PREVIEW_EXT = (".png", ".jpg", ".jpeg", ".webp")
SKIP_DIRS = {"graph_presets", ".git", "__pycache__"}
# Both naming conventions for a look + voice pair saved as two files:
# the original's Master writes `<name>_visual` / `<name>_audio`, the
# H3RefMods fork writes `<name>_Video` / `<name>_Audio`.
PAIR_SUFFIX = {"_visual": "visual", "_Video": "visual",
               "_audio": "audio", "_Audio": "audio"}
KIND_LABEL = {"image": "Picture", "video": "Video", "audio": "Audio"}


# --------------------------------------------------------------------------
# The original pack, if it is loaded
# --------------------------------------------------------------------------

def origin_module():
    """ComfyUI-MiniMaxH3Mod's `nodes` module if that pack is loaded, found
    through a class it registers rather than its folder name. Only used to
    widen the library scan to its legacy folders; nothing here needs it."""
    try:
        import nodes as comfy_nodes
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(ORIGIN_LOADER)
    except Exception:
        cls = None
    if cls is None:
        return None
    return sys.modules.get(cls.__module__)


# models/refmods is registered as a folder type so extra_model_paths.yaml
# mappings apply; the same call the other pack makes, so both see one list.
if folder_paths is not None:
    try:
        folder_paths.add_model_folder_path(
            "refmods", os.path.join(folder_paths.models_dir, "refmods"))
    except Exception:
        pass


def search_dirs():
    """Directories RefMod names resolve against, in priority order: the
    registered `refmods` roots (extra_model_paths.yaml included), then the
    default models/refmods, then — when ComfyUI-MiniMaxH3Mod is loaded —
    the legacy user folders it also searches (not its bundled examples)."""
    dirs = []
    if folder_paths is not None:
        try:
            dirs += list(folder_paths.get_folder_paths("refmods"))
        except Exception:
            pass
        default = os.path.join(folder_paths.models_dir, "refmods")
        if default not in dirs:
            dirs.append(default)
    origin = origin_module()
    fn = getattr(origin, "_mod_search_dirs", None)
    if callable(fn):
        # Its other legacy folders hold user files and are kept; its own
        # bundled examples folder inside custom_nodes is not a library.
        own = os.path.realpath(os.path.dirname(getattr(origin, "__file__", "") or ""))
        try:
            for d in fn():
                if not d or d in dirs:
                    continue
                real = os.path.realpath(d)
                if own and (real == own or real.startswith(own + os.sep)):
                    continue
                dirs.append(d)
        except Exception:
            pass
    return dirs


# --------------------------------------------------------------------------
# Header reading (no torch)
# --------------------------------------------------------------------------

def _read_header(path):
    """(metadata dict, tensor table) from a safetensors file's header."""
    with open(path, "rb") as fh:
        n = struct.unpack("<Q", fh.read(8))[0]
        if n > (32 << 20):
            raise ValueError("header too large")
        header = json.loads(fh.read(n))
    tensors = dict(header)
    raw = tensors.pop("__metadata__", None) or {}
    meta = None
    for key in ("refmod_meta", "audio_refmod_meta"):
        if key in raw:
            try:
                meta = json.loads(raw[key])
            except Exception:
                meta = None
            break
    return meta, tensors


def read_meta(stem):
    """RefMod metadata for `<stem>.safetensors`, embedded or sidecar."""
    meta, tensors = None, {}
    try:
        meta, tensors = _read_header(stem + ".safetensors")
    except Exception:
        pass
    if not isinstance(meta, dict) and os.path.isfile(stem + ".json"):
        try:
            with open(stem + ".json", encoding="utf-8") as fh:
                meta = json.load(fh)
        except Exception:
            meta = None
    return (meta if isinstance(meta, dict) else None), tensors


def token_count(meta):
    kind = meta.get("kind")
    try:
        t = int(meta.get("latent_t", 0))
        h = int(meta.get("latent_h", 0))
        w = int(meta.get("latent_w", 0))
    except (TypeError, ValueError):
        return 0
    return 2 * t if kind == "audio" else t * (h // 2) * (w // 2)


# --------------------------------------------------------------------------
# Library scan
# --------------------------------------------------------------------------

_SCAN_KEY = None
_SCAN_VAL = None


def _preview_for(dirpath, stems):
    """First `<stem>.<image ext>` that exists, as a relative stem."""
    for stem in stems:
        for ext in PREVIEW_EXT:
            if os.path.isfile(os.path.join(dirpath, stem + ext)):
                return stem
    return None


def _split_pair(stem_base):
    """('hero', 'visual') for 'hero_visual'; (stem, None) otherwise."""
    for suffix, role in PAIR_SUFFIX.items():
        if stem_base.endswith(suffix) and len(stem_base) > len(suffix):
            return stem_base[:-len(suffix)], role
    return stem_base, None


def _channel(meta, rel, tensors):
    kind = meta.get("kind")
    ch = {"file": rel, "kind": kind, "tokens": token_count(meta)}
    try:
        t = int(meta.get("latent_t", 0))
    except (TypeError, ValueError):
        t = 0
    if kind == "audio":
        ch["seconds"] = round(t / 40.0, 2)          # 40 latent frames/second
    else:
        ch["t"] = t
        ch["h"] = int(meta.get("latent_h", 0) or 0)
        ch["w"] = int(meta.get("latent_w", 0) or 0)
        ch["mode"] = str(meta.get("mode", "") or "")
        ch["pool"] = str(meta.get("pool", "") or "")
        ch["steps"] = int(meta.get("optimize_steps", 0) or 0)
        ch["source"] = str(meta.get("source", "") or "")
        ch["source_shape"] = str(meta.get("source_shape", "") or "")
        # A fork "combined" file carries the voice inside the visual file.
        # The original pack's loader reads only `latent`, so that audio never
        # reaches the model — worth saying, not worth hiding the file.
        if "audio_latent" in tensors:
            ch["embedded_audio_ignored"] = True
    return ch


def scan_library():
    """Every RefMod under the search dirs, paired where two files belong
    together, with the cost and preview each card needs.

    The result is cached against a cheap stat signature of the tree, the
    same way the original pack caches its dropdown: a header read per file
    is fast, but a 1,500-file collection still should not be re-parsed on
    every keystroke in the browser."""
    global _SCAN_KEY, _SCAN_VAL
    dirs = search_dirs()
    sig, files = [], []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for root, subdirs, names in os.walk(d):
            subdirs[:] = sorted(s for s in subdirs
                                if s not in SKIP_DIRS and not s.startswith("."))
            for fn in sorted(names):
                if not fn.endswith(".safetensors"):
                    continue
                path = os.path.join(root, fn)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                sig.append((path, st.st_size, st.st_mtime_ns))
                files.append((d, root, fn[:-len(".safetensors")]))
    key = (tuple(dirs), tuple(sig))
    if key == _SCAN_KEY:
        return _SCAN_VAL

    # name -> channel record; first search dir wins, like the pack's loader
    seen = set()
    groups = {}            # (dir, relative folder, base) -> {"visual":..,"audio":..}
    order = []
    for d, root, base in files:
        rel_dir = os.path.relpath(root, d).replace("\\", "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        rel = f"{rel_dir}/{base}" if rel_dir else base
        if rel in seen:
            continue
        seen.add(rel)
        meta, tensors = read_meta(os.path.join(root, base))
        if not meta:
            continue
        refs = bundle_members(meta)
        if refs:
            # A single-file bundle from ComfyUI-MiniMaxH3Mod 0.2.6+: one card,
            # its first look and first voice as the channels. Members are
            # addressed as "<name>#<index>" and never pair with other files.
            g = groups[(d, rel_dir, base)] = {"root": root, "rel_dir": rel_dir, "base": base,
                                              "bundle": len(refs)}
            order.append((d, rel_dir, base))
            for i, m in enumerate(refs):
                want = "audio" if m.get("kind") == "audio" else "visual"
                if want in g:
                    continue
                ch = _channel(m, f"{rel}#{i}", {})
                ch["meta_name"] = str(m.get("name", "") or "")
                ch["desc"] = str(m.get("description", "") or meta.get("description", "") or "")
                ch["subject_name"] = str(m.get("subject_name", "") or meta.get("subject_name", "") or "")
                ch["appearance"] = str(m.get("appearance", "") or meta.get("appearance", "") or "")
                ch["voice_description"] = str(m.get("voice_description", "") or meta.get("voice_description", "") or "")
                ch["concept"] = str(m.get("concept_type", "generic") or "generic")
                ch["member"] = i
                g[want] = ch
            continue
        if meta.get("kind") not in KIND_LABEL:
            continue
        ch = _channel(meta, rel, tensors)
        ch["meta_name"] = str(meta.get("name", "") or "")
        ch["desc"] = str(meta.get("description", "") or "")
        ch["subject_name"] = str(meta.get("subject_name", "") or "")
        ch["appearance"] = str(meta.get("appearance", "") or "")
        ch["voice_description"] = str(meta.get("voice_description", "") or "")
        ch["concept"] = str(meta.get("concept_type", "generic") or "generic")
        want = "audio" if ch["kind"] == "audio" else "visual"
        pair_base, role = _split_pair(base)
        # A suffix only pairs when it matches the file's actual kind.
        if role != want:
            pair_base = base
        gkey = (d, rel_dir, pair_base)
        g = groups.get(gkey)
        if g is not None and want in g:
            # That half is already taken (hero_visual and hero_Video, say):
            # this file gets its own card rather than silently replacing it.
            pair_base = base
            gkey = (d, rel_dir, base)
            g = groups.get(gkey)
        if g is None:
            g = groups[gkey] = {"root": root, "rel_dir": rel_dir, "base": pair_base}
            order.append(gkey)
        g[want] = ch

    items = []
    for gkey in order:
        g = groups[gkey]
        vis, aud = g.get("visual"), g.get("audio")
        if not vis and not aud:
            continue
        rel_dir, base = g["rel_dir"], g["base"]
        name = f"{rel_dir}/{base}" if rel_dir else base
        stems = [base] + [os.path.basename(c["file"]) for c in (vis, aud) if c]
        preview = _preview_for(g["root"], stems)
        first = vis or aud
        mtime = 0
        for c in (vis, aud):
            if c:
                try:
                    fbase = os.path.basename(split_member(c["file"])[0])
                    mtime = max(mtime, int(os.stat(os.path.join(g["root"], fbase + ".safetensors")).st_mtime))
                except OSError:
                    pass
        item = {"mtime": mtime,
            "name": name, "label": base, "folder": rel_dir,
            "bundle": g.get("bundle", 0),
            "desc": first["desc"] or (aud["desc"] if aud else ""),
            "concept": first["concept"],
            "subject_name": first.get("subject_name") or (aud.get("subject_name", "") if aud else ""),
            "appearance": first.get("appearance") or (aud.get("appearance", "") if aud else ""),
            "voice_description": (aud.get("voice_description") if aud else "") or first.get("voice_description", ""),
            "preview": (f"{rel_dir}/{preview}" if rel_dir else preview) if preview else None,
            "paired": bool(vis and aud),
        }
        for c in (vis, aud):
            if c:
                for k in ("desc", "concept", "meta_name", "subject_name", "appearance", "voice_description"):
                    c.pop(k, None)
        if vis:
            item["visual"] = vis
        if aud:
            item["audio"] = aud
        items.append(item)
    items.sort(key=lambda i: (i["folder"].lower(), i["label"].lower()))
    _SCAN_KEY, _SCAN_VAL = key, {"roots": dirs, "items": items}
    return _SCAN_VAL


SUBJECT_NAME_RE = re.compile(r"^[A-Za-z][\w-]{0,39}$")


def clean_subject_name(value):
    """A RefMod's subject name, as the prompt builder uses it for !Name: one
    word of letters, digits, - and _, up to 40 characters. Empty clears it."""
    name = str(value or "").strip()
    if name and not SUBJECT_NAME_RE.match(name):
        raise ValueError("A subject name is one word: letters, digits, - and _ (up to 40), starting with a letter.")
    return name


DESCRIPTION_LIMIT = 300


def clean_description(value, what="description"):
    """Appearance or voice wording the prompt builder drafts into a definition
    line: one line (a line break reads to the model as a shot cut), no
    trailing full stop, up to DESCRIPTION_LIMIT characters. Empty clears it."""
    text = " ".join(str(value or "").split()).rstrip(" .")
    if len(text) > DESCRIPTION_LIMIT:
        raise ValueError(f"Keep the {what} under {DESCRIPTION_LIMIT} characters.")
    return text


def split_member(rel):
    """('hero', 2) for 'hero#2' — a member inside a single-file bundle
    (ComfyUI-MiniMaxH3Mod's format version 5); ('hero', None) otherwise."""
    rel = (rel or "").replace("\\", "/")
    base, sep, idx = rel.rpartition("#")
    if sep and idx.isdigit() and base:
        return base, int(idx)
    return rel, None


def bundle_members(meta):
    """The member metadata list of a bundle header, or [] for a plain file."""
    if not isinstance(meta, dict) or meta.get("kind") != "bundle":
        return []
    refs = meta.get("members")
    if not isinstance(refs, list) or not refs or len(refs) > 256:
        return []
    return [m for m in refs if isinstance(m, dict) and m.get("kind") in KIND_LABEL]


def resolve_file(rel, exts):
    """Absolute path of `<rel>.<ext>` inside one of the search dirs, or None.
    A '#i' member suffix is ignored here: the file is what gets resolved.

    Same containment test the pack's loader applies: relative names only,
    realpath inside the root, so a crafted name cannot read outside."""
    rel, _member = split_member(rel)
    if (not rel or ntpath.splitdrive(rel)[0] or rel.startswith("/")
            or any(p in ("..", "") or p in SKIP_DIRS for p in rel.split("/"))):
        return None
    for d in search_dirs():
        root = os.path.realpath(d)
        for ext in exts:
            target = os.path.realpath(os.path.join(d, rel + ext))
            try:
                if os.path.commonpath((root, target)) != root:
                    continue
            except ValueError:
                continue
            if os.path.isfile(target):
                return target
    return None


# --------------------------------------------------------------------------
# Weights
# --------------------------------------------------------------------------

def expand_weight(w):
    """A single weight into per-entry strengths: 2.7 -> [1, 1, 0.7].

    Up to 1 is plain strength. Above 1, each whole unit is a full-strength
    copy and the remainder a weaker last copy — the H3RefMods fork's
    convention, kept so the readout means the same thing in both packs."""
    try:
        w = float(w)
    except (TypeError, ValueError):
        return []
    if not (w > 0):
        return []
    w = min(MAX_WEIGHT, w)
    whole = int(w + 1e-9)
    rem = round(w - whole, 4)
    out = [1.0] * whole
    if rem > 1e-6:
        out.append(rem)
    return out


def channel_strengths(ch):
    """Per-entry strengths for one channel record from the stack state."""
    if not isinstance(ch, dict):
        return []
    if ch.get("mode") == "sc":
        try:
            s = float(ch.get("s", 1.0))
            c = int(ch.get("c", 1))
        except (TypeError, ValueError):
            return []
        if not (s > 0):
            return []
        return [min(1.0, s)] * max(1, min(MAX_COPIES, c))
    return expand_weight(ch.get("w", 1.0))


def parse_state(stack_state):
    try:
        state = json.loads(stack_state or "{}")
    except Exception:
        raise ValueError("RefMod Stack state is corrupt; clear the node and pick again.")
    if isinstance(state, list):           # tolerate a bare picks array
        state = {"picks": state}
    if not isinstance(state, dict):
        raise ValueError("RefMod Stack state is corrupt; clear the node and pick again.")
    picks = state.get("picks") or []
    if not isinstance(picks, list):
        raise ValueError("RefMod Stack state is corrupt; clear the node and pick again.")
    try:
        budget = int(state.get("budget", 0) or 0)
    except (TypeError, ValueError):
        budget = 0
    return picks, max(0, budget)


def pick_channels(pick):
    """[(file, strengths)] for one pick, in send order: look, then voice."""
    if not isinstance(pick, dict) or pick.get("on") is False:
        return []
    out = []
    for key in ("visual", "audio"):
        ch = pick.get(key)
        if not isinstance(ch, dict) or not ch.get("file"):
            continue
        strengths = channel_strengths(ch)
        if strengths:
            out.append((str(ch["file"]), strengths))
    return out


def label_lines(rows):
    """What H3 RefMod Text Encode will call each entry: one counter per
    kind, in bundle order, every copy numbered. Consecutive entries of the
    same file collapse to a range so three copies read as one line."""
    counters = {"image": 0, "video": 0, "audio": 0}
    lines = []
    for mod, strength in rows:
        if not (strength > 0):
            continue
        kind = getattr(mod, "kind", None)
        if kind not in counters:
            continue
        counters[kind] += 1
        n = counters[kind]
        name = getattr(mod, "name", "?")
        if lines and lines[-1][0] is mod:
            lines[-1][3] = n
        else:
            lines.append([mod, kind, n, n, name])
    out = []
    for _mod, kind, a, b, name in lines:
        label = KIND_LABEL[kind]
        tag = f"<{label} {a}>" if a == b else f"<{label} {a}–{b}>"
        extra = "" if a == b else f"  ({b - a} {'copy' if b - a == 1 else 'copies'})"
        out.append(f"{tag} = {name}{extra}")
    return "\n".join(out) or "No active RefMods."


# --------------------------------------------------------------------------
# The node
# --------------------------------------------------------------------------

class MiniMaxH3RefModStack:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Pick saved RefMods from a thumbnail library and send them as one "
        "bundle. Each pick has a weight per channel (look and voice): up to 1 "
        "is strength, above 1 adds copies. Wire 'mods' to Fantastic H3 RefMod "
        "Text Encode or Apply (or ComfyUI-MiniMaxH3Mod's, which share the "
        "bundle type). 'labels' lists the <Picture n> / <Video n> / <Audio n> "
        "names Text Encode will assign. RefMod files are created with "
        "ComfyUI-MiniMaxH3Mod."
    )
    RETURN_TYPES = ("H3_REF_MODS", "STRING")
    RETURN_NAMES = ("mods", "labels")
    FUNCTION = "load"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # JSON written by the node's panel. Single-line for the same
                # reason as the Media Loader's media_state.
                "stack_state": ("STRING", {"multiline": False, "default": "{}"}),
            },
            "optional": {
                "mods": ("H3_REF_MODS", {
                    "tooltip": "Another stack or loader to append to. Its "
                               "entries come first, so their labels keep "
                               "their numbers."}),
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, stack_state="{}"):
        # Named parameter only: a **kwargs validator switches off ComfyUI's
        # own min/max checks for the node's other inputs.
        try:
            picks, _budget = parse_state(stack_state)
        except ValueError as exc:
            return str(exc)
        for pick in picks:
            for file, _s in pick_channels(pick):
                if resolve_file(file, (".safetensors",)) is None:
                    return (f"RefMod '{file}' was not found under models/refmods. "
                            "Open the library and pick it again.")
        return True

    @classmethod
    def IS_CHANGED(cls, stack_state="{}", **kwargs):
        # Re-run when a pick changes or a picked file is rewritten on disk.
        stamps = [stack_state]
        try:
            picks, _b = parse_state(stack_state)
            for pick in picks:
                for file, _s in pick_channels(pick):
                    path = resolve_file(file, (".safetensors",))
                    try:
                        st = os.stat(path) if path else None
                        stamps.append((file, st.st_size, st.st_mtime_ns) if st else (file, None))
                    except OSError:
                        stamps.append((file, None))
        except Exception:
            pass
        return json.dumps(stamps, default=str)

    def load(self, stack_state="{}", mods=None):
        from .refmod_core import load_cached, check_bundle
        picks, budget = parse_state(stack_state)

        rows = list(check_bundle(mods, "RefMod Stack"))
        summary = []
        for pick in picks:
            for file, strengths in pick_channels(pick):
                path = resolve_file(file, (".safetensors",))
                if not path:
                    raise FileNotFoundError(
                        f"RefMod '{file}' was not found under models/refmods. "
                        "Open the library and pick it again.")
                mod = load_cached(path[:-len(".safetensors")], split_member(file)[1])
                rows.extend((mod, s) for s in strengths)
                whole = sum(1 for s in strengths if s >= 1.0)
                tail = [s for s in strengths if s < 1.0]
                shape = (f"x{whole}" if whole else "") + \
                        (f"{' + ' if whole else ''}{tail[0]:.2f}" if tail else "")
                summary.append(f"{mod.name}@{shape}")

        total = sum(getattr(m, "token_count", 0) for m, s in rows if s > 0)
        if budget and total > budget:
            raise ValueError(
                f"RefMods require {total} tokens after copies; the stack's limit is "
                f"{budget}. Lower a weight, drop a pick, or raise the limit.")

        labels = label_lines(rows)
        upstream = len(mods) if mods else 0
        print("[MiniMaxH3RefModStack] " + (", ".join(summary) or "nothing picked")
              + f" ({total} tokens total"
              + (f", {upstream} upstream entries first)" if upstream else ")"))
        return (rows, labels)


NODE_CLASS_MAPPINGS = {"MiniMaxH3RefModStack": MiniMaxH3RefModStack}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3RefModStack": "Fantastic H3 RefMod Stack"}


# --------------------------------------------------------------------------
# Names and curation (rename / describe / delete / preview)
# --------------------------------------------------------------------------

_NAME_OK = re.compile(r"[^A-Za-z0-9._ +()\-]+")


def sanitize_name(text, folder=False):
    """A file-safe stem (or `a/b` folder path when folder=True)."""
    text = str(text or "").replace("\\", "/").strip()
    parts = [p for p in text.split("/")] if folder else [text]
    out = []
    for p in parts:
        p = _NAME_OK.sub("_", p).strip(" ._")
        if p:
            out.append(p[:120])
    return "/".join(out)


def valid_rel(rel):
    """Relative stem with no escape, no hidden or skipped folders."""
    rel = (rel or "").replace("\\", "/")
    if not rel or ntpath.splitdrive(rel)[0] or rel.startswith("/"):
        return False
    parts = rel.split("/")
    return all(p and p not in ("..", ".") and p not in SKIP_DIRS
               and not p.startswith(".") and not _NAME_OK.search(p) for p in parts)


def _root_of(path):
    """The search dir that contains `path`, or None."""
    real = os.path.realpath(path)
    for d in search_dirs():
        root = os.path.realpath(d)
        try:
            if os.path.commonpath((root, real)) == root:
                return d
        except ValueError:
            continue
    return None


def _contained_target(root, rel):
    target = os.path.join(root, rel)
    real_root, real_t = os.path.realpath(root), os.path.realpath(target)
    try:
        if os.path.commonpath((real_root, real_t)) != real_root:
            raise ValueError("target escapes the RefMod folder")
    except ValueError:
        raise ValueError("target escapes the RefMod folder")
    return target


def item_files(files, preview):
    """Resolve the stems a curation request names. Every one must exist
    inside a RefMod root; the preview may be absent."""
    stems = []
    for rel in files or []:
        path = resolve_file(rel, (".safetensors",))
        if not path:
            raise FileNotFoundError(f"RefMod '{rel}' not found")
        rel = split_member(rel)[0].replace("\\", "/")
        if any(p == path[:-len(".safetensors")] for _r, p in stems):
            continue                       # a bundle's members share one file
        stems.append((rel, path[:-len(".safetensors")]))
    if not stems:
        raise ValueError("no files named")
    pv = None
    if preview:
        p = resolve_file(preview, PREVIEW_EXT)
        if p:
            pv = (preview.replace("\\", "/"), p)
    return stems, pv


def rename_item(files, preview, new_base):
    """Move an item to `new_base` (relative stem, folders allowed), keeping
    each file's pair suffix. Returns {old rel: new rel}."""
    new_base = sanitize_name(new_base, folder=True)
    if not valid_rel(new_base):
        raise ValueError("that name is not allowed")
    stems, pv = item_files(files, preview)
    root = _root_of(stems[0][1])
    if root is None:
        raise ValueError("file is outside every RefMod folder")
    moves = []
    for rel, path in stems:
        base = os.path.basename(rel)
        _pair, role = _split_pair(base)
        suffix = base[len(_pair):] if role else ""
        new_rel = new_base + suffix
        moves.append((rel, path, new_rel, _contained_target(root, new_rel)))
    for _rel, _path, new_rel, target in moves:
        if os.path.exists(target + ".safetensors") and os.path.realpath(target) not in {os.path.realpath(p) for _r, p in stems}:
            raise FileExistsError(f"'{new_rel}' already exists")
    out = {}
    for rel, path, new_rel, target in moves:
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        os.replace(path + ".safetensors", target + ".safetensors")
        if os.path.isfile(path + ".json"):
            os.replace(path + ".json", target + ".json")
        # a preview named after this half moves with it
        for ext in PREVIEW_EXT:
            if os.path.isfile(path + ext):
                os.replace(path + ext, target + ext)
        out[rel] = new_rel
    if pv and os.path.isfile(pv[1]):          # a preview named after the pair base
        ext = os.path.splitext(pv[1])[1]
        target = _contained_target(root, new_base)
        os.replace(pv[1], target + ext)
    return out


def rewrite_meta(files, **fields):
    """Rewrite the header of each file with new description / concept_type."""
    stems, _pv = item_files(files, None)
    for rel, path in stems:
        rewrite_stem_meta(path, label=rel, **fields)


def rewrite_stem_meta(path, label="", **fields):
    """Rewrite one RefMod's header fields in place; the tensors are copied as
    they are. `path` is a stem already resolved inside a RefMod root."""
    import torch  # noqa: F401  (safetensors.torch needs it)
    from safetensors.torch import load_file, save_file
    import tempfile
    if _root_of(path + ".safetensors") is None:
        raise ValueError("refusing to write outside the RefMod folders")
    meta, _t = read_meta(path)
    if not meta:
        raise ValueError(f"{label or os.path.basename(path)}: no RefMod metadata")
    for k, v in fields.items():
        if v is not None:
            meta[k] = v
            for m in bundle_members(meta):
                m[k] = v
    tensors = load_file(path + ".safetensors")
    tensors = {k: v.clone() for k, v in tensors.items()}
    fd, tmp = tempfile.mkstemp(prefix=".refmod-", suffix=".tmp", dir=os.path.dirname(path))
    os.close(fd)
    try:
        save_file(tensors, tmp, metadata={"refmod_meta": json.dumps(meta)})
        os.replace(tmp, path + ".safetensors")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    if os.path.isfile(path + ".json"):
        os.remove(path + ".json")         # the header is authoritative now


def delete_item(files, preview):
    stems, pv = item_files(files, preview)
    removed = []
    for rel, path in stems:
        if _root_of(path) is None:            # re-assert beside the remove
            raise ValueError("refusing to delete outside the RefMod folders")
        for ext in (".safetensors", ".json") + PREVIEW_EXT:
            if os.path.isfile(path + ext):
                os.remove(path + ext)
                removed.append(rel + ext)
    if pv and os.path.isfile(pv[1]) and _root_of(pv[1]) is not None:
        os.remove(pv[1])
        removed.append(pv[0])
    return removed


def set_preview(stem_rel, data):
    """Save uploaded image bytes as <stem>.png, replacing other previews."""
    from PIL import Image
    import io
    stem_rel = (stem_rel or "").replace("\\", "/")
    if not valid_rel(stem_rel):
        raise ValueError("bad preview name")
    anchor = resolve_file(stem_rel, (".safetensors",)) or \
        resolve_file(stem_rel + "_visual", (".safetensors",)) or \
        resolve_file(stem_rel + "_audio", (".safetensors",)) or \
        resolve_file(stem_rel + "_Video", (".safetensors",)) or \
        resolve_file(stem_rel + "_Audio", (".safetensors",))
    if not anchor:
        raise FileNotFoundError("no RefMod with that name")
    root = _root_of(anchor)
    target = _contained_target(root, stem_rel)
    im = Image.open(io.BytesIO(data))
    im = im.convert("RGB")
    im.thumbnail((512, 512))
    for ext in PREVIEW_EXT:
        if ext != ".png" and os.path.isfile(target + ext):
            os.remove(target + ext)
    im.save(target + ".png", optimize=True)
    return stem_rel
