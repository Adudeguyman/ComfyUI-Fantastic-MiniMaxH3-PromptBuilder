"""MiniMax H3 Prompt Builder
A guided prompt-composition node for the open-weight MiniMax H3 model
(FL2VA family: T2VA / I2VA / FL2VA / L2VA, and Ref2VA full-reference mode).

Outputs the final prompt STRING plus optional pass-throughs for every
reference slot, so the builder can sit inline between your loaders and
`MiniMaxH3ReferenceToVideo` and keep tag order locked to wiring order.
"""

import json
import os
import re
import time

from . import media_io

try:                       # available inside ComfyUI, absent in bare tests
    import folder_paths
except Exception:
    folder_paths = None

PICTURES = 9
VIDEOS = 3
VIDEO_AUDIOS = 3
AUDIOS = 3


# What each mode can actually consume. Base modes have no reference slots at
# all — their pictures are the native node's first_frame / last_frame.
MODE_LIMITS = {
    "T2VA": {"picture": 0, "video": 0, "video_audio": 0, "audio": 0},
    "I2VA": {"picture": 1, "video": 0, "video_audio": 0, "audio": 0},
    "FL2VA": {"picture": 2, "video": 0, "video_audio": 0, "audio": 0},
    "L2VA": {"picture": 1, "video": 0, "video_audio": 0, "audio": 0},
    "REF": {"picture": PICTURES, "video": VIDEOS,
            "video_audio": VIDEO_AUDIOS, "audio": AUDIOS},
}


def _split_name(name):
    """'video_audio_2' -> ('video_audio', 2)"""
    group, _, num = name.rpartition("_")
    try:
        return group, int(num)
    except ValueError:
        return group, 0


def _mode_of(builder_state):
    try:
        mode = json.loads(builder_state or "{}").get("mode")
    except Exception:
        mode = None
    return mode if mode in MODE_LIMITS else "REF"


def _usable(name, mode):
    group, index = _split_name(name)
    return index <= MODE_LIMITS.get(mode, MODE_LIMITS["REF"]).get(group, 0)


def _media_names():
    """Ordered media slot names; index in this list + 1 == output slot index.

    Mirrors the native node's four groups: ref_images, ref_videos,
    ref_video_audios (the soundtrack paired with the same-numbered video),
    and ref_audios (standalone).
    """
    return (
        [f"picture_{i}" for i in range(1, PICTURES + 1)]
        + [f"video_{i}" for i in range(1, VIDEOS + 1)]
        + [f"video_audio_{i}" for i in range(1, VIDEO_AUDIOS + 1)]
        + [f"audio_{i}" for i in range(1, AUDIOS + 1)]
    )


