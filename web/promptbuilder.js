/* MiniMax H3 Prompt Builder — frontend
 * Compact node summary + "Edit prompt" button opening a modal template editor.
 * Formats follow MiniMax's official prompt-writing guides shipped with the
 * open-weight release (VIDEO_PROMPT_WRITING_GUIDE_base_en / _ref_en).
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { LOADER_NAME, computeTags, viewURL as loaderViewURL,
  safeCanvasFocus, openLoaderModal, isOn } from "./medialoader.js";

const NODE_NAME = "MiniMaxH3PromptBuilder";

/* ------------------------------------------------------------------ */
/* Reference data straight from the guides                             */
/* ------------------------------------------------------------------ */

// What each mode actually sends once saved — mirrors MODE_LIMITS in nodes.py.
// Reference tags the editor knows how to chip: <Picture 1>, <Video 2>,
// <Audio 3>, <Subject 1>.
const TAG_RE = /<(?:Picture|Video|Audio|Subject) \d+>/g;

/* One pass over a field paints three things: dialogue blocks, reference tags
   and speaker IDs. Dialogue is matched first so tags inside a spoken line
   aren't chipped out of it. */
const PAINT_RE = new RegExp([
  "<d>[\\s\\S]*?<\\/d>",                      // a spoken line
  // a cut marker, with its timestamp when one follows
  "\\[Shot \\d+\\](?:\\s+at\\s+\\d{1,2}:\\d{2}(?:\\.\\d{1,3})?)?",
  "<(?:Picture|Video|Audio|Subject) \\d+>",     // a reference tag
  "\\(S\\d+(?:\\s*,\\s*S\\d+)*\\)",           // (S1) or (S1,S2)
].join("|"), "g");

const LANG_RE = /^(\s*\[[^\]\n]+\])/;

const MODE_SENDS = {
  T2VA: "Sends: prompt only \u2014 no reference media leaves the node in this mode.",
  I2VA: "Sends: prompt + picture 1 (first frame). All other media is withheld.",
  L2VA: "Sends: prompt + picture 1 (last frame). All other media is withheld.",
  FL2VA: "Sends: prompt + pictures 1\u20132 (first & last frame). All other media is withheld.",
  REF: "Sends: prompt + every enabled reference.",
};

const MODES = [
  { id: "T2VA", label: "T2VA", hint: "Text → video+audio" },
  { id: "I2VA", label: "I2VA", hint: "First frame → video" },
  { id: "FL2VA", label: "FL2VA", hint: "First + last frame" },
  { id: "L2VA", label: "L2VA", hint: "Last frame → video" },
  { id: "REF", label: "Reference", hint: "Full-reference (ref2va)" },
];

const CAMERA_MOVES = [
  ["Zoom In", "The camera zooms in"],
  ["Zoom Out", "The camera zooms out"],
  ["Push In", "The camera pushes in"],
  ["Pull Out", "The camera pulls out"],
  ["Pan Left", "The camera pans left"],
  ["Pan Right", "The camera pans right"],
  ["Truck Left", "The camera trucks left"],
  ["Truck Right", "The camera trucks right"],
  ["Tilt Up", "The camera tilts up"],
  ["Tilt Down", "The camera tilts down"],
  ["Pedestal Up", "The camera pedestals up"],
  ["Pedestal Down", "The camera pedestals down"],
  ["Arc Shot", "The camera arcs around the subject"],
  ["Tracking Shot", "The camera tracks the moving subject"],
  ["Static Shot", "The camera holds a static shot"],
  ["Shake Slightly", "The camera shakes slightly"],
  ["Shake Strongly", "The camera shakes strongly"],
  ["POV", "The shot holds the subject's point of view"],
  ["Roll Clockwise", "The camera rolls clockwise"],
  ["Roll Counterclockwise", "The camera rolls counterclockwise"],
];

const STYLES = [
  "Cinematic", "live-action", "2D-animated", "3D CG",
  "claymation", "watercolor", "vintage film",
];

const LANGS = [
  "English", "Chinese", "Japanese", "Korean", "French", "German",
  "Italian", "Spanish", "Portuguese", "Russian", "Arabic",
];

const TASK_TYPES = [
  "keyframe completion", "reference generation", "video editing",
  "video continuation", "audio reuse", "audio reference",
];

const VISUAL_MARKERS = [
  "fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference",
];
const AUDIO_MARKERS = ["fully_copy", "partially_copy", "reference", "weak_reference"];


/* Picture reference roles (guide §2.2.2 / §2.3 / §2.4.1).
   A standalone <Picture N> line is for a picture playing a role in its own
   right — a frame anchor, a layout, a look. A picture that just shows what a
   character looks like belongs cited inside that subject's line instead, so
   there is deliberately no "identity" chip here. */
const PICTURE_ROLES = [
  {
    id: "first", label: "First frame",
    title: "The image is the opening frame of a shot",
    marker: "fully_preserved", task: "keyframe completion",
    text: (c) => `<Picture ${c.n}> is the first frame of [Shot ${c.shot}], ` +
      "showing ",
    note: (c) => `it is used as the opening frame of [Shot ${c.shot}] exactly as given.`,
    context: (c) => `[Shot ${c.shot}] first frame`,
  },
  {
    id: "last", label: "Last frame",
    title: "The image is the closing frame of a shot",
    marker: "fully_preserved", task: "keyframe completion",
    text: (c) => `<Picture ${c.n}> is the last frame of [Shot ${c.shot}], ` +
      "showing ",
    note: (c) => `it is used as the closing frame of [Shot ${c.shot}] exactly as given.`,
    context: (c) => `[Shot ${c.shot}] last frame`,
  },
  {
    id: "composition", label: "Composition",
    title: "Framing, layout and camera position are echoed; content is not copied",
    marker: "weak_reference", task: "reference generation",
    text: (c) => `<Picture ${c.n}> is a composition reference for [Shot ${c.shot}] ` +
      "\u2014 its framing, subject placement and camera height are echoed; " +
      "its own content is not reproduced.",
    note: () => "only the framing and layout are echoed; its subjects and " +
      "setting are not reproduced.",
    context: (c) => `[Shot ${c.shot}] framing`,
  },
  {
    id: "style", label: "Look / style",
    title: "Palette, grade and lighting character are echoed",
    marker: "weak_reference", task: "reference generation",
    text: (c) => `<Picture ${c.n}> is a look reference \u2014 its palette, ` +
      "contrast and lighting character guide the grade of the target video; " +
      "its subjects and layout are not used.",
    note: () => "only its palette, contrast and lighting character carry over.",
    context: () => "look and grade",
  },
  {
    id: "setting", label: "Setting",
    title: "The location or environment the shot takes place in",
    marker: "partially_preserved", task: "reference generation",
    text: (c) => `<Picture ${c.n}> is the setting reference \u2014 the target ` +
      "video takes place in this location, seen from other angles as the " +
      "camera moves.",
    note: () => "the location is kept; framing and viewpoint change with the " +
      "camera.",
    context: () => "location",
  },
  {
    id: "attribute", label: "Attribute \u2192 subject",
    title: "A garment, hairstyle or marking from this picture is worn by a subject",
    marker: "attribute_transfer", task: "reference generation", needsSubject: true,
    text: (c) => `<Picture ${c.n}> supplies the ` +
      `\u2039describe the garment / hairstyle / marking\u203a worn by ${c.subj}; ` +
      "nothing else from this picture is used.",
    note: (c) => `the named attribute is transferred to ${c.subj}, whose own ` +
      "identity is unchanged.",
    context: (c) => `attribute for ${c.subj}`,
  },
  {
    id: "storyboard", label: "Storyboard",
    title: "A panel showing a beat the shot should hit, not an exact frame",
    marker: "weak_reference", task: "reference generation",
    text: (c) => `<Picture ${c.n}> is a storyboard panel for [Shot ${c.shot}] ` +
      "\u2014 it shows the beat to hit, not an exact frame to reproduce.",
    note: (c) => `it guides the staging of [Shot ${c.shot}] without being ` +
      "reproduced as a frame.",
    context: (c) => `[Shot ${c.shot}] staging`,
  },
];

/* Audio reference roles (guide §2.2.4 / §2.4.2 / §2.3).
   Each role knows how to phrase the definition, which retention marker it
   implies, and which summary task type it belongs to. */
const AUDIO_ROLES = [
  {
    id: "timbre", label: "Voice timbre \u2192 subject",
    title: "Reference a speaker's voice timbre and delivery for a defined subject",
    marker: "reference", task: "audio reference", needsSubject: true,
    text: (c) => `<Audio ${c.n}> is the voice-timbre reference for ${c.subj} (${c.sx}), ` +
      "guiding delivery and speaking rate without copying the original signal.",
    note: (c) => `its vocal timbre guides the dialogue delivery of ${c.subj} ` +
      "without copying the original signal.",
  },
  {
    id: "vidtrack", label: "Video's synced track",
    title: "The enabled synchronized audio track of a reference video",
    marker: "partially_copy", task: "audio reuse", needsVideo: true,
    text: (c) => `<Audio ${c.n}> is the synchronized audio track of ${c.vid} ` +
      "and is reused in the target video.",
    note: (c) => `the audio layers carried over from ${c.vid} remain audible in ` +
      "the target video.",
  },
  {
    id: "fullcopy", label: "Full 1:1 reuse",
    title: "The complete source audio becomes the target video's complete final track",
    marker: "fully_copy", task: "audio reuse",
    text: (c) => `<Audio ${c.n}> is reused in full as the target video's complete ` +
      "final audio track.",
    note: (c) => `<Audio ${c.n}> is reused 1:1 as the target video's complete final ` +
      "audio track.",
  },
  {
    id: "music", label: "Music style",
    title: "Reference a background-music style for the audience-only score",
    marker: "reference", task: "audio reference",
    text: (c) => `<Audio ${c.n}> is the background-music style reference for the ` +
      "target video's audience-only score.",
    note: () => "only its instrumentation, tempo, and rhythmic feel guide the new " +
      "score; the signal is not copied.",
  },
  {
    id: "lines", label: "Dialogue / lyrics",
    title: "Reuse the spoken or sung content from the source audio",
    marker: "partially_copy", task: "audio reuse",
    text: (c) => `<Audio ${c.n}> provides the spoken content reused verbatim in the ` +
      "target video, preserving its original wording and language.",
    note: () => "its dialogue content is carried into the target video verbatim.",
  },
  {
    id: "sfx", label: "Sound effects",
    title: "Reference the sound-effect texture only",
    marker: "reference", task: "audio reference",
    text: (c) => `<Audio ${c.n}> is the sound-effect texture reference for the ` +
      "target video's physical action sounds.",
    note: () => "only its sound-effect texture is referenced; the signal is not copied.",
  },
  {
    id: "beat", label: "Beat / continuity",
    title: "Reference beat, rhythm, or audio continuity",
    marker: "reference", task: "audio reference",
    text: (c) => `<Audio ${c.n}> is the beat and rhythm reference guiding the target ` +
      "video's pacing and audio continuity.",
    note: () => "only its beat, rhythm, and continuity guide the target video's pacing.",
  },
];

/* What each mode can actually consume, and what each slot means there.
   Base modes have no reference slots at all — their pictures are the native
   node's first_frame / last_frame. Reference mode takes up to 9 images,
   3 videos, and 3 audios, capped at 12 files in total. */
const MODE_CAPACITY = {
  T2VA: { Picture: 0, Video: 0, Audio: 0, roles: {} },
  I2VA: { Picture: 1, Video: 0, Audio: 0, roles: { "Picture 1": "first frame" } },
  FL2VA: { Picture: 2, Video: 0, Audio: 0,
    roles: { "Picture 1": "first frame", "Picture 2": "last frame" } },
  L2VA: { Picture: 1, Video: 0, Audio: 0, roles: { "Picture 1": "last frame" } },
  REF: { Picture: 9, Video: 3, Audio: 3, total: 12, roles: {} },
};

/* Roles a definition line states outright. Used to seed a sensible marker and
   an example note — never to overwrite anything the user has written, since a
   definition constrains the marker but does not determine it. */
const ROLE_HINTS = [
  { re: /voice[- ]timbre|voice reference|timbre reference/i, marker: "reference",
    note: "its vocal timbre guides the delivery without copying the original signal." },
  { re: /music[- ]style|background-music style|score reference/i, marker: "reference",
    note: "only its instrumentation, tempo, and dynamics guide the new score." },
  { re: /synchroni[sz]ed audio track|soundtrack of/i, marker: "partially_copy",
    note: "the audio layers carried over from that video remain audible." },
  { re: /reused in full|1:1|complete final audio track/i, marker: "fully_copy",
    note: "reused as the target video's complete final audio track." },
  { re: /beat and rhythm|audio continuity/i, marker: "reference",
    note: "only its beat and rhythm guide the target video's pacing." },
  { re: /sound-effect texture/i, marker: "reference",
    note: "only its sound-effect texture is referenced; the signal is not copied." },
  { re: /storyboard/i, marker: "weak_reference",
    note: "its viewpoint, subject placement, and shot order are followed." },
  { re: /first frame|last frame|keyframe/i, marker: "fully_preserved",
    note: "the frame is reproduced exactly at that point in the target video." },
  { re: /source video for the target video edit|edited version/i,
    marker: "partially_preserved",
    note: "the source structure is retained where the edit does not change it." },
];

function roleHint(text) {
  return ROLE_HINTS.find((h) => h.re.test(text || "")) || null;
}

/** The definition line that defines this label, if there is one. */
function definitionFor(state, label) {
  const line = (state.ref?.subjectDefs || [])
    .find((d) => !d.off && (d.text || "").trim().startsWith(label));
  return line ? line.text : "";
}

const TAG_CLASS = { Subject: "subj", Picture: "pic", Video: "vid", Audio: "aud" };

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in e) {
      // Some DOM properties are read-only (input.list, input.form, ...);
      // assigning throws in strict mode, so fall back to the attribute.
      try { e[k] = v; } catch (err) { e.setAttribute(k, v); }
    }
    else e.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ */
/* Duration snapping: H3 length grid is 17k+5 frames @ 24fps           */
/* ------------------------------------------------------------------ */

function snapLength(seconds) {
  let L = Math.max(5, Math.round((Number(seconds) || 0) * 24));
  L += (5 - (L % 17) + 17) % 17;
  return L;
}
function snappedSeconds(seconds) {
  return snapLength(seconds) / 24;
}
function fmtSS(seconds) {
  return (Math.round(seconds * 100) / 100).toFixed(2);
}

/* Seconds → strict guide format MM:SS.mmm */
function fmtTimestamp(sec) {
  let mm = Math.floor(sec / 60);
  let rest = sec - mm * 60;
  let ss = Math.floor(rest);
  let mmm = Math.round((rest - ss) * 1000);
  if (mmm === 1000) { mmm = 0; ss += 1; }
  if (ss === 60) { ss = 0; mm += 1; }
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.` +
    String(mmm).padStart(3, "0");
}

/* Smallest 17k+5 length strictly longer than a cut at `sec`. */
function minLengthAfter(sec) {
  let L = snapLength(sec);
  if (L <= Math.round(sec * 24)) L += 17;
  return L;
}

/* ------------------------------------------------------------------ */
/* Default editor state                                                */
/* ------------------------------------------------------------------ */

function defaultState() {
  return {
    version: 1,
    mode: "T2VA",
    // Sections switched off: kept in the editor, left out of the prompt.
    off: {},
    duration: 5,
    p2Shot: 1,       // FL2VA: shot index of Picture 2
    lastShot: 1,     // L2VA: shot index of Picture 1 (final shot)
    imd: "",
    soundscape: "",
    music: "N/A",
    ref: {
      subjectDefs: [],           // [{ text }]
      summaryTypes: ["reference generation"],
      summaryText: "",
      retention: [],             // [{ label, context, marker, note }]
      styleLine: "",
      detail: "",
      soundscape: "",
      music: "N/A",
    },
  };
}

function loadState(node) {
  const w = node.widgets?.find((w) => w.name === "builder_state");
  try {
    const s = JSON.parse(w?.value || "{}");
    if (s && s.version) {
      const d = defaultState();
      return { ...d, ...s, ref: { ...d.ref, ...(s.ref || {}) } };
    }
  } catch (e) { /* fall through */ }
  return defaultState();
}

/* ------------------------------------------------------------------ */
/* Connected reference slots → tag chips with live previews            */
/* ------------------------------------------------------------------ */

function parseAnnotatedPath(v) {
  let type = "input";
  let name = String(v || "");
  const m = name.match(/^(.*)\s\[(input|output|temp)\]$/);
  if (m) { name = m[1]; type = m[2]; }
  let subfolder = "";
  const slash = name.lastIndexOf("/");
  if (slash >= 0) { subfolder = name.slice(0, slash); name = name.slice(slash + 1); }
  return { name, subfolder, type };
}

function viewURL(v) {
  const { name, subfolder, type } = parseAnnotatedPath(v);
  return api.apiURL(
    `/view?filename=${encodeURIComponent(name)}` +
    `&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
  );
}