class MiniMaxH3PromptBuilder:
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Guided prompt builder for MiniMax H3 (T2VA / I2VA / FL2VA / L2VA / "
        "full-reference). Click 'Edit prompt' on the node to open the editor. "
        "Outputs the final prompt STRING plus a pass-through for every "
        "reference slot, so media can carry on to MiniMaxH3ReferenceToVideo. "
        "Each media output prefers its own input, falling back to the matching "
        "item from a connected Media Loader 'references' bundle."
    )

    RETURN_TYPES = (
        ("STRING",)
        + ("IMAGE",) * PICTURES
        + ("IMAGE",) * VIDEOS
        + ("AUDIO",) * VIDEO_AUDIOS
        + ("AUDIO",) * AUDIOS
        + ("H3_REFS",)
    )
    RETURN_NAMES = ("prompt",) + tuple(_media_names()) + ("references",)
    # references (slot 19) is the gated bundle passthrough: what this node's
    # individual outputs carry, reassembled for a Reference Splitter. Appended
    # last — inserting earlier would renumber slots in every saved workflow.
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, PICTURES + 1):
            optional[f"picture_{i}"] = ("IMAGE", {"lazy": True})
        for i in range(1, VIDEOS + 1):
            optional[f"video_{i}"] = ("IMAGE", {"lazy": True})
        for i in range(1, VIDEO_AUDIOS + 1):
            optional[f"video_audio_{i}"] = ("AUDIO", {"lazy": True})
        for i in range(1, AUDIOS + 1):
            optional[f"audio_{i}"] = ("AUDIO", {"lazy": True})
        return {
            "required": {
                # Final assembled prompt (written by the editor UI).
                # Deliberately single-line: multiline widgets become DOM
                # overlays in the new frontend and interfere with the node's
                # canvas button when hidden. The value itself may contain
                # newlines regardless of widget type.
                "prompt_text": ("STRING", {"multiline": False, "default": ""}),
                # Serialized editor state (JSON). Hidden in the UI.
                "builder_state": ("STRING", {"multiline": False, "default": "{}"}),
            },
            "optional": dict(
                references=("H3_REFS", {"lazy": True}), **optional
            ),
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    # -- graph introspection -------------------------------------------------

    @staticmethod
    def _linked_inputs(prompt, unique_id):
        """Names of this node's inputs that are actually connected."""
        try:
            inputs = prompt[str(unique_id)]["inputs"]
        except Exception:
            return None
        return {
            name
            for name, val in inputs.items()
            if isinstance(val, list) and len(val) == 2
        }

    @staticmethod
    @staticmethod
    def _iter_links(value):
        """Yield every [node_id, slot] link inside an input value.

        Plain inputs hold a bare link, but Autogrow inputs (as used by the
        native MiniMax H3 reference node) hold a dict of links, one per grown
        slot — so the scan has to recurse or those consumers are invisible.
        """
        if isinstance(value, list):
            if (len(value) == 2
                    and isinstance(value[0], (str, int))
                    and isinstance(value[1], int)
                    and not isinstance(value[1], bool)):
                yield value
            else:
                for item in value:
                    yield from MiniMaxH3PromptBuilder._iter_links(item)
        elif isinstance(value, dict):
            for item in value.values():
                yield from MiniMaxH3PromptBuilder._iter_links(item)

    @staticmethod
    def _consumed_slots(prompt, unique_id):
        """Output slot indices of this node that some other node reads."""
        if not isinstance(prompt, dict):
            return None
        uid = str(unique_id)
        slots = set()
        for nid, node in prompt.items():
            if str(nid) == uid or not isinstance(node, dict):
                continue
            for val in (node.get("inputs") or {}).values():
                for link in MiniMaxH3PromptBuilder._iter_links(val):
                    if str(link[0]) == uid:
                        slots.add(int(link[1]))
        return slots

    # -- execution -----------------------------------------------------------

    def check_lazy_status(
        self, prompt_text=None, builder_state=None, references=None,
        prompt=None, unique_id=None, **kwargs
    ):
        """Pull only what a downstream node actually reads.

        A media slot is evaluated when its pass-through output is consumed:
        from its own input if one is wired, otherwise from the references
        bundle. Media wired purely for editor previews stays free.
        """
        consumed = self._consumed_slots(prompt, unique_id)
        # If this node is executing, something downstream reads at least one
        # output — a scan that finds none has misread the graph (as happened
        # with nested Autogrow links). Fail open and evaluate what's wired
        # rather than silently starving every output.
        if consumed is not None and not consumed:
            consumed = None
        linked = self._linked_inputs(prompt, unique_id)
        mode = _mode_of(builder_state)
        needed = []
        want_bundle = False
        # Slot 19 is the bundle passthrough; if anything reads it, every
        # media input contributes and must be evaluated.
        ref_out = len(_media_names()) + 1
        all_media = consumed is not None and ref_out in consumed
        for idx, name in enumerate(_media_names()):
            slot = idx + 1  # slot 0 is the prompt string
            if consumed is not None and slot not in consumed and not all_media:
                continue
            if linked is None or name in linked:
                if kwargs.get(name) is None:
                    needed.append(name)
            elif linked is None or "references" in linked:
                want_bundle = True
        if want_bundle and references is None:
            needed.append("references")
        print(f"[MiniMaxH3 Builder] lazy: consumed slots="
              f"{sorted(consumed) if consumed is not None else 'unknown (evaluate all)'} "
              f"linked={sorted(linked) if linked else linked} -> requesting {needed or 'nothing'}")
        return needed

    @staticmethod
    def _from_bundle(references, name):
        """Matching item from a Media Loader bundle, if there is one."""
        if not isinstance(references, dict):
            return None
        group, _, num = name.rpartition("_")
        key = {
            "picture": "pictures", "video": "videos",
            "video_audio": "video_audios", "audio": "audios",
        }.get(group)
        seq = references.get(key) if key else None
        if not isinstance(seq, (list, tuple)):
            return None
        try:
            index = int(num) - 1
        except ValueError:
            return None
        return seq[index] if 0 <= index < len(seq) else None

    def build(
        self, prompt_text, builder_state, references=None,
        prompt=None, unique_id=None, **kwargs
    ):
        # The saved mode decides what the outputs carry. Mode and prompt are
        # written together by the editor's Save, so they can't disagree; if
        # the state is missing or unreadable, _mode_of falls back to REF and
        # the gate FAILS OPEN (everything passes). Withholding is always
        # printed, never silent — the two properties whose absence made the
        # original version of this gate dangerous.
        mode = _mode_of(builder_state)
        media, withheld = [], []
        for name in _media_names():
            value = kwargs.get(name)
            if value is None:
                value = self._from_bundle(references, name)
            if value is not None and not _usable(name, mode):
                withheld.append(name)
                value = None
            media.append(value)
        if withheld:
            print(
                f"[MiniMaxH3 PromptBuilder] mode {mode}: "
                f"{', '.join(withheld)} connected but not sent \u2014 this "
                "mode doesn't use them. Switch mode in the editor (and Save) "
                "to send them."
            )
        def _short(v):
            # Never index a tensor speculatively — type-check first.
            if isinstance(v, dict) and "waveform" in v:
                try:
                    w = v["waveform"]
                    return f"audio {list(w.shape)}@{v['sample_rate']}Hz " \
                           f"rms={float((w ** 2).mean() ** 0.5):.4f}"
                except Exception:
                    return "audio (unreadable)"
            try:
                return f"tensor {list(v.shape)}"
            except Exception:
                return type(v).__name__

        sent = [f"{n2}={_short(v)}" for n2, v in zip(_media_names(), media)
                if v is not None]
        print(f"[MiniMaxH3 Builder] mode={mode} references="
              f"{'yes' if references is not None else 'no'} -> "
              + ("; ".join(sent) if sent else
                 "NO media on any output — check the loader lines above"))
        a = PICTURES
        b = a + VIDEOS
        c = b + VIDEO_AUDIOS
        out_bundle = {
            "pictures": media[:a],
            "videos": media[a:b],
            "video_audios": media[b:c],
            "audios": media[c:],
        }
        return (prompt_text.strip(),) + tuple(media) + (out_bundle,)


class MiniMaxH3MediaLoader:
    """Drag-and-drop / file-picker loader for H3 reference media.

    Emits one `references` bundle for the Prompt Builder, plus individual
    pass-throughs so it can drive MiniMaxH3ReferenceToVideo on its own.
    """

    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Load MiniMax H3 reference media by drag-and-drop or file picker. "
        "Wire 'references' to the Prompt Builder, and to the Reference Splitter "
        "when you also want individual slots for MiniMaxH3ReferenceToVideo. "
        "A video's soundtrack can be split off and paired with it automatically."
    )

    RETURN_TYPES = ("H3_REFS",)
    RETURN_NAMES = ("references",)
    FUNCTION = "load"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # JSON list of media items, written by the node's panel.
                "media_state": ("STRING", {"multiline": False, "default": "[]"}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, media_state="[]", **kwargs):
        return media_state

    @classmethod
    def VALIDATE_INPUTS(cls, media_state="[]", **kwargs):
        try:
            items = json.loads(media_state or "[]")
        except Exception:
            return "Media Loader state is corrupt; clear the node and re-add media."
        if not isinstance(items, list):
            return "Media Loader state is corrupt; clear the node and re-add media."
        pics = sum(1 for i in items if i.get("kind") == "picture")
        vids = sum(1 for i in items if i.get("kind") == "video")
        if pics > PICTURES:
            return f"{pics} pictures loaded; H3 accepts {PICTURES}."
        if vids > VIDEOS:
            return f"{vids} videos loaded; H3 accepts {VIDEOS}."
        return True

    # -- ordering ---------------------------------------------------------

    @staticmethod
    def _partition(items):
        """Split items into the four native groups, preserving list order.

        A video's split audio goes to the paired group (its <Audio N> is
        emitted just before its <Video N>) or to the standalone group,
        depending on the item's audio_mode.
        """
        pictures, videos, video_audios, audios = [], [], [], []
        for item in items:
            # Items switched off in the loader are kept in the list but never
            # reach the model, so the tag numbering closes up around them.
            if isinstance(item, dict) and item.get("enabled") is False:
                continue
            kind = item.get("kind")
            if kind == "picture":
                pictures.append(item)
            elif kind == "video":
                mode = item.get("audio_mode", "paired")
                has_audio = bool(item.get("has_audio"))
                videos.append(item)
                if has_audio and mode == "paired":
                    video_audios.append(item)
                else:
                    video_audios.append(None)
                if has_audio and mode == "standalone":
                    audios.append(item)
            elif kind == "audio":
                audios.append(item)
        return pictures, videos, video_audios, audios

    def load(self, media_state="[]", prompt=None, unique_id=None):
        try:
            items = json.loads(media_state or "[]")
        except Exception:
            items = []

        pictures, videos, video_audios, audios = self._partition(items)

        def _trim(i):
            t = i.get("trim") if isinstance(i, dict) else None
            if not isinstance(t, dict):
                return None, None
            def num(v):
                try:
                    v = float(v)
                    return v if v > 0 else None
                except (TypeError, ValueError):
                    return None
            return num(t.get("start")), num(t.get("end"))

        pic_t = [media_io.load_image(i["file"]) for i in pictures[:PICTURES]]
        vid_t = [media_io.load_video_frames(i["file"], start=_trim(i)[0],
                 end=_trim(i)[1], crop=i.get("crop"),
                 mirror=bool(i.get("mirror")),
                 detail=i.get("detail") or "high")
                 for i in videos[:VIDEOS]]
        vaud_t = [
            media_io.extract_audio(i["file"], start=_trim(i)[0], end=_trim(i)[1]) if i else None
            for i in video_audios[:VIDEO_AUDIOS]
        ]
        aud_t = []
        for i in audios[:AUDIOS]:
            if i.get("kind") == "video":
                aud_t.append(media_io.extract_audio(i["file"],
                    start=_trim(i)[0], end=_trim(i)[1]))
            else:
                aud_t.append(media_io.load_audio(i["file"],
                    start=_trim(i)[0], end=_trim(i)[1]))

        bundle = {
            "pictures": pic_t,
            "videos": vid_t,
            "video_audios": vaud_t,
            "audios": aud_t,
            "items": items,
        }

        def _brief(a):
            if a is None:
                return "None"
            if not (isinstance(a, dict) and "waveform" in a):
                return f"unexpected type {type(a).__name__}"
            try:
                w = a["waveform"]
                rms = float((w ** 2).mean() ** 0.5)
                return f"{list(w.shape)}@{a['sample_rate']}Hz rms={rms:.4f}"
            except Exception as exc:
                return f"unreadable ({exc})"

        print(f"[MiniMaxH3 Loader] {len(items)} item(s) in state -> "
              f"{len(pic_t)} picture(s), {len(vid_t)} video(s), "
              f"{sum(1 for x in vaud_t if x is not None)} soundtrack(s), "
              f"{len(aud_t)} standalone audio")
        for i, a in enumerate(vaud_t):
            if a is not None:
                print(f"[MiniMaxH3 Loader]   video_audio_{i+1}: {_brief(a)}")
        for i, a in enumerate(aud_t):
            print(f"[MiniMaxH3 Loader]   audio_{i+1}: {_brief(a)}")

        return (bundle,)


def _pad(seq, n):
    return list(seq or []) + [None] * (n - len(seq or []))


class MiniMaxH3ReferenceSplitter:
    """Fan a `references` bundle out into individual slots.

    Keeps the Media Loader short: add this only when you want to wire media
    straight into MiniMaxH3ReferenceToVideo. Slot order matches the tags the
    Prompt Builder shows — video_audio_N is the soundtrack of video_N.
    """

    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Split a MiniMax H3 references bundle into individual picture / video / "
        "video_audio / audio slots for MiniMaxH3ReferenceToVideo."
    )
    RETURN_TYPES = (
        ("IMAGE",) * PICTURES
        + ("IMAGE",) * VIDEOS
        + ("AUDIO",) * VIDEO_AUDIOS
        + ("AUDIO",) * AUDIOS
    )
    RETURN_NAMES = tuple(_media_names())
    FUNCTION = "split"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"references": ("H3_REFS",)}}

    def split(self, references=None):
        b = references or {}
        return (
            tuple(_pad(b.get("pictures"), PICTURES))
            + tuple(_pad(b.get("videos"), VIDEOS))
            + tuple(_pad(b.get("video_audios"), VIDEO_AUDIOS))
            + tuple(_pad(b.get("audios"), AUDIOS))
        )



# Order matters: longer tokens first so "yyyy" isn't eaten by "yy".
_DATE_TOKENS = (
    ("yyyy", "%Y"), ("yy", "%y"), ("MM", "%m"), ("dd", "%d"),
    ("hh", "%H"), ("mm", "%M"), ("ss", "%S"),
)