function originNode(node, slotIndex) {
  let n = node.getInputNode?.(slotIndex);
  let guard = 0;
  while (n && /reroute/i.test(n.type || "") && guard++ < 16) {
    const nn = n.getInputNode?.(0);
    if (!nn) break;
    n = nn;
  }
  return n || null;
}

function widgetValue(n, names) {
  if (!n?.widgets) return null;
  for (const name of names) {
    const w = n.widgets.find((w) => w.name === name);
    if (w && typeof w.value === "string" && w.value) return w.value;
  }
  return null;
}

/** Connected reference slots, with the tag numbers H3 will actually assign.
 *
 * Native ref2va presentation order (comfy_extras/nodes_minimax_h3.py):
 *   images, then videos — each video's paired soundtrack emitting its
 *   <Audio j> immediately BEFORE its <Video k> — then standalone audio.
 * Ordinals are 1-based per type and follow connection order, not slot
 * index, so gaps in the slots close up.
 */
function slotsFromBundle(node) {
  // The Media Loader keeps its inventory in a widget, so the tags it will
  // produce can be read straight off the graph without a round trip.
  const idx = (node.inputs || []).findIndex((i) => i.name === "references");
  if (idx < 0 || node.inputs[idx].link == null) return null;
  const loader = originNode(node, idx);
  if (!loader || loader.type !== LOADER_NAME) return null;
  let items = [];
  try {
    items = JSON.parse(
      loader.widgets?.find((w) => w.name === "media_state")?.value || "[]");
  } catch (e) { return null; }
  if (!Array.isArray(items)) return null;
  items = items.filter(isOn);      // switched-off media never reaches the model

  const { tags, extra } = computeTags(items);
  const out = [];
  const push = (tag, kind, item, note, previewKind) => {
    const n = +(tag.match(/(\d+)>/) || [])[1];
    out.push({
      tag, kind, idx: n, cls: TAG_CLASS[kind], note,
      slotName: `loader:${item.name}`,
      source: `Media Loader \u2022 ${item.name}`,
      preview: { type: previewKind, url: loaderViewURL(item.file) },
    });
  };
  items.filter((i) => i.kind === "picture")
    .forEach((i) => push(tags.get(i), "Picture", i, null, "img"));
  items.filter((i) => i.kind === "video").forEach((i) => {
    if (extra.has(i) && (i.audio_mode || "off") === "paired")
      push(extra.get(i), "Audio", i,
        `soundtrack of ${tags.get(i)}`, "audio");
    push(tags.get(i), "Video", i, null, "video");
  });
  items.forEach((i) => {
    if (i.kind === "audio") push(tags.get(i), "Audio", i, "standalone", "audio");
    else if (i.kind === "video" && i.audio_mode === "standalone" && extra.has(i))
      push(extra.get(i), "Audio", i, "split from " + tags.get(i), "audio");
  });
  out.bundled = true;
  return out;
}

function getRefSlots(node) {
  const bundled = slotsFromBundle(node);
  if (bundled) return bundled;
  const group = (re) => {
    const arr = [];
    (node.inputs || []).forEach((inp, i) => {
      const m = inp.name?.match(re);
      if (m && inp.link != null) arr.push({ idx: +m[1], input: i });
    });
    return arr.sort((a, b) => a.idx - b.idx);
  };
  const pics = group(/^picture_(\d+)$/);
  const vids = group(/^video_(\d+)$/);
  const vauds = group(/^video_audio_(\d+)$/);
  const auds = group(/^audio_(\d+)$/);

  const mk = (kind, num, g, slotName, note) => {
    const origin = originNode(node, g.input);
    let preview = null;
    if (origin) {
      const t = (origin.type || "").toLowerCase();
      if (kind === "Picture") {
        const v = widgetValue(origin, ["image", "file"]);
        if (v) preview = { type: "img", url: viewURL(v) };
      } else if (kind === "Video") {
        const v = widgetValue(origin, ["file", "video"]);
        if (v && (t.includes("video") || t.includes("vhs")))
          preview = { type: "video", url: viewURL(v) };
      } else {
        const v = widgetValue(origin, ["audio", "file"]);
        if (v) preview = { type: "audio", url: viewURL(v) };
      }
    }
    return {
      tag: `<${kind} ${num}>`, kind, idx: num, slotName, note,
      cls: TAG_CLASS[kind], preview,
      source: origin?.title || origin?.type || "connected",
    };
  };

  const out = [];
  pics.forEach((g, i) => out.push(mk("Picture", i + 1, g, `picture_${g.idx}`)));

  let audioN = 0;
  const pending = [];
  vids.forEach((g, i) => {
    const vNum = i + 1;
    // A soundtrack pairs with the same-numbered video slot and is labelled first.
    const track = vauds.find((a) => a.idx === g.idx);
    if (track) {
      audioN += 1;
      pending.push(mk("Audio", audioN, track, `video_audio_${track.idx}`,
        `soundtrack of <Video ${vNum}>`));
    }
    pending.push(mk("Video", vNum, g, `video_${g.idx}`));
  });
  out.push(...pending);

  auds.forEach((g) => {
    audioN += 1;
    out.push(mk("Audio", audioN, g, `audio_${g.idx}`, "standalone"));
  });

  // Soundtracks wired without their video never reach the model.
  vauds.forEach((a) => {
    if (!vids.some((v) => v.idx === a.idx))
      out.push({ tag: null, kind: "Audio", idx: null,
        slotName: `video_audio_${a.idx}`, orphan: a.idx, cls: "aud",
        preview: null, source: "" });
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* Prompt generation (formats verbatim from the guides)                */
/* ------------------------------------------------------------------ */

/** Sections the model tolerates being absent. The description and summary
 *  always ship — without them there is no prompt. */
const OPTIONAL_SECTIONS = ["subject_definitions", "retention_analysis",
                           "overall_soundscape", "non_diegetic_music"];

function sectionOn(state, name) {
  return !(state.off && state.off[name]);
}

function genBase(state) {
  const S = fmtSS(snappedSeconds(state.duration));
  let head = "";
  if (state.mode === "I2VA") {
    head = "For the target video, at 0.00 seconds into the target video, " +
      "<Picture 1> (from [Shot 1]) is fully referenced.";
  } else if (state.mode === "FL2VA") {
    head = "How the reference pictures align with the target video — " +
      "Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; " +
      `Picture 2 (from Shot ${state.p2Shot || 1}) aligns with the ${S}-second mark of the target video.`;
  } else if (state.mode === "L2VA") {
    head = "How the reference pictures align with the target video — " +
      `<Picture 1> (from [Shot ${state.lastShot || 1}]) aligns with the ${S}-second mark of the target video.`;
  }
  const parts = [`integrated_multimodal_description: ${state.imd.trim()}`];
  if (sectionOn(state, "overall_soundscape"))
    parts.push(`overall_soundscape: ${state.soundscape.trim()}`);
  if (sectionOn(state, "non_diegetic_music"))
    parts.push(`non_diegetic_music: ${state.music.trim() || "N/A"}`);
  const body = parts.join("\n\n");
  return head ? head + "\n\n" + body : body;
}

function genRef(state) {
  const r = state.ref;
  const defs = r.subjectDefs
    .filter((d) => !d.off)
    .map((d) => d.text.trim()).filter(Boolean).join("\n");
  const types = TASK_TYPES.filter((t) => r.summaryTypes.includes(t)).join(" + ");
  const summary = `[${types || "reference generation"}] ${r.summaryText.trim()}`;
  const retention = r.retention
    .filter((row) => row.label && !row.off)
    .map((row) => {
      const ctx = row.context?.trim() ? ` (${row.context.trim()})` : "";
      return `${row.label}${ctx}: ${row.marker} - ${row.note.trim()}`;
    })
    .join("\n");
  const detail = [r.styleLine.trim(), r.detail.trim()].filter(Boolean).join("\n");
  const on = (name) => sectionOn(state, name);
  const blocks = [];
  if (on("subject_definitions"))
    blocks.push(`subject_definitions:\n${defs}`);
  blocks.push(`summary:\n${summary}`);
  if (on("retention_analysis"))
    blocks.push(`retention_analysis:\n${retention}`);
  blocks.push(`detailed_description:\n${detail}`);
  if (on("overall_soundscape"))
    blocks.push(`overall_soundscape:\n${r.soundscape.trim()}`);
  if (on("non_diegetic_music"))
    blocks.push(`non_diegetic_music:\n${r.music.trim() || "N/A"}`);
  return blocks.join("\n\n");
}

function generate(state) {
  return state.mode === "REF" ? genRef(state) : genBase(state);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function tsToMs(mm, ss, mmm) {
  return (parseInt(mm, 10) * 60 + parseInt(ss, 10)) * 1000 + parseInt(mmm, 10);
}

function validate(state, slots) {
  const issues = [];
  const err = (m) => issues.push({ level: "error", msg: m });
  const warn = (m) => issues.push({ level: "warn", msg: m });
  const info = (m) => issues.push({ level: "info", msg: m });

  /* --- connected inputs vs. what this mode can use ------------------ */
  const cap = MODE_CAPACITY[state.mode];
  const orphans = slots.filter((s) => s.orphan != null);
  const live = slots.filter((s) => s.tag);
  const byKind = { Picture: [], Video: [], Audio: [] };
  live.forEach((s) => byKind[s.kind]?.push(s));
  const slotName = (s) => s.slotName;

  orphans.forEach((s) => {
    err(
      `${s.slotName} is connected but video_${s.orphan} is not — a soundtrack ` +
      "only reaches the model paired with its same-numbered video, so this " +
      "audio is dropped and gets no <Audio> tag."
    );
  });

  if (state.mode === "REF") {
    const total = live.length;
    if (cap.total && total > cap.total) {
      err(
        `${total} reference files are connected — the documented limit is ` +
        `${cap.total}. Disconnect ${total - cap.total} yourself: the node will ` +
        "not guess which to drop, and the tag numbering depends on what stays wired."
      );
    }
    if (!total)
      info(slots.bundled
        ? "The Media Loader is connected but empty."
        : "No reference media is mirrored on this node yet. Use '+ Media loader' " +
          "for a single-cable setup.");
  } else {
    // Base modes: pictures are keyframes, and there are no video/audio slots.
    const used = byKind.Picture.filter((s) => s.idx <= cap.Picture);
    const extraPics = byKind.Picture.filter((s) => s.idx > cap.Picture);
    const roleList = Object.entries(cap.roles)
      .map(([tag, role]) => `<${tag}> (${role})`).join(" and ");

    if (cap.Picture === 0 && byKind.Picture.length) {
      warn(
        `${state.mode} takes no reference image — ` +
        `${byKind.Picture.map(slotName).join(", ")} will be ignored.`
      );
    } else if (extraPics.length) {
      warn(
        `${state.mode} uses ${cap.Picture === 1 ? "one reference image" : "two reference images"}: ` +
        `${roleList}. ${extraPics.map(slotName).join(", ")} ` +
        `${extraPics.length > 1 ? "are" : "is"} connected but will be ignored.`
      );
    } else if (used.length && cap.Picture) {
      info(`${state.mode} uses ${roleList}.`);
    }

    const av = [...byKind.Video, ...byKind.Audio];
    if (av.length) {
      warn(
        `${state.mode} has no reference video or audio slots — ` +
        `${av.map(slotName).join(", ")} ` +
        `${av.length > 1 ? "are" : "is"} connected but will be ignored. ` +
        "Switch to Reference mode to use them."
      );
    }
  }

  const body = state.mode === "REF"
    ? [state.ref.styleLine, state.ref.detail].join("\n")
    : state.imd;
  const full = generate(state);

  // Shot structure
  if (!/\[Shot 1\]/.test(body)) warn("Body has no [Shot 1] opening.");
  if (/\[Shot 1\]\s*At \d{2}:\d{2}\.\d{3}/.test(body))
    warn("[Shot 1] must not carry a timestamp (guide §4.2).");
  const stamps = [...body.matchAll(/\[Shot (\d+)\](?:\s*At (\d{2}):(\d{2})\.(\d{3}))?/g)];
  let lastMs = -1, lastShot = 0;
  const hasDuration = state.mode === "FL2VA" || state.mode === "L2VA";
  const durMs = snappedSeconds(state.duration) * 1000;
  for (const m of stamps) {
    const n = parseInt(m[1], 10);
    if (n !== lastShot + 1) warn(`Shot numbering jumps from ${lastShot} to ${n}.`);
    lastShot = n;
    if (n > 1) {
      if (!m[2]) warn(`[Shot ${n}] is missing its "At MM:SS.mmm," cut time.`);
      else {
        const ms = tsToMs(m[2], m[3], m[4]);
        if (ms <= lastMs) warn(`[Shot ${n}] cut time is not strictly increasing.`);
        if (hasDuration && ms >= durMs)
          warn(`[Shot ${n}] cut time exceeds the ${fmtSS(durMs / 1000)}s end time.`);
        lastMs = ms;
      }
    }
  }
  if (state.mode === "FL2VA" && lastShot > 1)
    info("FL2VA generally favors a single shot for clean interpolation (guide §3.2).");

  // Dialogue blocks
  const dOpen = (body.match(/<d>/g) || []).length;
  const dClose = (body.match(/<\/d>/g) || []).length;
  if (dOpen !== dClose) warn(`Unbalanced <d> tags (${dOpen} open / ${dClose} close).`);
  for (const m of body.matchAll(/<d>(.*?)<\/d>/gs)) {
    if (!/^\s*\[[A-Za-z]+\]/.test(m[1]))
      warn(`A <d> block is missing its [Language] tag: "${m[1].slice(0, 32)}…"`);
  }

  // Reference tag cross-checks
  const cited = new Set([...full.matchAll(/<(Picture|Video|Audio) (\d+)>/g)]
    .map((m) => `<${m[1]} ${m[2]}>`));
  const uncited = live.filter((s) => {
    const usable = state.mode === "REF" ||
      (s.kind === "Picture" && s.idx <= cap.Picture);
    return usable && !cited.has(s.tag);
  }).map((s) => s.tag);
  if (uncited.length === 1) {
    warn(`${uncited[0]} is connected but never cited in the prompt.`);
  } else if (uncited.length) {
    warn(`${uncited.length} connected references are never cited in the prompt: ` +
      uncited.join(", ") + ".");
  }
  const connected = new Set(live.map((s) => s.tag));
  for (const t of cited) {
    const [, kind, num] = t.match(/<(\w+) (\d+)>/);
    if (cap[kind] === 0) {
      warn(`${t} is cited, but ${state.mode} has no ${kind.toLowerCase()} reference to bind it to.`);
    } else if (+num > cap[kind]) {
      warn(`${t} is cited, but ${state.mode} only uses ${kind} 1${cap[kind] > 1 ? `\u2013${cap[kind]}` : ""}.`);
    } else if (!connected.has(t)) {
      if (slots.bundled)
        warn(`${t} is cited but the Media Loader does not provide it.`);
      else
        info(`${t} is cited but not mirrored on this node (fine if wired only to the native node).`);
    }
  }

  if (state.mode === "REF") {
    // Switched-off lines aren't in the prompt, so they don't count as
    // defined and can't be missing a retention entry.
    const liveDefs = state.ref.subjectDefs.filter((d) => !d.off);
    const liveRet = state.ref.retention.filter((r) => !r.off);
    const defText = liveDefs.map((d) => d.text).join("\n");
    const subjects = new Set([...defText.matchAll(/<Subject (\d+)>/g)].map((m) => m[1]));
    const retLabels = new Set(liveRet.map((r) => r.label));
    for (const n of subjects) {
      if (![...retLabels].some((l) => l === `<Subject ${n}>`))
        warn(`<Subject ${n}> has no retention_analysis entry.`);
    }
    // The guide requires the marker to sit inside the role the definition
    // already states, so a plain contradiction is worth flagging.
    liveRet.forEach((row) => {
      const def = definitionFor(state, row.label);
      if (!def || !row.marker) return;
      const copies = /\breused\b|\bcopied\b|\bcopy\b|1:1/i.test(def);
      const refsOnly = /without copying|\breference\b|only its/i.test(def);
      const copyMarker = ["fully_copy", "partially_copy"].includes(row.marker);
      if (copies && !refsOnly && row.marker === "reference")
        warn(`${row.label} is defined as reused or copied, but its retention ` +
          "marker says reference \u2014 one of the two is wrong.");
      if (refsOnly && !copies && copyMarker)
        warn(`${row.label} is defined as a reference only, but its retention ` +
          `marker says ${row.marker} \u2014 one of the two is wrong.`);
    });

    const wc = state.ref.detail.trim() ? state.ref.detail.trim().split(/\s+/).length : 0;
    if (wc && (wc < 350 || wc > 500))
      info(`detailed_description is ${wc} words (guide suggests 350–500 for generation tasks).`);
    if (!state.ref.styleLine.trim())
      info("No style opening before [Shot 1] (guide §5.2 expects 1–2 style sentences).");
    if (!state.ref.summaryText.trim()) warn("summary text is empty.");
  } else {
    if ((state.mode === "I2VA" || state.mode === "FL2VA" || state.mode === "L2VA") &&
        !/<?Picture 1>?/.test(full))
      warn("Keyframe modes should anchor the description to Picture 1.");
    if (!state.soundscape.trim())
      warn("overall_soundscape is empty (use it unless the user wants total silence).");
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */

const CSS = `
.mmh3-overlay{position:fixed;inset:0;z-index:10000;background:rgba(8,10,14,.62);
  display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;}
.mmh3-modal{width:min(1240px,95vw);height:min(860px,92vh);display:flex;flex-direction:column;
  background:#191c22;color:#d7dbe2;border:1px solid #303642;border-radius:10px;
  box-shadow:0 24px 64px rgba(0,0,0,.55);overflow:hidden;}
.mmh3-head{display:flex;align-items:center;gap:14px;padding:10px 16px;
  border-bottom:1px solid #2a2f3a;background:#1e222a;}
.mmh3-title{font-weight:600;font-size:14px;letter-spacing:.02em;}
.mmh3-title small{color:#8a93a3;font-weight:400;margin-left:8px;}
.mmh3-modesends{padding:4px 14px;font-size:10px;color:#7d8698;
  background:#171a20;border-bottom:1px solid #23272f;}
.mmh3-modesends.gated{color:#e0a94c;}
.mmh3-modes{display:flex;gap:2px;background:#12151b;border:1px solid #2a2f3a;
  border-radius:7px;padding:2px;margin-left:auto;}
.mmh3-modes button{background:none;border:0;color:#9aa3b2;padding:5px 12px;border-radius:5px;
  cursor:pointer;font-size:12px;}
.mmh3-modes button.on{background:#2f3947;color:#fff;}
.mmh3-x{background:none;border:0;color:#8a93a3;font-size:18px;cursor:pointer;padding:2px 8px;}
/* Close always sits at the far right, as every other window does. */
.mmh3-head .mmh3-x{margin-left:auto;}
.mmh3-x:hover{color:#fff;}
.mmh3-body{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 0 440px;min-height:0;
  transition:grid-template-columns .16s ease;}
.mmh3-body.haspins{grid-template-columns:minmax(0,1fr) 176px 400px;}
@media (max-width:980px){.mmh3-body,.mmh3-body.haspins{grid-template-columns:1fr;}}
.mmh3-pins{overflow:hidden auto;background:#15181e;border-left:1px solid #2a2f3a;
  padding:0;display:flex;flex-direction:column;gap:6px;}
.mmh3-body.haspins .mmh3-pins{padding:10px 8px;}
.mmh3-pinhead{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8a93a3;}
.mmh3-pincard{border:1px solid #363d4a;border-radius:7px;overflow:hidden;background:#12151b;}
.mmh3-pincard .mmh3-thumb{width:100%;height:auto;max-height:150px;object-fit:contain;
  display:block;background:#0d1015;}
.mmh3-pinbar{display:flex;align-items:center;gap:6px;padding:3px 6px;}
.mmh3-auto{font-size:9px;color:#6f86b8;border:1px solid #2b3a52;border-radius:7px;
  padding:0 5px;margin-left:auto;}
.mmh3-pinbar .mmh3-x{margin-left:auto;cursor:pointer;color:#6b7484;font-size:11px;}
.mmh3-pinbar .mmh3-x:hover{color:#e05a5a;}
.mmh3-pinempty{border:1px dashed #2e3440;border-radius:7px;padding:8px 6px;text-align:center;
  font-size:10px;color:#5c6472;line-height:1.4;}
.mmh3-card{width:64px;flex:0 0 auto;border:1px solid #2e3440;border-radius:7px;
  overflow:hidden;background:#12151b;cursor:pointer;user-select:none;}
.mmh3-card:hover{border-color:#59637a;}
.mmh3-card.pic{border-color:#6d5527;} .mmh3-card.vid{border-color:#255c6b;}
.mmh3-card.aud{border-color:#4c3d6e;}
.mmh3-card .mmh3-thumb{width:100%;height:40px;object-fit:cover;display:block;
  background:#0d1015;}
.mmh3-wave{background:#0d1015;}
.mmh3-cardbar{display:flex;align-items:center;gap:3px;padding:2px 4px;}
.mmh3-tagname{font-family:ui-monospace,monospace;font-size:9px;}
.mmh3-tagname.pic{color:#e0a94c;} .mmh3-tagname.vid{color:#4cc3e0;}
.mmh3-tagname.aud{color:#b48ce8;} .mmh3-tagname.subj{color:#7ec87e;}
.mmh3-cite{margin-left:auto;font-size:9px;color:#7a8393;font-family:ui-monospace,monospace;}
.mmh3-cite.zero{color:#e0a94c;}
.mmh3-cite.off{color:#5c6472;}
.mmh3-card.unusable{opacity:.34;cursor:not-allowed;border-color:#2a2f3a !important;}
.mmh3-card.unusable:hover{opacity:.5;border-color:#3a4252 !important;}
.mmh3-card.unusable .mmh3-tagname{color:#6b7484 !important;}
.mmh3-cardnote{display:block;font-size:8px;color:#8a7ab0;padding:0 4px 3px;}
.mmh3-peek{position:fixed;z-index:10002;width:240px;background:#1e222a;
  border:1px solid #3a4252;border-radius:9px;overflow:hidden;
  box-shadow:0 12px 32px rgba(0,0,0,.5);}
.mmh3-peekmedia{width:100%;max-height:180px;object-fit:contain;display:block;
  background:#0d1015;}
.mmh3-peekmeta{padding:6px 8px;}
.mmh3-peekrow{display:flex;align-items:center;gap:6px;}
.mmh3-peekcite{margin-left:auto;font-size:9px;color:#7a8393;}
.mmh3-peekcite.zero{color:#e0a94c;}
.mmh3-peeksrc{font-size:9px;color:#6b7484;margin:2px 0 6px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mmh3-peekbtns{display:flex;gap:5px;}
.mmh3-peekbtns .mmh3-btn{flex:1;padding:3px 6px;font-size:10px;}
/* No top padding: the sticky media bar owns that space, so it can pin flush
   to the top of the scroll area with nothing able to scroll past it. */
.mmh3-form{overflow-y:auto;padding:0 16px 24px;min-width:0;}
.mmh3-side{border-left:1px solid #2a2f3a;display:flex;flex-direction:column;min-height:0;background:#15181e;}
.mmh3-sec{margin-bottom:16px;}
.mmh3-rowpow{cursor:pointer;font-size:11px;color:#3f4855;user-select:none;
  flex-shrink:0;line-height:1;text-align:center;}
.mmh3-defrow .mmh3-rowpow{align-self:flex-start;margin-top:11px;}
.mmh3-rowpow.on{color:#6fbf73;}
.mmh3-rowpow:hover{filter:brightness(1.35);}
.mmh3-defrow.off textarea, .mmh3-retrow.off select, .mmh3-retrow.off input{
  opacity:.4;text-decoration:line-through;}
.mmh3-secpow{cursor:pointer;font-size:11px;margin-right:6px;color:#3f4855;
  user-select:none;vertical-align:baseline;}
.mmh3-secpow.on{color:#6fbf73;}
.mmh3-secpow:hover{filter:brightness(1.35);}
.mmh3-sec>label.off{opacity:.45;text-decoration:line-through;}
.mmh3-sec>label.off ~ *{opacity:.45;}
.mmh3-sec>label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;
  color:#8a93a3;margin-bottom:5px;}
.mmh3-sec .hint{font-size:11px;color:#6b7484;margin-top:4px;line-height:1.4;}
.mmh3-form textarea,.mmh3-form input[type=text],.mmh3-form input[type=number],.mmh3-form select{
  width:100%;box-sizing:border-box;background:#12151b;color:#dde2ea;border:1px solid #2e3440;
  border-radius:6px;padding:7px 9px;font-size:13px;font-family:inherit;}
.mmh3-form textarea{resize:vertical;line-height:1.5;}
.mmh3-form textarea:focus,.mmh3-form input:focus,.mmh3-form select:focus{
  outline:none;border-color:#4a5568;}
.mmh3-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.mmh3-clearbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  background:#2b2320;border:1px solid #7a4a3a;border-radius:7px;padding:8px 10px;
  margin-bottom:10px;font-size:12px;color:#e8c4b4;}
.mmh3-clearnote{font-size:11px;color:#a08878;}
.mmh3-clearbar .mmh3-btn{margin-left:auto;}
.mmh3-clearbar .mmh3-btn + .mmh3-btn{margin-left:0;}
/* Full-bleed: negative side margins cancel the form's padding, so the bar's
   background covers the gutters too. Text used to scroll visibly through
   them and through the strip above the bar. */
.mmh3-dialogrow{margin-top:6px;}
.mmh3-toollabel{font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  color:#7d8698;align-self:center;}
.mmh3-toolsep{width:1px;height:18px;background:#2e3440;align-self:center;}
.mmh3-btn.ghost{opacity:.7;border-style:dashed;}
.mmh3-chipbar{position:sticky;top:0;z-index:5;background:#191c22;
  padding:12px 16px 10px;margin:0 -16px 14px;
  border-bottom:1px solid #242a34;}
.mmh3-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:3px;align-items:flex-start;}
.mmh3-chips::-webkit-scrollbar{height:6px;}
.mmh3-chips::-webkit-scrollbar-thumb{background:#2e3440;border-radius:3px;}
.mmh3-chip{display:inline-flex;align-items:center;gap:6px;border-radius:14px;cursor:pointer;
  border:1px solid #363d4a;background:#20242d;color:#c9cfda;font-size:12px;
  padding:3px 10px;user-select:none;}
.mmh3-chip:hover{border-color:#59637a;background:#262c38;}
.mmh3-chip img,.mmh3-chip video{width:22px;height:22px;object-fit:cover;border-radius:4px;}
.mmh3-chip.pic{border-color:#8a6a2c;} .mmh3-chip.pic b{color:#e0a94c;}
.mmh3-chip.vid{border-color:#2c6f81;} .mmh3-chip.vid b{color:#4cc3e0;}
.mmh3-chip.aud{border-color:#5d4a86;} .mmh3-chip.aud b{color:#b48ce8;}
.mmh3-chip.subj{border-color:#3e6b3e;} .mmh3-chip.subj b{color:#7ec87e;}
.mmh3-chip b{font-weight:600;}
.mmh3-chipnote{font-size:9px;font-style:normal;opacity:.75;letter-spacing:.02em;
  border-left:1px solid #4a4260;padding-left:5px;margin-left:1px;}
.mmh3-subjrow{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;}
.mmh3-tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center;}
.mmh3-tools select{width:auto;background:#12151b;color:#c9cfda;border:1px solid #2e3440;
  border-radius:6px;padding:4px 6px;font-size:12px;}
.mmh3-tools input[type=number]{width:84px;background:#12151b;color:#c9cfda;
  border:1px solid #2e3440;border-radius:6px;padding:4px 6px;font-size:12px;}
.mmh3-tools input[type=number]:focus{outline:none;border-color:#4a5568;}
.mmh3-btn{background:#2b3140;border:1px solid #3a4252;color:#d7dbe2;border-radius:6px;
  padding:5px 12px;font-size:12px;cursor:pointer;}
.mmh3-btn:hover{background:#333b4d;}
.mmh3-btn.primary{background:#3f5a86;border-color:#4d6ea6;color:#fff;}
.mmh3-btn.primary:hover{background:#48679a;}
.mmh3-btn.ghost{background:none;border-color:transparent;color:#8a93a3;}
.mmh3-btn.ghost:hover{color:#e05a5a;}
.mmh3-defrow{display:flex;gap:6px;margin-bottom:6px;align-items:flex-start;}
.mmh3-defrow textarea{flex:1;min-height:38px;}
.mmh3-minitags{display:flex;gap:4px;flex-wrap:wrap;margin:-2px 0 8px 2px;min-height:14px;}
.mmh3-minitag{font-size:10px;border-radius:8px;padding:1px 7px;background:#20242d;border:1px solid #363d4a;}
.mmh3-minitag.pic{color:#e0a94c;border-color:#8a6a2c;}
.mmh3-minitag.vid{color:#4cc3e0;border-color:#2c6f81;}
.mmh3-minitag.aud{color:#b48ce8;border-color:#5d4a86;}
.mmh3-minitag.subj{color:#7ec87e;border-color:#3e6b3e;}
.mmh3-roles{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:-4px 0 10px 2px;}
.mmh3-rolelabel{font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  color:#6b7484;margin-right:2px;}
.mmh3-rolechip{font-size:11px;border-radius:10px;padding:2px 9px;cursor:pointer;
  background:#1d2029;border:1px solid #3a3050;color:#a99ac4;user-select:none;}
.mmh3-rolechip:hover{border-color:#5d4a86;color:#c9b9e6;background:#241f33;}
.mmh3-rolechip.on{background:#3a2f56;border-color:#7d63b8;color:#e2d6f8;}
.mmh3-ttypes{display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:6px;}
.mmh3-ttypes label{display:flex;gap:5px;align-items:center;font-size:12px;color:#c9cfda;
  text-transform:none;letter-spacing:0;cursor:pointer;}
.mmh3-retrow{display:grid;grid-template-columns:14px 150px 1fr 160px 26px;gap:6px;
  margin-bottom:6px;align-items:center;}
.mmh3-retrow input,.mmh3-retrow select{font-size:12px;}
.mmh3-retnote{grid-column:1/-1;margin-top:-2px;}
.mmh3-preview{flex:1;overflow:auto;margin:0;padding:12px 14px;font:12px/1.55 ui-monospace,
  SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;color:#c4cad5;}
.mmh3-preview .t-pic{color:#e0a94c;} .mmh3-preview .t-vid{color:#4cc3e0;}
.mmh3-preview .t-aud{color:#b48ce8;} .mmh3-preview .t-subj{color:#7ec87e;}
.mmh3-preview .t-shot{color:#7ea7d8;font-weight:600;}
.mmh3-preview .t-d{color:#d8c07e;}
.mmh3-issues{max-height:180px;overflow:auto;border-top:1px solid #2a2f3a;padding:8px 14px;font-size:12px;}
.mmh3-issues .error{color:#f07070;margin:3px 0;font-weight:500;}
.mmh3-issues .warn{color:#e0a94c;margin:3px 0;}
.mmh3-issues .info{color:#8a93a3;margin:3px 0;}
.mmh3-issues .ok{color:#7ec87e;}
.mmh3-foot{display:flex;gap:8px;align-items:center;padding:10px 14px;border-top:1px solid #2a2f3a;}
.mmh3-foot .stats{font-size:11px;color:#6b7484;margin-right:auto;}
.mmh3-summary{width:100%;box-sizing:border-box;background:#181b21;border:1px solid #2b303b;
  border-radius:6px;padding:6px 9px;font-size:11px;line-height:1.5;color:#9aa3b2;
  overflow:hidden;cursor:default;}
.mmh3-summary b{color:#d7dbe2;}
.mmh3-libmodal{width:min(760px,94vw);height:min(640px,90vh);display:flex;
  flex-direction:column;background:#191c22;color:#d7dbe2;border:1px solid #303642;
  border-radius:10px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.55);}
.mmh3-libbar{display:flex;gap:6px;align-items:center;padding:8px 12px;
  border-bottom:1px solid #2a2f3a;background:#1b1f27;}
.mmh3-libbar input{flex:1;min-width:0;background:#12151b;color:#dde2ea;
  border:1px solid #2e3440;border-radius:6px;padding:5px 9px;font-size:12px;}
.mmh3-libbar select{background:#12151b;color:#c9cfda;border:1px solid #2e3440;
  border-radius:6px;padding:5px 7px;font-size:12px;}
.mmh3-libbar input:focus,.mmh3-libbar select:focus{outline:none;border-color:#4a5568;}
.mmh3-btn.on{background:#3a2f56;border-color:#7d63b8;color:#e2d6f8;}
.mmh3-liblist{flex:1;overflow:auto;padding:6px 8px;}
.mmh3-saveform{background:#1d222b;border:1px solid #3a4252;border-radius:8px;
  padding:8px;margin-bottom:8px;}
.mmh3-saverow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.mmh3-savecat{background:#12151b;color:#d7dbe2;border:1px solid #2e3440;
  border-radius:7px;padding:6px 8px;font-size:12px;max-width:190px;}
.mmh3-savecat:focus{outline:none;border-color:#4a5568;}
.mmh3-saverow input[type=text]{flex:1;min-width:130px;background:#12151b;
  color:#dde2ea;border:1px solid #2e3440;border-radius:6px;padding:5px 9px;
  font-size:12px;}
.mmh3-saverow input[type=text]:focus{outline:none;border-color:#4a5568;}
.mmh3-savefav{display:flex;align-items:center;gap:4px;font-size:11px;
  color:#8a93a3;white-space:nowrap;cursor:pointer;}
.mmh3-saveerr{display:block;font-size:11px;color:#f07070;margin-top:5px;}
.mmh3-saveerr:empty{display:none;}
.mmh3-librow.confirm{background:#241f2b;border-left:2px solid #7d63b8;}
.mmh3-librow{display:flex;align-items:center;gap:8px;padding:7px 8px;
  border-bottom:1px solid #23272f;}
.mmh3-librow:hover{background:#1d222b;}
.mmh3-star{background:none;border:0;color:#5c6472;font-size:15px;cursor:pointer;
  padding:0 2px;line-height:1;}
.mmh3-star.on{color:#e0a94c;}
.mmh3-star:hover{color:#e0a94c;}
.mmh3-libmain{flex:1;min-width:0;}
.mmh3-libtop{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.mmh3-libname{font-size:13px;color:#dde2ea;}
.mmh3-libmode{font-size:9px;text-transform:uppercase;letter-spacing:.06em;
  border:1px solid #2b3a52;color:#7ea7d8;border-radius:8px;padding:0 6px;}
.mmh3-libcat{font-size:9px;border:1px solid #3e5240;color:#7ec87e;border-radius:8px;
  padding:0 6px;cursor:pointer;}
.mmh3-libcat:hover{border-color:#7ec87e;background:#1e2a1e;}
.mmh3-libcat.none{border-color:#333a45;color:#5c6472;}
.mmh3-libcat.none:hover{border-color:#59637a;color:#8a93a3;background:none;}
.mmh3-catlbl{font-size:11px;color:#8a93a3;white-space:nowrap;}
.mmh3-libage{margin-left:auto;font-size:10px;color:#5c6472;}
.mmh3-libprev{font-size:11px;color:#6b7484;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;margin-top:2px;font-family:ui-monospace,monospace;}
.mmh3-libacts{display:flex;gap:5px;flex-shrink:0;}
.mmh3-libempty{padding:26px 12px;text-align:center;color:#6b7484;font-size:12px;}
.mmh3-toast.bad{background:#3a2020;border-color:#7a3a3a;color:#f0c0c0;
  max-width:min(560px,90vw);}
.mmh3-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10001;
  background:#2b3140;color:#fff;border:1px solid #4a5568;border-radius:8px;
  padding:8px 16px;font-size:13px;}

/* Reference chips. The mirror div sits under a textarea whose own text is
   transparent, so the browser keeps selection/undo/IME while the tags get
   styled. Every metric below is copied from .mmh3-form textarea — any
   difference and the chips drift off the words as lines wrap. This block is
   last, and uses .mmh3-chiptext, so it wins over the generic form rules. */
.mmh3-chipwrap{position:relative;display:block;}
/* Those two sections put the field in a flex row beside an N/A button; the
   wrapper has to claim the space the bare textarea used to. */
.mmh3-row .mmh3-chipwrap{flex:1;min-width:0;}
.mmh3-chipmirror,
.mmh3-chipwrap textarea.mmh3-chiptext{
  width:100%;box-sizing:border-box;border:1px solid #2e3440;border-radius:6px;
  padding:7px 9px;font-size:13px;font-family:inherit;line-height:1.7;
  letter-spacing:normal;white-space:pre-wrap;overflow-wrap:break-word;
  word-break:normal;tab-size:4;}
.mmh3-chipmirror{position:absolute;inset:0;overflow:hidden;pointer-events:none;
  color:#dde2ea;background:#12151b;border-color:transparent;}
.mmh3-chipwrap textarea.mmh3-chiptext{position:relative;display:block;
  background:transparent;color:transparent;caret-color:#dde2ea;
  resize:vertical;}
.mmh3-chipwrap textarea.mmh3-chiptext:focus{outline:none;border-color:#4a5568;}
.mmh3-chipwrap textarea.mmh3-chiptext::selection{
  background:rgba(96,140,210,.45);color:#fff;}
.mmh3-chipwrap textarea.mmh3-chiptext::placeholder{color:#5c6472;}
/* Layout-neutral by construction. The mirror only lines up with the textarea
   if a chip advances the text exactly as its bare glyphs would, so there is
   no padding, no margin and no border here — the breathing room is an OUTER
   box-shadow spread, which paints beyond the box without occupying space.
   Anything that changes the advance shifts wrap points, and the error
   compounds line after line. */
.mmh3-reftag{border-radius:3px;background:rgba(224,169,76,.18);color:#e0a94c;
  box-shadow:0 0 0 2px rgba(224,169,76,.18), inset 0 0 0 1px rgba(224,169,76,.45);
  -webkit-box-decoration-break:clone;box-decoration-break:clone;}
.mmh3-reftag.vid{background:rgba(76,195,224,.18);color:#4cc3e0;
  box-shadow:0 0 0 2px rgba(76,195,224,.18), inset 0 0 0 1px rgba(76,195,224,.45);}
.mmh3-reftag.aud{background:rgba(180,140,232,.18);color:#b48ce8;
  box-shadow:0 0 0 2px rgba(180,140,232,.18), inset 0 0 0 1px rgba(180,140,232,.45);}
.mmh3-reftag.subj{background:rgba(111,191,115,.18);color:#6fbf73;
  box-shadow:0 0 0 2px rgba(111,191,115,.18), inset 0 0 0 1px rgba(111,191,115,.45);}
.mmh3-reftag.unknown{background:rgba(240,112,112,.16);color:#f07070;
  box-shadow:0 0 0 2px rgba(240,112,112,.16), inset 0 0 0 1px rgba(240,112,112,.5);}
.mmh3-reftag.spk{background:rgba(126,167,216,.16);color:#7ea7d8;
  box-shadow:0 0 0 2px rgba(126,167,216,.16), inset 0 0 0 1px rgba(126,167,216,.4);}
/* Cut markers are the loudest thing in a prompt, so they're the only SOLID
   chip: every other tag is a translucent tint. The weight does the work, which
   also means the hue doesn't have to compete with audio's violet or the red
   that means "undefined tag". */
.mmh3-reftag.shot{background:#a34b7d;color:#ffe9f4;font-weight:700;
  box-shadow:0 0 0 2px #a34b7d, inset 0 0 0 1px rgba(255,255,255,.18);}
/* Spoken lines. The band shows how much of a paragraph is actually speech;
   the markers dim because they're syntax, not words the model will say.
   box-decoration-break keeps the band intact when a line wraps. */
.mmh3-dblock{background:rgba(126,167,216,.10);border-radius:3px;
  box-shadow:0 0 0 2px rgba(126,167,216,.10),
             inset 0 0 0 1px rgba(126,167,216,.28);
  -webkit-box-decoration-break:clone;box-decoration-break:clone;}
.mmh3-dmark{color:#5f7899;}
.mmh3-dlang{color:#9dc0e4;background:rgba(126,167,216,.16);border-radius:3px;
  box-shadow:0 0 0 1px rgba(126,167,216,.16);}
.mmh3-dtext{color:#e8eef6;}
.mmh3-chippeek{position:fixed;z-index:10003;width:220px;background:#1e222a;
  border:1px solid #3a4252;border-radius:9px;overflow:hidden;
  box-shadow:0 16px 40px rgba(0,0,0,.55);pointer-events:none;}
.mmh3-chippeekmedia{width:100%;max-height:150px;object-fit:contain;display:block;
  background:#000;}
.mmh3-chippeekcap{display:flex;align-items:center;gap:6px;padding:5px 8px;
  font-size:9px;color:#6b7484;}
.mmh3-chippeekcap span:last-child{overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;}
.mmh3-chippeekcap.col{flex-direction:column;align-items:flex-start;gap:4px;}
.mmh3-chippeekcap.col span:last-child{overflow:visible;white-space:normal;}
.mmh3-chiprow{display:flex;align-items:baseline;gap:5px;flex-wrap:wrap;}
.mmh3-chiplabel{font-size:9px;color:#6b7484;min-width:26px;}
.mmh3-chipspk{font-size:9px;color:#7ea7d8;font-family:ui-monospace,monospace;}
.mmh3-chiptags{display:flex;flex-wrap:wrap;gap:3px;}
.mmh3-chiptags .mmh3-tagname{font-size:9px;}
.mmh3-chipnone{color:#6b7484;font-style:italic;}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  document.head.append(el("style", { textContent: CSS }));
  cssInjected = true;
}

function toast(msg, ms = 1800) {
  const t = el("div", { class: "mmh3-toast" }, msg);
  if (ms > 4000) t.classList.add("bad");
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/* ------------------------------------------------------------------ */
/* Prompt library                                                      */
/* ------------------------------------------------------------------ */

async function libApi(path, body) {
  const opts = body
    ? { method: "POST", body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" } }
    : {};
  const resp = await api.fetchApi("/minimax_h3/prompts" + path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `request failed (${resp.status})`);
  return data;
}

function ago(ts) {
  if (!ts) return "";
  const secs = Math.max(0, Date.now() / 1000 - ts);
  const steps = [[86400 * 365, "y"], [86400 * 30, "mo"], [86400, "d"],
                 [3600, "h"], [60, "m"]];
  for (const [size, unit] of steps)
    if (secs >= size) return `${Math.floor(secs / size)}${unit} ago`;
  return "just now";
}

/** Browse, filter, and load saved prompts. `onLoad` receives the saved state. */
class Library {
  constructor(editor) {
    this.editor = editor;
    this.entries = [];
    this.categories = [];
    this.query = "";
    this.category = "";
    this.favesOnly = false;
    this.saveOpen = false;
    this.catEdit = false;     // renaming the selected category
    this.rowCat = null;       // id of the entry whose category is being set
    this.pending = null;      // { id, action: "load" | "delete" }
    this.formId = `mmh3cat${Math.random().toString(36).slice(2, 8)}`;
    injectCSS();
    this.build();
    document.body.append(this.overlay);
    this.refresh();
  }

  build() {
    this.listEl = el("div", { class: "mmh3-liblist" });
    this.searchEl = el("input", {
      type: "text", placeholder: "Search prompts",
      oninput: (e) => { this.query = e.target.value.toLowerCase(); this.paint(); },
    });
    this.catEl = el("select", {
      onchange: (e) => { this.category = e.target.value; this.paint(); },
    });
    this.favEl = el("button", { class: "mmh3-btn",
      title: "Show favourites only",
      onclick: () => { this.favesOnly = !this.favesOnly; this.paint(); } },
      "\u2605 Favourites");

    this.catBtn = el("button", { class: "mmh3-btn",
      title: "Rename or clear the selected category",
      onclick: () => {
        if (!this.category) { toast("Pick a category to manage first"); return; }
        this.catEdit = !this.catEdit;
        this.paint();
      } }, "\u270e");

    this.overlay = el("div", { class: "mmh3-overlay mmh3-libover",
      onmousedown: (e) => { if (e.target === this.overlay) this.close(); } },
      el("div", { class: "mmh3-libmodal" },
        el("div", { class: "mmh3-head" },
          el("div", { class: "mmh3-title" }, "Prompt library"),
          el("button", { class: "mmh3-btn",
            onclick: () => { this.saveOpen = !this.saveOpen; this.paint(); } },
            "Save current prompt"),
          el("button", { class: "mmh3-x", onclick: () => this.close() }, "\u2715")),
        el("div", { class: "mmh3-libbar" },
          this.searchEl, this.catEl, this.catBtn, this.favEl),
        this.listEl));

    this.escHandler = (e) => { if (e.key === "Escape") this.close(); };
    window.addEventListener("keydown", this.escHandler);
  }

  close() {
    window.removeEventListener("keydown", this.escHandler);
    this.overlay.remove();
  }

  async refresh() {
    try {
      const data = await libApi("");
      this.entries = data.prompts || [];
      this.categories = data.categories || [];
    } catch (err) {
      this.entries = [];
      this.listEl.replaceChildren(
        el("div", { class: "mmh3-libempty" },
          `Library unavailable: ${err.message}. Restart ComfyUI if you just updated.`));
      return;
    }
    this.catEl.replaceChildren(
      el("option", { value: "" }, "All categories"),
      ...this.categories.map((c) =>
        el("option", { value: c, selected: c === this.category }, c)));
    this.paint();
  }

  visible() {
    return this.entries.filter((e) => {
      if (this.favesOnly && !e.favorite) return false;
      if (this.category && e.category !== this.category) return false;
      if (!this.query) return true;
      return [e.name, e.category, e.mode, e.preview].join(" ")
        .toLowerCase().includes(this.query);
    });
  }

  saveForm() {
    const ed = this.editor;
    const name = el("input", { type: "text", placeholder: "Prompt name",
      value: ed.libraryName || `${ed.state.mode} prompt` });
    // Existing categories as a list, so saving into one is a pick rather
    // than retyping it exactly; "(new category…)" reveals a text field.
    const known = [...this.categories];
    const current = ed.libraryCategory || "";
    if (current && !known.includes(current)) known.unshift(current);
    const catNew = el("input", { type: "text", placeholder: "New category name",
      style: { display: "none" } });
    const category = el("select", { class: "mmh3-savecat",
      onchange: () => {
        const isNew = category.value === "\u0000new";
        catNew.style.display = isNew ? "" : "none";
        if (isNew) setTimeout(() => catNew.focus(), 0);
      } },
      el("option", { value: "" }, "No category"),
      known.map((c) => el("option",
        { value: c, selected: c === current }, c)),
      el("option", { value: "\u0000new" }, "(new category\u2026)"));
    const categoryValue = () =>
      (category.value === "\u0000new" ? catNew.value : category.value).trim();
    const fav = el("input", { type: "checkbox" });
    const err = el("span", { class: "mmh3-saveerr" });

    const commit = async () => {
      const value = name.value.trim();
      if (!value) { err.textContent = "Give it a name first."; name.focus(); return; }
      try {
        const res = await libApi("/save", {
          name: value,
          rename_from: ed.libraryId,
          category: categoryValue(),
          favorite: fav.checked,
          mode: ed.state.mode,
          refs: ed.slots.filter((s) => s.tag).length,
          prompt: generate(ed.state),
          state: ed.state,
        });
        ed.libraryId = res.id;
        ed.libraryName = res.name;
        ed.libraryCategory = categoryValue();
        this.saveOpen = false;
        toast(`Saved "${res.name}"`);
        this.refresh();
      } catch (e2) { err.textContent = e2.message; }
    };
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
    catNew.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
    setTimeout(() => { name.focus(); name.select(); }, 0);

    return el("div", { class: "mmh3-saveform" },
      el("div", { class: "mmh3-saverow" },
        name, category, catNew,
        el("label", { class: "mmh3-savefav" }, fav, "favourite"),
        el("button", { class: "mmh3-btn primary", onclick: commit }, "Save"),
        el("button", { class: "mmh3-btn",
          onclick: () => { this.saveOpen = false; this.paint(); } }, "Cancel")),
      err);
  }

  confirmRow(entry, action) {
    const isDelete = action === "delete";
    return el("div", { class: "mmh3-librow confirm" },
      el("div", { class: "mmh3-libmain" },
        el("div", { class: "mmh3-libtop" },
          el("span", { class: "mmh3-libname" },
            isDelete
              ? `Delete "${entry.name}"?`
              : `Replace the editor with "${entry.name}"?`)),
        el("div", { class: "mmh3-libprev" },
          isDelete
            ? "This removes the saved prompt. It cannot be undone."
            : "Your unsaved changes in the editor will be lost.")),
      el("div", { class: "mmh3-libacts" },
        el("button", { class: "mmh3-btn primary",
          onclick: () => isDelete ? this.remove(entry) : this.load(entry) },
          isDelete ? "Delete" : "Load"),
        el("button", { class: "mmh3-btn",
          onclick: () => { this.pending = null; this.paint(); } }, "Cancel")));
  }

  categoryForm() {
    const input = el("input", { type: "text", value: this.category,
      placeholder: "New category name" });
    const count = this.entries.filter((e) => e.category === this.category).length;
    const err = el("span", { class: "mmh3-saveerr" });

    const apply = async (target) => {
      try {
        const res = await libApi("/category", { from: this.category, to: target });
        toast(target
          ? `Moved ${res.changed} prompt${res.changed === 1 ? "" : "s"} to "${target}"`
          : `Cleared the category on ${res.changed} prompt${res.changed === 1 ? "" : "s"}`);
        this.category = target;
        this.catEdit = false;
        this.refresh();
      } catch (e2) { err.textContent = e2.message; }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") apply(input.value.trim());
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);

    return el("div", { class: "mmh3-saveform" },
      el("div", { class: "mmh3-saverow" },
        el("span", { class: "mmh3-catlbl" },
          `"${this.category}" \u2014 ${count} prompt${count === 1 ? "" : "s"}`),
        input,
        el("button", { class: "mmh3-btn primary",
          onclick: () => apply(input.value.trim()) }, "Rename"),
        el("button", { class: "mmh3-btn ghost",
          title: "Remove this category from its prompts (they are kept)",
          onclick: () => apply("") }, "Clear"),
        el("button", { class: "mmh3-btn",
          onclick: () => { this.catEdit = false; this.paint(); } }, "Cancel")),
      err);
  }

  rowCategoryForm(entry) {
    const input = el("input", { type: "text", value: entry.category || "",
      list: this.formId, placeholder: "Category (blank to clear)" });
    const apply = async () => {
      try {
        const res = await libApi("/meta",
          { id: entry.id, category: input.value.trim() });
        entry.category = res.category;
        this.rowCat = null;
        this.refresh();
      } catch (e2) { toast(e2.message); }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return el("div", { class: "mmh3-librow confirm" },
      el("div", { class: "mmh3-libmain" },
        el("div", { class: "mmh3-libtop" },
          el("span", { class: "mmh3-libname" }, entry.name)),
        el("div", { class: "mmh3-saverow", style: { marginTop: "4px" } },
          input,
          el("datalist", { id: this.formId },
            this.categories.map((c) => el("option", { value: c }))))),
      el("div", { class: "mmh3-libacts" },
        el("button", { class: "mmh3-btn primary", onclick: apply }, "Set"),
        el("button", { class: "mmh3-btn",
          onclick: () => { this.rowCat = null; this.paint(); } }, "Cancel")));
  }

  paint() {
    this.favEl.classList.toggle("on", this.favesOnly);
    const rows = this.visible();
    const kids = [];
    if (this.saveOpen) kids.push(this.saveForm());
    if (this.catEdit && this.category) kids.push(this.categoryForm());
    if (!rows.length) {
      kids.push(el("div", { class: "mmh3-libempty" },
        this.entries.length
          ? "Nothing matches those filters."
          : "No saved prompts yet \u2014 use 'Save current prompt'."));
      this.listEl.replaceChildren(...kids);
      return;
    }
    kids.push(...rows.map((e) => this.rowCat === e.id
      ? this.rowCategoryForm(e)
      : this.pending?.id === e.id
      ? this.confirmRow(e, this.pending.action)
      : el("div", { class: "mmh3-librow" },
      el("button", {
        class: "mmh3-star" + (e.favorite ? " on" : ""),
        title: e.favorite ? "Remove from favourites" : "Add to favourites",
        onclick: async () => {
          try {
            await libApi("/meta", { id: e.id, favorite: !e.favorite });
            e.favorite = !e.favorite;
            this.paint();
          } catch (err) { toast(err.message); }
        } }, e.favorite ? "\u2605" : "\u2606"),
      el("div", { class: "mmh3-libmain" },
        el("div", { class: "mmh3-libtop" },
          el("span", { class: "mmh3-libname" }, e.name),
          e.mode ? el("span", { class: "mmh3-libmode" },
            e.mode === "REF" ? "reference" : e.mode) : null,
          el("span", { class: "mmh3-libcat" + (e.category ? "" : " none"),
          title: "Change this prompt's category",
          onclick: () => { this.rowCat = e.id; this.paint(); } },
          e.category || "+ category"),
          el("span", { class: "mmh3-libage" }, ago(e.updated))),
        el("div", { class: "mmh3-libprev" }, e.preview || "(empty)")),
      el("div", { class: "mmh3-libacts" },
        el("button", { class: "mmh3-btn primary",
          onclick: () => this.askLoad(e) }, "Load"),
        el("button", { class: "mmh3-btn ghost", title: "Delete",
          onclick: () => { this.pending = { id: e.id, action: "delete" };
            this.paint(); } }, "\u2715")))));
    this.listEl.replaceChildren(...kids);
  }

  askLoad(entry) {
    // Only worth confirming if there is something to lose.
    if (generate(this.editor.state).trim()) {
      this.pending = { id: entry.id, action: "load" };
      this.paint();
    } else this.load(entry);
  }

  async load(entry) {
    this.pending = null;
    try {
      const data = await libApi("/load", { id: entry.id });
      const base = defaultState();
      const next = { ...base, ...(data.state || {}),
        ref: { ...base.ref, ...((data.state || {}).ref || {}) } };
      this.editor.state = next;
      this.editor.libraryId = entry.id;
      this.editor.libraryName = entry.name;
      this.editor.libraryCategory = data.category || "";
      this.editor.render();
      toast(`Loaded "${entry.name}"`);
      this.close();
    } catch (err) { toast(`Load failed: ${err.message}`); }
  }

  async remove(entry) {
    this.pending = null;
    try {
      await libApi("/delete", { id: entry.id });
      this.entries = this.entries.filter((x) => x !== entry);
      this.paint();
    } catch (err) { toast(`Delete failed: ${err.message}`); }
  }

}

/* ------------------------------------------------------------------ */
/* Modal editor                                                        */
/* ------------------------------------------------------------------ */

class Editor {
  constructor(node) {
    this.node = node;
    this.state = loadState(node);
    this.slots = getRefSlots(node);
    this.lastFocus = null;
    this.pins = [];
    this.autoPin = null;
    this.libraryId = null;
    this.libraryName = "";
    this.libraryCategory = "";
    this.clearPending = false;
    injectCSS();
    this.build();
    this.render();
    document.body.append(this.overlay);
  }

  /* ---------- insertion ---------- */
  /* opts.newline: start the insert on its own line (for block-level items
     like shot headers), collapsing any trailing whitespace first. */
  insert(text, opts = {}) {
    const t = this.lastFocus;
    if (!t || !t.isConnected) { toast("Click into a text field first"); return; }
    const start = t.selectionStart ?? t.value.length;
    const end = t.selectionEnd ?? start;
    let before = t.value.slice(0, start);
    let pad;
    if (opts.newline) {
      before = before.replace(/\s+$/, "");
      pad = before ? "\n" : "";
    } else if (/^[,;]/.test(text)) {
      pad = "";                     // the snippet supplies its own separator
    } else {
      pad = before && !/[\s(\u2014]$/.test(before) ? " " : "";
    }
    const after = t.value.slice(end);
    t.value = before + pad + text + after;
    const base = before.length + pad.length;
    const dPos = text.indexOf("</d>");
    t.selectionStart = t.selectionEnd = dPos >= 0 ? base + dPos : base + text.length;
    t.focus();
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ---------- skeleton ---------- */
  build() {
    this.formEl = el("div", { class: "mmh3-form" });
    this.pinsEl = el("div", { class: "mmh3-pins" });
    this.previewEl = el("pre", { class: "mmh3-preview" });
    this.issuesEl = el("div", { class: "mmh3-issues" });
    this.statsEl = el("span", { class: "stats" });

    this.modeBar = el("div", { class: "mmh3-modes" },
      MODES.map((m) => el("button", {
        title: m.hint,
        onclick: () => { this.state.mode = m.id; this.render(); },
      }, m.label)));
    this.modeSends = el("div", { class: "mmh3-modesends" });

    const copyBtn = el("button", { class: "mmh3-btn", onclick: () => {
      navigator.clipboard?.writeText(generate(this.state))
        .then(() => toast("Prompt copied"));
    }}, "Copy prompt");
    const cancelBtn = el("button", { class: "mmh3-btn", onclick: () => this.close() }, "Cancel");
    const saveBtn = el("button", { class: "mmh3-btn primary", onclick: () => this.save() },
      "Save to node");

    const guideBtn = el("button", { class: "mmh3-btn",
      title: "Open the bundled MiniMax H3 Video Prompt Writing Guide (PDF)",
      onclick: () => window.open(
        new URL("./Video_Prompt_Writing_Guide.pdf", import.meta.url).href,
        "_blank") }, "\ud83d\udcd6 Guide");

    this.overlay = el("div", { class: "mmh3-overlay",
      onmousedown: (e) => { if (e.target === this.overlay) this.close(); } },
      el("div", { class: "mmh3-modal" },
        el("div", { class: "mmh3-head" },
          el("div", { class: "mmh3-title" }, "Fantastic H3 Prompt Builder",
            el("small", {}, "guide-conformant output")),
          guideBtn,
          el("button", { class: "mmh3-btn",
            title: "Browse saved prompts",
            onclick: () => new Library(this) }, "\u2630 Library"),
          el("button", { class: "mmh3-btn",
            title: "Clear every field and start over",
            onclick: () => { this.clearPending = !this.clearPending; this.render(); } },
            "Clear"),
          this.modeBar,
          el("button", { class: "mmh3-x", onclick: () => this.close() }, "\u2715"),
        ),
        this.modeSends,
        el("div", { class: "mmh3-body" },
          this.formEl,
          this.pinsEl,
          el("div", { class: "mmh3-side" },
            this.previewEl, this.issuesEl,
            el("div", { class: "mmh3-foot" }, this.statsEl, copyBtn, cancelBtn, saveBtn),
          ),
        ),
      ),
    );

    this.formEl.addEventListener("focusin", (e) => {
      if (e.target.matches("textarea, input[type=text]") &&
          !e.target.dataset.noinsert) this.lastFocus = e.target;
    });
    this.formEl.addEventListener("input", () => {
      this.updatePreview();
      this.syncCaretPin();
    });
    const caretEvents = ["click", "keyup", "select", "focusin"];
    caretEvents.forEach((ev) =>
      this.formEl.addEventListener(ev, () => this.syncCaretPin()));
    // Dropping a rail card onto a textarea inserts the tag where it lands.
    this.formEl.addEventListener("drop", (e) => {
      const t = e.target;
      if (!t.matches?.("textarea, input[type=text]")) return;
      setTimeout(() => {
        this.lastFocus = t;
        this.updatePreview();
        this.syncCaretPin();
      }, 0);
    });
    this.escHandler = (e) => { if (e.key === "Escape") this.close(); };
    window.addEventListener("keydown", this.escHandler);
  }

  clearAll() {
    const mode = this.state.mode;          // you're still working in this mode
    this.state = defaultState();
    this.state.mode = mode;
    this.pins = [];
    this.autoPin = null;
    // Forget the library entry too, so the next save creates a new prompt
    // rather than quietly renaming the one that was loaded.
    this.libraryId = null;
    this.libraryName = "";
    this.libraryCategory = "";
    this.clearPending = false;
    this.render();
    toast("Prompt cleared \u2014 nothing saved to the node yet");
  }

  clearStrip() {
    return el("div", { class: "mmh3-clearbar" },
      el("span", {}, `Clear every field and start a new ${this.state.mode} prompt?`),
      el("span", { class: "mmh3-clearnote" },
        "The node keeps its current prompt until you save."),
      el("button", { class: "mmh3-btn primary",
        onclick: () => this.clearAll() }, "Clear"),
      el("button", { class: "mmh3-btn",
        onclick: () => { this.clearPending = false; this.render(); } }, "Cancel"));
  }

  close() {
    this.closePeek();
    window.removeEventListener("keydown", this.escHandler);
    this.overlay.remove();
  }

  save() {
    const pw = this.node.widgets?.find((w) => w.name === "prompt_text");
    const sw = this.node.widgets?.find((w) => w.name === "builder_state");
    if (pw) pw.value = generate(this.state);
    if (sw) sw.value = JSON.stringify(this.state);
    updateSummary(this.node);
    try {
      this.node.setDirtyCanvas?.(true, true);
      app.graph.setDirtyCanvas(true, true);
    } catch (e) { /* Vue redraws itself */ }
    toast("Saved to node");
    this.close();
  }

  /* ---------- shared UI pieces ---------- */

  ta(obj, key, rows, placeholder) {
    const box = el("textarea", {
      rows, placeholder,
      value: obj[key] ?? "",
      oninput: (e) => { obj[key] = e.target.value; },
    });
    return this.chipField(box);
  }

  /* --- reference tags as chips ------------------------------------- */

  /** Wrap a textarea so <Picture 1> and friends read as chips.
   *
   *  A textarea can't contain elements, so a mirror div renders the same
   *  text underneath with the tags wrapped in spans. The textarea keeps its
   *  own text transparent, which leaves selection, undo, IME and paste
   *  exactly as the browser implements them — a contenteditable rewrite
   *  would put all of that on us. */
  chipField(box) {
    const mirror = el("div", { class: "mmh3-chipmirror", "aria-hidden": "true" });
    const wrap = el("div", { class: "mmh3-chipwrap" }, mirror, box);
    box.classList.add("mmh3-chiptext");

    const paint = () => {
      const text = box.value || "";
      mirror.replaceChildren();
      let last = 0;
      PAINT_RE.lastIndex = 0;
      let m;
      while ((m = PAINT_RE.exec(text)) !== null) {
        if (m.index > last)
          mirror.append(document.createTextNode(text.slice(last, m.index)));
        mirror.append(...this.paintToken(m[0]));
        last = m.index + m[0].length;
      }
      // The trailing newline keeps the mirror's last line height in step with
      // the textarea's when the text ends mid-line.
      mirror.append(document.createTextNode(text.slice(last) + "\n"));
      mirror.scrollTop = box.scrollTop;
      mirror.scrollLeft = box.scrollLeft;
    };

    box.addEventListener("input", paint);
    box.addEventListener("scroll", () => {
      mirror.scrollTop = box.scrollTop;
      mirror.scrollLeft = box.scrollLeft;
    });
    // Hover a chip for its thumbnail. The mirror can't take pointer events
    // (it sits under the textarea), so hit-test the chip boxes directly.
    box.addEventListener("mousemove", (e) => this.chipHover(e, mirror));
    box.addEventListener("mouseleave", () => this.chipLeave());

    this._chipFields = this._chipFields || [];
    this._chipFields.push(paint);
    paint();
    return wrap;
  }

  /** Render one matched token as the spans the mirror shows. */
  paintToken(tok) {
    if (tok.startsWith("<d>")) {
      const inner = tok.slice(3, -4);
      const kids = [el("span", { class: "mmh3-dmark" }, "<d>")];
      const lang = inner.match(LANG_RE);
      const body = lang ? inner.slice(lang[0].length) : inner;
      if (lang) kids.push(el("span", { class: "mmh3-dlang" }, lang[1]));
      kids.push(el("span", { class: "mmh3-dtext" }, body));
      kids.push(el("span", { class: "mmh3-dmark" }, "</d>"));
      return [el("span", { class: "mmh3-dblock" }, ...kids)];
    }
    if (tok.startsWith("[Shot")) {
      return [el("span", { class: "mmh3-reftag shot" }, tok)];
    }
    if (tok.startsWith("(")) {
      return [el("span", { class: "mmh3-reftag spk", dataset: { tag: tok } }, tok)];
    }
    let cls;
    if (tok.startsWith("<Subject")) {
      cls = this.subjectInfo(tok) ? "subj" : "unknown";
    } else {
      const slot = this.slotFor(tok);
      cls = slot ? (slot.cls || "pic") : "unknown";
    }
    return [el("span", { class: "mmh3-reftag " + cls, dataset: { tag: tok } }, tok)];
  }

  /** What a <Subject N> chip should show: the first picture its definition
   *  cites, plus every media tag that line mentions. */
  subjectInfo(tag) {
    const defs = this.state?.ref?.subjectDefs || [];
    const line = defs.find((d) => !d.off &&
      (d.text || "").trim().startsWith(tag));
    if (!line) return null;
    const tags = [...new Set((line.text.match(TAG_RE) || [])
      .filter((t) => t !== tag))];

    // A voice reference is usually declared the other way round — the audio's
    // own line names the subject ("<Audio 1> is the voice-timbre reference
    // for <Subject 1> (S1)") — so the attachment has to be read from every
    // other definition that mentions this subject, not just its own.
    const voices = [], speakers = [];
    for (const d of defs) {
      if (d === line || d.off) continue;
      const text = d.text || "";
      if (!text.includes(tag)) continue;
      for (const t of text.match(TAG_RE) || [])
        if (t.startsWith("<Audio") && !tags.includes(t) && !voices.includes(t))
          voices.push(t);
      for (const m of text.matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/g))
        if (!speakers.includes(m[0])) speakers.push(m[0]);
    }
    for (const m of (line.text || "").matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/g))
      if (!speakers.includes(m[0])) speakers.push(m[0]);

    const slot = tags.map((t) => this.slotFor(t))
      .find((sl) => sl && sl.preview?.url && sl.preview.type === "img")
      || tags.map((t) => this.slotFor(t)).find((sl) => sl && sl.preview?.url);
    return { slot, tags, voices, speakers, line };
  }

  slotFor(tag) {
    if (!this._slotMap || this._slotMapAt !== this.slots)
      this._slotMap = new Map((this.slots || []).map((s) => [s.tag, s]));
    this._slotMapAt = this.slots;
    return this._slotMap.get(tag);
  }

  chipHover(e, mirror) {
    let hit = null;
    for (const chip of mirror.querySelectorAll(".mmh3-reftag")) {
      const r = chip.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom) { hit = chip; break; }
    }
    if (!hit) { this.chipLeave(); return; }
    if (this._chipOpenFor === hit.dataset.tag) return;
    this.chipLeave();
    const tag = hit.dataset.tag;
    let slot = null, subject = null;
    if (tag.startsWith("<Subject")) {
      subject = this.subjectInfo(tag);
      if (!subject) return;                  // undefined subject: nothing to show
      slot = subject.slot;
    } else {
      slot = this.slotFor(tag);
      if (!slot || !slot.preview?.url) return;
    }
    this._chipOpenFor = tag;
    this._chipTimer = setTimeout(
      () => this.openChipPeek(hit, slot, tag, subject), 180);
  }

  chipLeave() {
    clearTimeout(this._chipTimer);
    this._chipOpenFor = null;
    if (this._chipPeek) { this._chipPeek.remove(); this._chipPeek = null; }
  }

  /** Small thumbnail beside the chip. Deliberately not interactive: it must
   *  never steal the pointer while you're typing. */
  openChipPeek(chip, slot, tag, subject) {
    const media = !slot ? null
      : slot.preview.type === "video"
      ? el("video", { src: slot.preview.url, muted: true, loop: true,
          autoplay: true, class: "mmh3-chippeekmedia" })
      : slot.preview.type === "audio"
        ? this.mediaThumb(slot, true)
        : el("img", { src: slot.preview.url, class: "mmh3-chippeekmedia" });
    const tagRow = (label, list) => list.length
      ? el("span", { class: "mmh3-chiprow" },
          el("span", { class: "mmh3-chiplabel" }, label),
          el("span", { class: "mmh3-chiptags" },
            list.map((t) => {
              const sl = this.slotFor(t);
              return el("span", {
                class: `mmh3-tagname ${sl ? (sl.cls || "pic") : "unknown"}`,
              }, t);
            })))
      : null;
    const caption = subject
      ? el("div", { class: "mmh3-chippeekcap col" },
          el("span", { class: "mmh3-chiprow" },
            el("span", { class: "mmh3-tagname subj" }, tag),
            subject.speakers.length
              ? el("span", { class: "mmh3-chipspk" }, subject.speakers.join(" "))
              : null),
          tagRow("cites", subject.tags),
          tagRow("voice", subject.voices),
          (!subject.tags.length && !subject.voices.length)
            ? el("span", { class: "mmh3-chipnone" }, "no media attached")
            : null)
      : el("div", { class: "mmh3-chippeekcap" },
          el("span", { class: `mmh3-tagname ${slot.cls}` }, slot.tag),
          el("span", {}, slot.source || ""));
    const box = el("div", { class: "mmh3-chippeek" }, media, caption);
    const r = chip.getBoundingClientRect();
    box.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    box.style.top = `${r.bottom + 6}px`;
    document.body.append(box);
    // Flip above the chip when there's no room below.
    const bb = box.getBoundingClientRect();
    if (bb.bottom > window.innerHeight - 8)
      box.style.top = `${Math.max(8, r.top - bb.height - 6)}px`;
    this._chipPeek = box;
  }

  /* Waveforms make audio identifiable at a glance; a generic mic icon does not.
     Decoded once per URL and cached for the session. */
  static waveCache = new Map();

  drawWave(canvas, url) {
    const cached = Editor.waveCache.get(url);
    const paint = (peaks) => {
      const w = canvas.width, h = canvas.height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#b48ce8";
      const n = peaks.length;
      for (let x = 0; x < w; x++) {
        const v = peaks[Math.floor((x / w) * n)] || 0;
        const bar = Math.max(1, v * (h - 2));
        ctx.fillRect(x, (h - bar) / 2, 1, bar);
      }
    };
    if (cached) { if (cached.then) cached.then(paint).catch(() => {}); else paint(cached); return; }
    const job = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => new (window.AudioContext || window.webkitAudioContext)()
        .decodeAudioData(buf))
      .then((audio) => {
        const data = audio.getChannelData(0);
        const buckets = 160, step = Math.floor(data.length / buckets) || 1;
        const peaks = [];
        for (let i = 0; i < buckets; i++) {
          let peak = 0;
          for (let j = 0; j < step; j += 8) {
            const v = Math.abs(data[i * step + j] || 0);
            if (v > peak) peak = v;
          }
          peaks.push(peak);
        }
        Editor.waveCache.set(url, peaks);
        return peaks;
      });
    Editor.waveCache.set(url, job);
    job.then(paint).catch(() => Editor.waveCache.delete(url));
  }

  /** Whether the current mode can use this reference at all. */
  usable(slot) {
    const cap = MODE_CAPACITY[this.state.mode] || {};
    return (cap[slot.kind] || 0) >= slot.idx;
  }

  modeNote(slot) {
    const cap = MODE_CAPACITY[this.state.mode] || {};
    const limit = cap[slot.kind] || 0;
    if (limit === 0)
      return `${this.state.mode} has no ${slot.kind.toLowerCase()} references — ` +
        "this is not sent to the model.";
    return `${this.state.mode} uses only ${slot.kind} 1` +
      (limit > 1 ? `\u2013${limit}` : "") + " — this is not sent to the model.";
  }

  citationCount(tag) {
    if (this._citeText == null) this._citeText = generate(this.state);
    const esc = tag.replace(/[<>]/g, (c) => "\\" + c);
    return (this._citeText.match(new RegExp(esc, "g")) || []).length;
  }

  mediaThumb(s, big) {
    if (s.preview?.type === "img")
      return el("img", { class: "mmh3-thumb", src: s.preview.url });
    if (s.preview?.type === "video")
      return el("video", { class: "mmh3-thumb", src: s.preview.url, muted: true,
        loop: true, preload: "metadata",
        onmouseenter: (e) => e.target.play().catch(() => {}),
        onmouseleave: (e) => e.target.pause() });
    const cv = el("canvas", { class: "mmh3-thumb mmh3-wave",
      width: big ? 220 : 62, height: big ? 60 : 40 });
    if (s.preview?.url) setTimeout(() => this.drawWave(cv, s.preview.url), 0);
    return cv;
  }

  /* --- hover peek ------------------------------------------------- */

  peekFor(card, s) {
    let timer = null;
    const open = () => {
      this.closePeek();
      const box = el("div", { class: "mmh3-peek" });
      const media = s.preview?.type === "video"
        ? el("video", { src: s.preview.url, controls: true, autoplay: true,
            muted: true, loop: true, class: "mmh3-peekmedia" })
        : s.preview?.type === "audio"
          ? el("div", {}, this.mediaThumb(s, true),
              el("audio", { src: s.preview.url, controls: true,
                style: { width: "100%", height: "28px" } }))
          : el("img", { src: s.preview?.url, class: "mmh3-peekmedia" });
      const cites = this.citationCount(s.tag);
      box.append(media,
        el("div", { class: "mmh3-peekmeta" },
          el("div", { class: "mmh3-peekrow" },
            el("span", { class: `mmh3-tagname ${s.cls}` }, s.tag),
            el("span", { class: "mmh3-peekcite" + (cites ? "" : " zero") },
              cites ? `cited ${cites}\u00d7` : "not cited")),
          el("div", { class: "mmh3-peeksrc" },
            s.source + (s.note ? ` \u2022 ${s.note.replace(/[<>]/g, "")}` : "")),
          el("div", { class: "mmh3-peekbtns" },
            el("button", { class: "mmh3-btn", onclick: () => {
              this.insert(s.tag); this.closePeek(); } }, "Insert tag"),
            )));

      const r = card.getBoundingClientRect();
      box.style.left = `${Math.min(r.left, window.innerWidth - 250)}px`;
      box.style.top = `${r.bottom + 6}px`;
      box.addEventListener("mouseenter", () => clearTimeout(this._peekClose));
      box.addEventListener("mouseleave", () => this.closePeek());
      document.body.append(box);
      this._peek = box;
    };
    card.addEventListener("mouseenter", () => {
      clearTimeout(this._peekClose);
      timer = setTimeout(open, 250);
    });
    card.addEventListener("mouseleave", () => {
      clearTimeout(timer);
      this._peekClose = setTimeout(() => this.closePeek(), 220);
    });
  }

  closePeek() {
    if (this._peek) { this._peek.remove(); this._peek = null; }
  }

  /* --- pinning ----------------------------------------------------- */

  togglePin(tag) {
    if (this.pins.includes(tag)) this.pins = this.pins.filter((t) => t !== tag);
    else {
      this.pins = [tag, ...this.pins].slice(0, 3);
      this.autoPin = null;   // an explicit pin overrides the caret
    }
    this.drawPins();
  }

  /** The tag the caret currently sits inside, if any. */
  caretTag() {
    const t = this.lastFocus;
    if (!t || !t.isConnected || t.selectionStart == null) return null;
    const pos = t.selectionStart;
    for (const m of t.value.matchAll(/<(Picture|Video|Audio) \d+>/g)) {
      if (pos >= m.index && pos <= m.index + m[0].length) return m[0];
    }
    return null;
  }

  syncCaretPin() {
    const tag = this.caretTag();
    const known = tag && this.slots.some((s) => s.tag === tag);
    const next = known ? tag : null;
    if (next === this.autoPin) return;
    this.autoPin = next;
    this.drawPins();
  }

  drawPins() {
    if (!this.pinsEl) return;
    // Chips in the text carry the previews now, so the rail never opens —
    // it used to widen the body and shove every field sideways.
    this.pinsEl.replaceChildren();
    this.pinsEl.parentElement?.classList.remove("haspins");
    if (true) return;
    const shown = [];
    if (this.autoPin && !this.pins.includes(this.autoPin)) shown.push(this.autoPin);
    shown.push(...this.pins);
    const list = shown.slice(0, 3)
      .map((tag) => this.slots.find((s) => s.tag === tag)).filter(Boolean);

    this.overlay.querySelector(".mmh3-body")
      .classList.toggle("haspins", list.length > 0);

    this.pinsEl.replaceChildren(
      el("div", { class: "mmh3-pinhead" }, "pinned"),
      ...list.map((s) => el("div", { class: "mmh3-pincard" },
        this.mediaThumb(s, true),
        el("div", { class: "mmh3-pinbar" },
          el("span", { class: `mmh3-tagname ${s.cls}` }, s.tag),
          s.tag === this.autoPin && !this.pins.includes(s.tag)
            ? el("span", { class: "mmh3-auto", title: "Pinned by the caret" }, "auto")
            : el("span", { class: "mmh3-x", title: "Unpin",
                onclick: () => this.togglePin(s.tag) }, "\u2715")),
        s.preview?.type === "audio"
          ? el("audio", { src: s.preview.url, controls: true,
              style: { width: "100%", height: "26px" } })
          : null)),
      list.length < 3
        ? el("div", { class: "mmh3-pinempty" },
            list.length ? "pin up to " + (3 - list.length) + " more"
              : "hover a reference and pin it, or put the caret in a tag")
        : null);
  }

  /* --- the rail ---------------------------------------------------- */

  refChips() {
    const live = this.slots.filter((s) => s.tag);
    if (!live.length) {
      return el("span", { class: "hint" },
        "No reference media on this node yet \u2014 use '+ Media loader', or wire " +
        "loaders into the picture_/video_/audio_ inputs.");
    }
    return live.map((s) => {
      const ok = this.usable(s);
      const cites = ok ? this.citationCount(s.tag) : 0;
      const card = el("div", {
        class: `mmh3-card ${s.cls}` + (ok ? "" : " unusable"),
        draggable: ok,
        title: ok ? `${s.tag} \u2022 ${s.source}` : this.modeNote(s),
        onclick: () => ok ? this.insert(s.tag) : toast(this.modeNote(s), 3200),
        ondragstart: (e) => {
          if (!ok) { e.preventDefault(); return; }
          e.dataTransfer.setData("text/plain", s.tag);
          e.dataTransfer.effectAllowed = "copy";
          this.closePeek();
        },
      },
        this.mediaThumb(s),
        el("div", { class: "mmh3-cardbar" },
          el("span", { class: `mmh3-tagname ${s.cls}` }, `${s.kind} ${s.idx}`),
          ok
            ? el("span", { class: "mmh3-cite" + (cites ? "" : " zero"),
                title: cites ? `cited ${cites}\u00d7` : "not cited yet" },
                cites || "\u2013")
            : el("span", { class: "mmh3-cite off", title: this.modeNote(s) },
                "\u2298")),
        s.note && s.note !== "standalone"
          ? el("span", { class: "mmh3-cardnote" },
              "\u266a\u2192V" + (s.note.match(/\d+/) || [""])[0])
          : null);
      if (ok) this.peekFor(card, s);
      return card;
    });
  }

  toolBar(extraChips = []) {
    const camMove = el("select", {},
      CAMERA_MOVES.map(([k]) => el("option", { value: k }, k)));
    const camAmp = el("select", {},
      ["(amplitude)", "with small amplitude", "with large amplitude"]
        .map((v, i) => el("option", { value: i ? v : "" }, v)));
    const camSpd = el("select", {},
      ["(speed)", "at slow speed", "at fast speed"]
        .map((v, i) => el("option", { value: i ? v : "" }, v)));
    const camBtn = el("button", { class: "mmh3-btn", onclick: () => {
      const base = CAMERA_MOVES.find(([k]) => k === camMove.value)[1];
      this.insert([base, camAmp.value, camSpd.value].filter(Boolean).join(" "));
    }}, "+ Camera");

    const lang = el("select", {}, LANGS.map((l) => el("option", { value: l }, l)));
    const spk = el("select", {}, ["S1", "S2", "S3", "S4"]
      .map((s) => el("option", { value: s }, s)));
    const diaBtn = el("button", { class: "mmh3-btn", onclick: () =>
      this.insert(`(${spk.value}) says: <d>[${lang.value}] </d>`) }, "+ Dialogue");
    const voBtn = el("button", { class: "mmh3-btn", title: "Voiceover (guide §4.4)",
      onclick: () => this.insert(
        `(${spk.value}) says in an off-screen voiceover: <d>[${lang.value}] </d> ` +
        "while his lips remain completely closed.") }, "+ Voiceover");

    const timeIn = el("input", {
      type: "number", min: "0", max: "900", step: "0.1", value: "3.0",
      title: "Cut time in seconds \u2014 scroll or use the arrows to step by 0.1s",
      dataset: { noinsert: "1" }, style: { width: "84px" },
    });
    // Let the wheel step the value without scrolling the form behind it.
    timeIn.addEventListener("wheel", (e) => {
      if (document.activeElement !== timeIn) return;
      e.preventDefault();
      const v = parseFloat(timeIn.value) || 0;
      const next = Math.max(0, Math.round((v + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10);
      timeIn.value = next.toFixed(1);
    }, { passive: false });

    const shotBtn = el("button", { class: "mmh3-btn",
      title: "Insert the next [Shot N]. Shots after the first use the cut time " +
        "from the stepper, formatted as At MM:SS.mmm",
      onclick: () => {
        const field = this.lastFocus;
        const t = field?.value || "";
        const n = Math.max(0, ...[...t.matchAll(/\[Shot (\d+)\]/g)].map((m) => +m[1])) + 1;
        // "appears in ..." fields want a bare shot label, not a cut scaffold.
        if (field?.dataset?.shotlist) {
          const sep = t.trim() && !/[\s,]$/.test(t.slice(0, field.selectionStart ?? t.length))
            ? ", " : "";
          this.insert(`${sep}[Shot ${n}]`);
          return;
        }
        if (n === 1) { this.insert("[Shot 1] ", { newline: true }); return; }
        const sec = parseFloat(timeIn.value);
        if (!isFinite(sec) || sec <= 0) {
          toast("Set a cut time above 0 first");
          timeIn.focus();
          return;
        }
        this.insert(`[Shot ${n}] At ${fmtTimestamp(sec)}, the shot cuts to `,
          { newline: true });
        // Advance the stepper past the cut just placed, ready for the next one.
        timeIn.value = (Math.round((sec + 3) * 10) / 10).toFixed(1);
      } }, "+ Shot");
    timeIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); shotBtn.click(); }
    });

    const styleSel = el("select", {},
      [el("option", { value: "" }, "(style)"),
        ...STYLES.map((s) => el("option", { value: s }, s))]);
    styleSel.addEventListener("change", () => {
      if (styleSel.value) { this.insert(styleSel.value + ", "); styleSel.value = ""; }
    });

    return el("div", { class: "mmh3-chipbar" },
      el("div", { class: "mmh3-chips" }, this.refChips()),
      extraChips.length
        ? el("div", { class: "mmh3-subjrow" }, extraChips) : null,
      el("div", { class: "mmh3-tools" },
        timeIn, shotBtn, camMove, camAmp, camSpd, camBtn, styleSel),
      this.dialogueRow(lang));
  }

  /** Speaker IDs already used in the prompt, in numeric order. */
  usedSpeakers() {
    const text = JSON.stringify(this.state || {});
    const found = new Set();
    for (const m of text.matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/g)) {
      for (const id of m[1].split(",")) found.add(id.trim());
    }
    return [...found].sort((a, b) => (+a.slice(1)) - (+b.slice(1)));
  }

  /** Dialogue controls: language, one button per speaker already in use plus
   *  the next unused ID, a voiceover toggle, and the two continuity markers.
   *  Speaker IDs follow the target video's speaking order, so offering a
   *  fixed S1-S4 would invent numbers the prompt has no use for. */
  dialogueRow(lang) {
    const used = this.usedSpeakers();
    const next = `S${used.length ? Math.max(...used.map((s) => +s.slice(1))) + 1 : 1}`;

    const vo = el("button", {
      class: "mmh3-btn" + (this.voiceover ? " primary" : ""),
      title: "Off-screen voiceover. While on, inserted lines use the guide's " +
             "exact phrasing and append the lips-closed clause, which is " +
             "required on every voiceover line.",
      onclick: () => { this.voiceover = !this.voiceover; this.render(); },
    }, "\u{1F399} voiceover");

    const line = (id) => {
      const said = this.voiceover
        ? `(${id}) says in an off-screen voiceover: `
        : `(${id}) says: `;
      const tail = this.voiceover
        ? " while their lips remain completely closed."
        : "";
      // insert() parks the caret before </d> and starts a new line for us.
      return `${said}<d>[${lang.value}] </d>${tail}`;
    };

    const spkBtn = (id, isNew) => el("button", {
      class: "mmh3-btn" + (isNew ? " ghost" : ""),
      title: isNew
        ? `Add ${id} \u2014 the next speaker in the video's speaking order`
        : `Insert a line for ${id}`,
      onclick: () => this.insert(line(id), { newline: true }),
    }, isNew ? `+ (${id})` : `(${id})`);

    const pair = used.length >= 2
      ? el("button", { class: "mmh3-btn",
          title: "Two speakers vocalising together",
          onclick: () => this.insert(line(`${used[0]},${used[1]}`),
            { newline: true }) },
          `(${used[0]},${used[1]})`)
      : null;

    return el("div", { class: "mmh3-tools mmh3-dialogrow" },
      el("span", { class: "mmh3-toollabel" }, "Dialogue:"),
      lang,
      ...used.map((id) => spkBtn(id, false)),
      spkBtn(next, true),
      pair,
      vo,
      el("span", { class: "mmh3-toolsep" }),
      el("button", { class: "mmh3-btn",
        title: "A line crossing a cut. Use it twice \u2014 once at the end of " +
               "the pre-cut half, once at the start of the post-cut half \u2014 " +
               "and say the audio continues.",
        onclick: () => this.insert("<scenetrans>") }, "\u2933 scenetrans"),
      el("button", { class: "mmh3-btn",
        title: "Speech truncated by the end of the video",
        onclick: () => this.insert("<cutoff>") }, "\u2301 cutoff"));
  }

  durationRow() {
    const frames = snapLength(this.state.duration);
    const hint = el("span", { class: "hint" },
      `snaps to ${fmtSS(frames / 24)} s \u2022 ${frames} frames (17k+5 grid @ 24fps) \u2014 ` +
      "use this value for the native node's length");
    const input = el("input", {
      type: "number", min: "0.2", max: "15", step: "0.1", style: { width: "90px" },
      value: this.state.duration,
      oninput: (e) => {
        this.state.duration = parseFloat(e.target.value) || 5;
        const f = snapLength(this.state.duration);
        hint.textContent =
          `snaps to ${fmtSS(f / 24)} s \u2022 ${f} frames (17k+5 grid @ 24fps) \u2014 ` +
          "use this value for the native node's length";
      },
    });
    return el("div", { class: "mmh3-sec" },
      el("label", {}, "Video end time (s) \u2192 becomes S.SS in the instruction line"),
      el("div", { class: "mmh3-row" }, input, hint));
  }

  naButton(obj, key) {
    return el("button", { class: "mmh3-btn", style: { alignSelf: "flex-start" },
      onclick: (e) => {
        const box = e.target.closest(".mmh3-sec").querySelector("textarea");
        if (box) {
          box.value = "N/A";
          // Let the field's own handlers run: they update the state and
          // repaint the chip mirror. Assigning .value fires nothing.
          box.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          obj[key] = "N/A";
        }
        this.updatePreview();
      } }, "N/A");
  }

  /* ---------- mode renderers ---------- */

  render() {
    this._citeText = null;
    const scroll = this.formEl.scrollTop;
    [...this.modeBar.children].forEach((b, i) =>
      b.classList.toggle("on", MODES[i].id === this.state.mode));
    this._slotMap = null;                 // slots may have changed
    (this._chipFields || []).forEach((paint) => { try { paint(); } catch (e) {} });
    this.modeSends.textContent = MODE_SENDS[this.state.mode] || "";
    this.modeSends.classList.toggle("gated", this.state.mode !== "REF");
    this.formEl.replaceChildren();
    this.slots = getRefSlots(this.node);
    if (this.state.mode === "REF") this.renderRef();
    else this.renderBase();
    if (this.clearPending) {
      this.formEl.prepend(this.clearStrip());
      this.formEl.scrollTop = 0;
    } else this.formEl.scrollTop = scroll;
    this.updatePreview();
    this.drawPins();
  }

  renderBase() {
    this._paintSubjChips = null;
    const s = this.state;
    const f = this.formEl;
    f.append(this.toolBar());

    const modeHints = {
      T2VA: "No instruction line. Build the complete audiovisual timeline from text.",
      I2VA: "Fixed instruction line is auto-generated. <Picture 1> is the actual first frame of [Shot 1] — anchor, then develop forward.",
      FL2VA: "Instruction line auto-generated from duration. Describe the motion path from Picture 1 to Picture 2; favors a single shot.",
      L2VA: "Instruction line auto-generated. Infer a plausible earlier state, then converge onto <Picture 1> in the final shot.",
    };
    f.append(el("div", { class: "mmh3-sec" },
      el("span", { class: "hint" }, modeHints[s.mode])));

    if (s.mode === "FL2VA" || s.mode === "L2VA") f.append(this.durationRow());

    if (s.mode === "FL2VA") {
      f.append(el("div", { class: "mmh3-sec" },
        el("label", {}, "Picture 2 belongs to Shot"),
        el("input", { type: "number", min: "1", step: "1", style: { width: "80px" },
          value: s.p2Shot,
          oninput: (e) => { s.p2Shot = parseInt(e.target.value, 10) || 1; } })));
    }
    if (s.mode === "L2VA") {
      f.append(el("div", { class: "mmh3-sec" },
        el("label", {}, "Final shot index N (Picture 1 lands here)"),
        el("input", { type: "number", min: "1", step: "1", style: { width: "80px" },
          value: s.lastShot,
          oninput: (e) => { s.lastShot = parseInt(e.target.value, 10) || 1; } })));
    }

    const structures = {
      T2VA: "style + composition \u2192 actions \u2192 cuts \u2192 dialogue/diegetic sound",
      I2VA: "first-frame anchor \u2192 action onset \u2192 continuous development \u2192 result or reaction",
      FL2VA: "first-frame state \u2192 observable intermediate changes \u2192 narrowing differences \u2192 last-frame state",
      L2VA: "plausible preceding state \u2192 action/transition path \u2192 gradual convergence \u2192 last-frame landing",
    };
    f.append(el("div", { class: "mmh3-sec" },
      el("label", {}, "integrated_multimodal_description"),
      this.ta(s, "imd", 12,
        `[Shot 1] Live-action, cinematic, ...\nRecommended: ${structures[s.mode]}`),
      el("span", { class: "hint" },
        "Open [Shot 1] with the overall style and initial composition. Later shots: " +
        "\"[Shot N] At MM:SS.mmm, the shot cuts to ...\". Write camera moves as natural sentences.")));

    f.append(el("div", { class: "mmh3-sec" },
      this.secLabel("overall_soundscape"),
      el("div", { class: "mmh3-row" },
        this.ta(s, "soundscape", 3,
          "1\u20134 sentences: ambience, physical action sounds, non-verbal human sounds."),
        this.naButton(s, "soundscape"))));

    f.append(el("div", { class: "mmh3-sec" },
      this.secLabel("non_diegetic_music"),
      el("div", { class: "mmh3-row" },
        this.ta(s, "music", 3,
          "1\u20133 sentences: instrumentation, tempo, rhythm, dynamics. No abstract mood words."),
        this.naButton(s, "music"))));
  }

  renderRef() {
    const r = this.state.ref;
    const f = this.formEl;

    const nextTagN = (kind) => {
      const inDefs = r.subjectDefs.flatMap((d) =>
        [...d.text.matchAll(new RegExp(`<${kind} (\\d+)>`, "g"))].map((m) => +m[1]));
      // Prefer the lowest connected slot that isn't defined yet.
      const connected = this.slots
        .filter((s) => s.kind === kind && s.tag).map((s) => s.idx);
      const free = connected.find((n) => !inDefs.includes(n));
      return free ?? Math.max(0, ...inDefs, ...connected) + 1;
    };
    const nextSubjectN = () => nextTagN("Subject");

    const subjChips = () => {
      const defText = r.subjectDefs.map((d) => d.text).join("\n");
      const ns = [...new Set([...defText.matchAll(/<Subject (\d+)>/g)].map((m) => m[1]))];
      return ns.map((n) => el("span", {
        class: "mmh3-chip subj", title: `Insert <Subject ${n}>`,
        onclick: () => this.insert(`<Subject ${n}>`),
      }, el("b", {}, `Subject ${n}`)));
    };
    const subjChipWrap = el("span", { style: { display: "contents" } });
    this._paintSubjChips = () => subjChipWrap.replaceChildren(...subjChips());
    this._paintSubjChips();
    f.append(this.toolBar([subjChipWrap]));

    /* subject_definitions -------------------------------------------- */
    const defsWrap = el("div");

    // Next unused speaker ID, based on IDs already bound in the definitions.
    const nextSpeakerId = () => {
      const used = new Set([...r.subjectDefs.map((d) => d.text).join("\n")
        .matchAll(/\(S(\d+)\)/g)].map((m) => +m[1]));
      let i = 1;
      while (used.has(i)) i++;
      return `S${i}`;
    };
    const firstTag = (kind, fallback) => {
      const inDefs = r.subjectDefs.map((d) => d.text).join("\n")
        .match(new RegExp(`<${kind} (\\d+)>`));
      if (inDefs) return `<${kind} ${inDefs[1]}>`;
      const slot = this.slots.find((s) => s.kind === kind && s.tag);
      return slot ? slot.tag : fallback;
    };

    // Applying a role rewrites the definition line and keeps
    // retention_analysis and the summary task types consistent with it.
    const applyAudioRole = (d, n, role) => {
      const ctx = {
        n,
        subj: firstTag("Subject", "<Subject 1>"),
        vid: firstTag("Video", "<Video 1>"),
        sx: (d.text.match(/\(S\d+\)/) || [nextSpeakerId()])[0].replace(/[()]/g, ""),
      };
      d.text = role.text(ctx);
      d.role = role.id;

      const label = `<Audio ${n}>`;
      let row = r.retention.find((x) => x.label === label);
      if (!row) { row = { label, context: "", marker: "", note: "" }; r.retention.push(row); }
      row.marker = role.marker;
      row.note = role.note(ctx);

      if (!r.summaryTypes.includes(role.task)) r.summaryTypes.push(role.task);
      this.render();
    };

    const applyPictureRole = (d, n, role) => {
      const ctx = { n, subj: firstTag("Subject", "<Subject 1>"), shot: 1 };
      d.text = role.text(ctx);
      d.role = role.id;

      const label = `<Picture ${n}>`;
      let row = r.retention.find((x) => x.label === label);
      if (!row) { row = { label, context: "", marker: "", note: "" }; r.retention.push(row); }
      row.marker = role.marker;
      row.note = role.note(ctx);
      if (!row.context) row.context = role.context(ctx);

      if (!r.summaryTypes.includes(role.task)) r.summaryTypes.push(role.task);
      this.render();
    };

    const drawDefs = () => {
      defsWrap.replaceChildren();
      r.subjectDefs.forEach((d, i) => {
        const mini = el("div", { class: "mmh3-minitags" });
        const roleRow = el("div", { class: "mmh3-roles" });
        const paintMini = () => {
          mini.replaceChildren(
            ...[...d.text.matchAll(/<(Subject|Picture|Video|Audio) (\d+)>/g)]
              .map((m) => el("span",
                { class: `mmh3-minitag ${TAG_CLASS[m[1]]}` }, `${m[1]} ${m[2]}`)));
          // Lines get one-click role presets for the tag they define.
          const am = d.text.match(/<Audio (\d+)>/);
          const pm = d.text.trim().match(/^<Picture (\d+)>/);
          roleRow.replaceChildren();
          if (pm && !am) {
            const n = pm[1];
            roleRow.append(el("span", { class: "mmh3-rolelabel" }, "role:"));
            PICTURE_ROLES.forEach((role) => {
              roleRow.append(el("span", {
                class: "mmh3-rolechip" + (d.role === role.id ? " on" : ""),
                title: role.title + ` \u2014 sets ${role.marker} + ${role.task}`,
                onclick: () => applyPictureRole(d, n, role),
              }, role.label));
            });
          }
          if (am) {
            const n = am[1];
            roleRow.append(el("span", { class: "mmh3-rolelabel" }, "role:"));
            AUDIO_ROLES.forEach((role) => {
              roleRow.append(el("span", {
                class: "mmh3-rolechip" + (d.role === role.id ? " on" : ""),
                title: role.title + ` \u2014 sets ${role.marker} + ${role.task}`,
                onclick: () => applyAudioRole(d, n, role),
              }, role.label));
            });
          }
        };
        const ta = el("textarea", { rows: 2, value: d.text,
          placeholder: "<Subject 1> is the ... in <Picture 1>, with ...",
          oninput: (e) => { d.text = e.target.value; d.role = null; paintMini(); } });
        paintMini();
        const row = el("div", { class: "mmh3-defrow" + (d.off ? " off" : "") },
          this.rowPower(d, drawDefs), ta,
          el("button", { class: "mmh3-btn ghost", title: "Remove line",
            onclick: () => { r.subjectDefs.splice(i, 1); drawDefs(); this.updatePreview(); },
          }, "\u2715"));
        defsWrap.append(row, mini, roleRow);
      });
    };
    drawDefs();
    const addDef = (seed) => {
      r.subjectDefs.push({ text: seed });
      drawDefs();
      const t = defsWrap.querySelector(".mmh3-defrow:last-of-type textarea");
      if (t) { t.focus(); t.selectionStart = t.selectionEnd = t.value.length; this.lastFocus = t; }
      this.updatePreview();
    };
    f.append(el("div", { class: "mmh3-sec" },
      this.secLabel("subject_definitions"),
      defsWrap,
      el("div", { class: "mmh3-tools" },
        el("button", { class: "mmh3-btn",
          onclick: () => addDef(`<Subject ${nextTagN("Subject")}> is `) }, "+ Subject"),
        el("button", { class: "mmh3-btn",
          onclick: () => addDef(`<Picture ${nextTagN("Picture")}> is `) }, "+ Picture line"),
        el("button", { class: "mmh3-btn",
          onclick: () => addDef(`<Video ${nextTagN("Video")}> is `) }, "+ Video line"),
        el("button", { class: "mmh3-btn",
          onclick: () => addDef(`<Audio ${nextTagN("Audio")}> is `) }, "+ Audio line")),
      el("span", { class: "hint" },
        "One line per tracked item. Focus a line, then click media chips above to assign " +
        "references to that subject. Audio lines show role chips underneath \u2014 pick one " +
        "and the definition, its retention marker, and the summary task type are filled in " +
        "for you. Standalone <Picture N> lines are only for concrete frame anchors or " +
        "storyboards; otherwise cite the picture inside the subject.")));

    /* summary --------------------------------------------------------- */
    f.append(el("div", { class: "mmh3-sec" },
      el("label", {}, "summary"),
      el("div", { class: "mmh3-ttypes" }, TASK_TYPES.map((t) =>
        el("label", {},
          el("input", { type: "checkbox", checked: r.summaryTypes.includes(t),
            onchange: (e) => {
              r.summaryTypes = e.target.checked
                ? [...r.summaryTypes, t]
                : r.summaryTypes.filter((x) => x !== t);
              this.updatePreview();
            } }), t))),
      this.ta(r, "summaryText", 3,
        "One short paragraph. Use the defined labels; for video editing start with " +
        "\"The target video is an edited version of <Video 1>.\""),
      el("span", { class: "hint" },
        "The bracketed prefix is assembled from the checkboxes, joined with \" + \".")));

    /* retention_analysis ---------------------------------------------- */
    const retWrap = el("div");
    // The item a definition line actually defines: the tag it opens with.
    // Pictures merely cited inside a subject are that subject's evidence, not
    // separate labels, so they never earn their own retention line.
    const definedLabels = () => {
      const seen = [];
      r.subjectDefs.forEach((d) => {
        const m = (d.text || "").match(/^\s*<(Subject|Picture|Video|Audio) (\d+)>/);
        if (!m) return;
        const tag = `<${m[1]} ${m[2]}>`;
        if (!seen.includes(tag)) seen.push(tag);
      });
      return seen;
    };

    const knownLabels = () => {
      const defText = r.subjectDefs.map((d) => d.text).join("\n");
      const found = new Set(
        [...defText.matchAll(/<(Subject|Picture|Video|Audio) (\d+)>/g)]
          .map((m) => `<${m[1]} ${m[2]}>`));
      this.slots.forEach((s) => { if (s.tag) found.add(s.tag); });
      return [...found].sort((a, b) => {
        const order = ["Subject", "Picture", "Video", "Audio"];
        const [, ka, na] = a.match(/<(\w+) (\d+)>/);
        const [, kb, nb] = b.match(/<(\w+) (\d+)>/);
        return ka === kb ? na - nb : order.indexOf(ka) - order.indexOf(kb);
      });
    };
    const drawRet = () => {
      retWrap.replaceChildren();
      r.retention.forEach((row, i) => {
        const markers = row.label?.startsWith("<Audio") ? AUDIO_MARKERS : VISUAL_MARKERS;
        if (!markers.includes(row.marker)) row.marker = markers[0];
        retWrap.append(el("div", { class: "mmh3-retrow" + (row.off ? " off" : "") },
          this.rowPower(row, drawRet),
          el("select", {
            onchange: (e) => { row.label = e.target.value; drawRet(); this.updatePreview(); } },
            knownLabels().map((l) =>
              el("option", { value: l, selected: l === row.label }, l))),
          el("input", { type: "text", value: row.context,
            dataset: { shotlist: "1" },
            placeholder: "appears in [Shot 1], [Shot 2]  \u2014 or leave empty",
            oninput: (e) => { row.context = e.target.value; } }),
          el("select", {
            onchange: (e) => { row.marker = e.target.value; this.updatePreview(); } },
            markers.map((m) => el("option", { value: m, selected: m === row.marker }, m))),
          el("button", { class: "mmh3-btn ghost",
            onclick: () => { r.retention.splice(i, 1); drawRet(); this.updatePreview(); } },
            "\u2715"),
          el("input", { class: "mmh3-retnote", type: "text", value: row.note,
            placeholder: (() => {
              const hint = roleHint(definitionFor(this.state, row.label));
              return hint ? `e.g. ${hint.note}`
                : "what exactly is retained / transferred / referenced";
            })(),
            oninput: (e) => { row.note = e.target.value; } }),
        ));
      });
    };
    drawRet();
    f.append(el("div", { class: "mmh3-sec" },
      this.secLabel("retention_analysis"),
      retWrap,
      el("div", { class: "mmh3-tools" },
        el("button", { class: "mmh3-btn", onclick: () => {
          const labels = knownLabels();
          if (!labels.length) { toast("Define a subject or connect media first"); return; }
          const used = new Set(r.retention.map((x) => x.label));
          const next = labels.find((l) => !used.has(l)) || labels[0];
          const hint = roleHint(definitionFor(this.state, next));
          r.retention.push({ label: next, context: "",
            marker: hint?.marker
              || (next.startsWith("<Audio") ? "reference" : "fully_preserved"),
            // When the definition states the role outright, write the matching
            // note rather than only hinting at it — the role chips already do.
            note: hint ? hint.note : "" });
          drawRet(); this.updatePreview();
        } }, "+ Entry"),
        el("button", { class: "mmh3-btn",
          title: "One entry per item defined above \u2014 not per picture cited " +
            "inside a subject",
          onclick: () => {
            const labels = definedLabels();
            if (!labels.length) {
              toast("Define a subject or standalone reference first", 3000);
              return;
            }
            const used = new Set(r.retention.map((x) => x.label));
            let added = 0;
            labels.forEach((l) => {
              if (used.has(l)) return;
              const hint = roleHint(definitionFor(this.state, l));
              r.retention.push({ label: l, context: "",
                marker: hint?.marker
                  || (l.startsWith("<Audio") ? "reference" : "fully_preserved"),
                note: hint ? hint.note : "" });
              added += 1;
            });
            drawRet(); this.updatePreview();
            if (!added) toast("Every defined label already has an entry", 2600);
          } }, "Auto-fill from labels")),
      el("span", { class: "hint" },
        "Visual labels: fully_preserved / partially_preserved / attribute_transfer / " +
        "weak_reference. Audio labels: fully_copy / partially_copy / reference / weak_reference.")));

    /* detailed_description --------------------------------------------- */
    const wcSpan = el("span", { class: "hint" });
    const paintWc = () => {
      const wc = r.detail.trim() ? r.detail.trim().split(/\s+/).length : 0;
      wcSpan.textContent = `${wc} words \u2014 generation tasks normally 350\u2013500. ` +
        "First appearance of each <Subject N>: describe its referenced traits, frame " +
        "position, and current action.";
    };
    paintWc();
    const detTa = this.ta(r, "detail", 14,
      "[Shot 1] A medium shot establishes <Subject 1>, ...\n[Shot 2] At 00:03.000, the shot cuts to ...");
    detTa.addEventListener("input", paintWc);
    f.append(el("div", { class: "mmh3-sec" },
      el("label", {}, "detailed_description \u2014 style opening (before [Shot 1])"),
      this.ta(r, "styleLine", 2,
        "The target video is in a realistic multi-camera sitcom style with warm indoor lighting.")));
    f.append(el("div", { class: "mmh3-sec" },
      el("label", {}, "detailed_description \u2014 shots"),
      detTa, wcSpan));

    /* audio sections ---------------------------------------------------- */
    f.append(el("div", { class: "mmh3-sec" },
      this.secLabel("overall_soundscape"),
      el("div", { class: "mmh3-row" },
        this.ta(r, "soundscape", 3,
          "Ambience + physical sounds. If copying ambience: \"The copied ambience layer " +
          "from <Audio 1> continues throughout the target video.\""),
        this.naButton(r, "soundscape"))));
    f.append(el("div", { class: "mmh3-sec" },
      this.secLabel("non_diegetic_music"),
      el("div", { class: "mmh3-row" },
        this.ta(r, "music", 3,
          "Audience-only score. If reused: \"<Audio 2> is directly reused as the complete " +
          "audience-only score.\""),
        this.naButton(r, "music"))));
  }

  /* ---------- preview + validation ---------- */

  /** Small on/off switch for a single line. Off keeps the row in the editor
   *  but leaves it out of the prompt — for when the media it describes is
   *  temporarily unplugged. */
  rowPower(obj, redraw) {
    const dot = el("span", {
      class: "mmh3-rowpow" + (obj.off ? "" : " on"),
      title: obj.off ? "Left out of the prompt \u2014 click to include"
                     : "Included \u2014 click to leave out of the prompt",
      onclick: () => {
        obj.off = !obj.off;
        redraw();
        this.updatePreview();
      },
    }, obj.off ? "\u25cb" : "\u25c9");
    return dot;
  }

  /** Section heading with an on/off switch. Off keeps the text but stops the
   *  section reaching the prompt — handy while media comes and goes. */
  secLabel(name, text) {
    const state = this.state;
    state.off = state.off || {};
    const on = !state.off[name];
    const dot = el("span", {
      class: "mmh3-secpow" + (on ? " on" : ""),
      title: on ? "Included \u2014 click to leave it out of the prompt"
                : "Left out of the prompt \u2014 click to include it again",
      onclick: () => {
        if (state.off[name]) delete state.off[name];
        else state.off[name] = true;
        this.render();
        this.updatePreview();
      },
    }, on ? "\u25c9" : "\u25cb");
    return el("label", { class: on ? "" : "off" }, dot, text || name);
  }

  updatePreview() {
    this._paintSubjChips?.();
    const text = generate(this.state);
    this._citeText = text;
    let html = escapeHtml(text)
      .replace(/&lt;(Subject|Picture|Video|Audio) (\d+)&gt;/g,
        (m, k, n) => `<span class="t-${TAG_CLASS[k]}">&lt;${k} ${n}&gt;</span>`)
      .replace(/\[Shot (\d+)\]/g, '<span class="t-shot">[Shot $1]</span>')
      .replace(/&lt;(\/?d|scenetrans|cutoff)&gt;/g, '<span class="t-d">&lt;$1&gt;</span>');
    this.previewEl.innerHTML = html;

    const rank = { error: 0, warn: 1, info: 2 };
    const icon = { error: "\u26d4 ", warn: "\u26a0 ", info: "\u2139 " };
    const issues = validate(this.state, this.slots)
      .sort((a, b) => rank[a.level] - rank[b.level]);
    this.issuesEl.replaceChildren(...(issues.length
      ? issues.map((i) => el("div", { class: i.level }, icon[i.level] + i.msg))
      : [el("div", { class: "ok" }, "\u2713 No issues found")]));

    let stats = `${text.length} chars`;
    if (this.state.mode === "FL2VA" || this.state.mode === "L2VA") {
      const frames = snapLength(this.state.duration);
      stats += ` \u2022 length ${frames} (${fmtSS(frames / 24)}s)`;
    } else {
      const cuts = [...text.matchAll(/At (\d{2}):(\d{2})\.(\d{3})/g)];
      if (cuts.length) {
        const last = cuts[cuts.length - 1];
        const sec = tsToMs(last[1], last[2], last[3]) / 1000;
        const L = minLengthAfter(sec);
        stats += ` \u2022 last cut ${fmtTimestamp(sec)} \u2192 length \u2265 ${L} (${fmtSS(L / 24)}s)`;
      }
    }
    this.statsEl.textContent = stats;
  }
}

/* ------------------------------------------------------------------ */
/* Node integration                                                    */
/* ------------------------------------------------------------------ */

function hideWidget(node, name) {
  const w = node.widgets?.find((w) => w.name === name);
  if (!w) return;
  w.hidden = true;                       // respected by the new frontend
  w.computeSize = () => [0, -4];         // legacy layout fallback
  w.type = "hidden";
  if (w.inputEl) w.inputEl.style.display = "none";
  if (w.element) w.element.style.display = "none";
}

/** Create a Media Loader beside this node and connect it, or focus the
 *  existing one if the references input is already wired. */
function addMediaLoader(node) {
  const inIdx = (node.inputs || []).findIndex((i) => i.name === "references");
  if (inIdx < 0) { toast("This node has no references input"); return; }

  const existing = node.inputs[inIdx].link != null ? originNode(node, inIdx) : null;
  if (existing) {
    // Focusing the canvas is renderer-specific; open its editor if that fails.
    if (!safeCanvasFocus(existing)) openLoaderModal(existing);
    toast("Media Loader is already connected");
    return;
  }

  let loader = null;
  try {
    loader = LiteGraph.createNode(LOADER_NAME);
  } catch (e) { loader = null; }
  if (!loader) {
    toast("Media Loader node not found \u2014 restart ComfyUI");
    return;
  }
  app.graph.add(loader);
  try {
    loader.pos = [node.pos[0] - ((loader.size?.[0] || 430) + 60), node.pos[1]];
  } catch (e) { /* let the renderer place it */ }
  loader.connect(0, node, inIdx);   // slot 0 is the references bundle
  try {
    node.setDirtyCanvas?.(true, true);
    app.graph.setDirtyCanvas(true, true);
  } catch (e) { /* Vue redraws itself */ }
  toast("Media Loader added and connected");
}

function openEditor(node) {
  try {
    new Editor(node);
  } catch (err) {
    console.error("[MiniMaxH3 PromptBuilder] failed to open editor:", err);
    toast(`Couldn't open the editor: ${err?.message || err}. ` +
      "See the browser console (F12) for details.", 8000);
  }
}

function updateSummary(node) {
  if (!node._mmh3Summary) return;
  const state = loadState(node);
  const pw = node.widgets?.find((w) => w.name === "prompt_text");
  const text = (pw?.value || "").trim();
  const allSlots = getRefSlots(node);
  const refs = allSlots.filter((s) => s.tag).length;
  const orphans = allSlots.filter((s) => s.orphan != null).length;
  const first = text ? escapeHtml(text.split("\n").find((l) => l.trim()) || "").slice(0, 110)
    : "<i>empty \u2014 click Edit prompt</i>";
  const durSeg = (state.mode === "FL2VA" || state.mode === "L2VA")
    ? ` \u2022 ${fmtSS(snapLength(state.duration) / 24)}s (${snapLength(state.duration)}f)`
    : "";
  const cap = MODE_CAPACITY[state.mode] || {};
  let refSeg = refs
    ? ` \u2022 ${refs} ref${refs > 1 ? "s" : ""}${allSlots.bundled ? " (loader)" : ""}`
    : "";
  if (state.mode === "REF" && cap.total && refs > cap.total)
    refSeg = ` \u2022 <span style="color:#f07070">${refs} refs \u2014 over the ` +
      `${cap.total} limit</span>`;
  if (orphans)
    refSeg += ` \u2022 <span style="color:#f07070">${orphans} unpaired ` +
      `soundtrack${orphans > 1 ? "s" : ""}</span>`;
  node._mmh3Summary.innerHTML =
    `<b>${state.mode === "REF" ? "Full-reference" : state.mode}</b>` +
    durSeg + refSeg +
    `<br>${first}${text.length > 110 ? "\u2026" : ""}`;
}

app.registerExtension({
  name: "MiniMaxH3.PromptBuilder",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    console.log("[MiniMaxH3 PromptBuilder] extension registered");

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      injectCSS();
      hideWidget(this, "prompt_text");
      hideWidget(this, "builder_state");

      // Canvas buttons first so no DOM widget can sit on top of them.
      this.addWidget("button", "Edit prompt\u2026", null, () => openEditor(this));
      this.addWidget("button", "+ Media loader", null, () => addMediaLoader(this));

      // Clickable DOM summary as a second, layout-independent way in.
      if (this.addDOMWidget) {
        const summary = el("div", {
          class: "mmh3-summary",
          title: "Open the prompt editor",
          style: { cursor: "pointer", height: "46px", minHeight: "46px" },
          onclick: () => openEditor(this),
        });
        this._mmh3Summary = summary;
        const sw = this.addDOMWidget("mmh3_summary", "div", summary,
          { serialize: false });
        // Explicit height so either renderer reserves space for it.
        sw.computedHeight = 46;
        sw.computeSize = () => [330, 46];
      }

      try { this.size[0] = Math.max(this.size[0], 330); } catch (e) { /* Vue sizes it */ }
      setTimeout(() => updateSummary(this), 0);
      return r;
    };

    // Canvas-only convenience; the button and summary panel are the
    // renderer-independent ways in.
    const onDblClick = nodeType.prototype.onDblClick;
    nodeType.prototype.onDblClick = function (e, pos, canvas) {
      openEditor(this);
      return onDblClick?.apply(this, arguments) ?? true;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => updateSummary(this), 0);
      return r;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      setTimeout(() => updateSummary(this), 0);
      return r;
    };
  },
});