def resolve_date_tokens(text, now=None):
    """Expand ComfyUI-style %date:...% blocks and bare strftime codes.

    Accepts either dialect, so a prefix copied from a Save Image node works
    unchanged: "runs/%date:yyyy-MM-dd%/vid" and "runs/%Y-%m-%d/vid" are
    equivalent. Unknown text is left alone.
    """
    now = now or time.localtime()

    def _block(match):
        fmt = match.group(1)
        for token, code in _DATE_TOKENS:
            fmt = fmt.replace(token, code)
        try:
            return time.strftime(fmt, now)
        except Exception:
            return match.group(0)

    out = re.sub(r"%date:([^%]*)%", _block, str(text or ""))

    # Substitute only recognised strftime codes, so a stray "%" in something
    # like "100%_good" survives instead of being mangled by strftime.
    def _code(match):
        c = match.group(1)
        if c == "%":
            return "%"
        try:
            return time.strftime("%" + c, now)
        except Exception:
            return match.group(0)

    out = re.sub(r"%([%YyGmdjHIMSpaAbBcxXZUWuw])", _code, out)
    # Keep the result inside the output directory.
    out = out.replace("\\", "/").replace("..", "").lstrip("/")
    return re.sub(r"/{2,}", "/", out)


# Labels are format descriptions, not example dates: the chosen label is what
# gets saved in the workflow, so it has to mean the same thing tomorrow.
DATE_FOLDER_FORMATS = {
    "off": None,
    "YYYY-MM-DD": "%Y-%m-%d",
    "YYYY_MM_DD": "%Y_%m_%d",
    "YYYYMMDD": "%Y%m%d",
    "YYYY-MM": "%Y-%m",
    "YYYY/MM/DD": "%Y/%m/%d",
    "YYYY-MM-DD_HH-MM": "%Y-%m-%d_%H-%M",
}




class MiniMaxH3FilenamePrefix:
    """Assemble a save prefix: folder, optional date folder, filename.

    Save nodes only expand %date:...% from their own widget, so a prefix piped
    in from elsewhere arrives verbatim and you get a folder literally named
    "%date:yyyy-MM-dd%". This node resolves everything up front and hands the
    save node a plain string that survives any amount of wiring.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Folder under ComfyUI's output directory. "
                               "Use Browse\u2026 to pick one, or type a path.",
                }),
                "subfolder": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Optional extra folders, e.g. 'Ref2V' or "
                               "'client/act2'. Created if missing.",
                }),
                "date_folder": (list(DATE_FOLDER_FORMATS), {
                    "default": "YYYY-MM-DD",
                    "tooltip": "Add a dated folder inside the one above, so "
                               "each day's renders land together.",
                }),
                "filename": ("STRING", {
                    "default": "vid",
                    "multiline": False,
                    "tooltip": "Start of the file name. The save node still "
                               "appends its own counter.",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename_prefix",)
    FUNCTION = "build"
    CATEGORY = "conditioning/video_models"
    DESCRIPTION = (
        "Builds a save prefix — folder / optional dated folder / filename — "
        "with the date already resolved, for save nodes that only expand date "
        "tokens typed directly into their widget."
    )

    @classmethod
    def IS_CHANGED(cls, folder, subfolder, date_folder, filename):
        # Nothing here changes between runs, so ComfyUI would cache the first
        # result and keep handing back a stale date. Always re-evaluate.
        return time.time()

    def build(self, folder, subfolder="", date_folder="off", filename="vid"):
        now = time.localtime()
        parts = []
        if folder and folder.strip():
            parts.append(resolve_date_tokens(folder.strip(), now))
        if subfolder.strip():
            parts.append(resolve_date_tokens(subfolder.strip(), now))
        fmt = DATE_FOLDER_FORMATS.get(date_folder)
        if fmt:
            parts.append(time.strftime(fmt, now))

        name = resolve_date_tokens((filename or "").strip(), now) or "vid"
        name = name.strip("/")
        prefix = "/".join([p for p in parts if p] + [name])
        prefix = prefix.replace("\\", "/").replace("..", "")
        prefix = re.sub(r"/{2,}", "/", prefix).lstrip("/")
        print(f"[MiniMaxH3 FilenamePrefix] -> {prefix}")
        return (prefix,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3PromptBuilder": MiniMaxH3PromptBuilder,
    "MiniMaxH3MediaLoader": MiniMaxH3MediaLoader,
    "MiniMaxH3ReferenceSplitter": MiniMaxH3ReferenceSplitter,
    "MiniMaxH3FilenamePrefix": MiniMaxH3FilenamePrefix,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3PromptBuilder": "MiniMax H3 Prompt Builder",
    "MiniMaxH3MediaLoader": "MiniMax H3 Media Loader",
    "MiniMaxH3ReferenceSplitter": "MiniMax H3 Reference Splitter",
    "MiniMaxH3FilenamePrefix": "MiniMax H3 Filename Prefix",
}
