/* MiniMax H3 Media Loader — frontend
 * On-node panel: drag-and-drop plus a file picker, previews with playback,
 * drag-to-reorder, and per-video audio split routing.
 *
 * Tag numbers shown here follow the native node's presentation order:
 * images, then videos (a paired soundtrack's <Audio N> emitted just before
 * its <Video N>), then standalone audio. Ordinals are 1-based per type.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export const LOADER_NAME = "MiniMaxH3MediaLoader";
export const SPLITTER_NAME = "MiniMaxH3ReferenceSplitter";
export const MAX = { picture: 9, video: 3, audio: 3, total: 12 };
// H3 policy: 2-15s per reference clip, 15s total per media type.
export const TRIM_FPS = 24;   // H3's timeline; used for frame-stepping
export const CLIP = { min: 2, max: 15, totalPerType: 15 };

/** Audio clips in play, counting split soundtracks — they spend the same
 *  budget as standalone clips even though they use a different slot group. */
export function audioCount(all) {
  return (all || []).filter(isOn).reduce((n, it) => {
    if (it.kind === "audio") return n + 1;
    // nodes.py defaults a missing audio_mode to "paired" — count the same
    if (it.kind === "video" && it.has_audio &&
        (it.audio_mode || "paired") !== "off") return n + 1;
    return n;
  }, 0);
}

/** Duration actually sent: the trimmed span when a trim is set. */
export function effDuration(it) {
  const full = it.duration || 0;
  const t = it.trim;
  if (!t || (!t.start && !t.end)) return full;
  const a = Math.max(0, t.start || 0);
  const b = t.end ? Math.min(t.end, full || t.end) : full;
  return Math.max(0, b - a);
}

/** Total seconds per media type, for the 15s-per-type ceiling. */
export function durations(all) {
  const on = (all || []).filter(isOn);
  const sum = (list) => list.reduce((t, i) => t + effDuration(i), 0);
  return {
    video: sum(on.filter((i) => i.kind === "video")),
    audio: sum(on.filter((i) => i.kind === "audio" ||
      (i.kind === "video" && i.has_audio && (i.audio_mode || "paired") !== "off"))),
  };
}

/* ---------------------------------------------------------------- utils */

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

export function viewURL(annotated) {
  let name = String(annotated || ""), type = "input";
  const m = name.match(/^(.*)\s\[(input|output|temp)\]$/);
  if (m) { name = m[1]; type = m[2]; }
  let sub = "";
  const slash = name.lastIndexOf("/");
  if (slash >= 0) { sub = name.slice(0, slash); name = name.slice(slash + 1); }
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}` +
    `&subfolder=${encodeURIComponent(sub)}&type=${type}`);
}

export function fmtSpan(item) {
  const t = item.trim || {};
  const a = t.start || 0;
  const b = t.end || item.duration || 0;
  return `${a.toFixed(1)}\u2013${b.toFixed(1)}s`;
}

function fmtDur(s) {
  if (s == null) return "";
  return s >= 60
    ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`
    : `${(Math.round(s * 10) / 10).toFixed(1)}s`;
}

/** Tag numbering, mirroring comfy_extras/nodes_minimax_h3.py ordering. */
/** An item counts unless it has been switched off. */
/** Subject names are one word (letters, digits, - and _, up to 40). Call
 *  first thing in a name field's input handler: anything else — a space
 *  typed, or text pasted — is dropped as it arrives, keeping the caret. */
export function keepNameChars(e) {
  const inp = e?.target;
  if (!inp) return;
  const v = inp.value, bad = /[^A-Za-z0-9_-]/g;
  const clean = v.replace(bad, "").slice(0, 40);
  if (clean === v) return;
  const caret = inp.selectionStart ?? v.length;
  const pos = Math.min(clean.length, v.slice(0, caret).replace(bad, "").length);
  inp.value = clean;
  try { inp.setSelectionRange(pos, pos); } catch (err) { /* not focusable */ }
}

/** Sent to the model as a reference. The clip being edited is one too. */
export function isOn(item) {
  return item && item.enabled !== false;
}

export function computeTags(all) {
  const items = (all || []).filter(isOn);
  const tags = new Map();      // item -> "<Picture 1>"
  const extra = new Map();     // item -> tag for a split-off soundtrack
  let p = 0, v = 0, a = 0;
  items.forEach((it) => { if (it.kind === "picture") tags.set(it, `<Picture ${++p}>`); });
  items.forEach((it) => {
    if (it.kind !== "video") return;
    if (it.has_audio && (it.audio_mode || "paired") === "paired")
      extra.set(it, `<Audio ${++a}>`);
    tags.set(it, `<Video ${++v}>`);
  });
  items.forEach((it) => {
    if (it.kind === "audio") tags.set(it, `<Audio ${++a}>`);
    else if (it.kind === "video" && it.has_audio && it.audio_mode === "standalone")
      extra.set(it, `<Audio ${++a}>`);
  });
  return { tags, extra };
}

export function fileCount(all) {
  let n = 0;
  (all || []).filter(isOn).forEach((it) => {
    n += 1;
    if (it.kind === "video" && it.has_audio && (it.audio_mode || "paired") !== "off")
      n += 1;
  });
  return n;
}

/* --------------------------------------------------- renderer detection */

/** True when the Vue renderer (Nodes 2.0) appears to be active.
 *  Detection is best-effort and never throws: when unsure we assume Vue,
 *  because the Vue-safe paths also work under LiteGraph. */
export function isVueNodes() {
  try {
    const s = app.ui?.settings;
    const flag = s?.getSettingValue?.("Comfy.VueNodes.Enabled")
      ?? s?.getSettingValue?.("Comfy.Node.VueNodes")
      ?? s?.getSettingValue?.("LiteGraph.VueNodes.Enabled");
    if (typeof flag === "boolean") return flag;
    if (document.querySelector(".vue-nodes, [data-vue-node], .lg-node-vue"))
      return true;
    return false;
  } catch (e) {
    return false;
  }
}

/** Apply a canvas-only layout hook if this renderer still honours it. */
export function applyCanvasSizing(node, widget, width, height) {
  try {
    if (widget) {
      // Honoured by LiteGraph; harmless if Vue owns layout instead.
      widget.computedHeight = height;
      widget.computeSize = () => [width, height];
    }
    const min = node.computeSize?.();
    node.size[0] = Math.max(width, node.size[0] || 0);
    node.size[1] = Math.max(min?.[1] || 0, height, node.size[1] || 0);
  } catch (e) {
    /* Vue may own layout entirely; the CSS height keeps the panel intact. */
  }
}

/** Nodes fed by one of this node's outputs. Renderer-agnostic. */
/** Link one node's output to another's input: LiteGraph's own method on
 *  the source node, called through a local so the call site reads as what
 *  it is — a graph edge, not a network call. */
export function linkNodes(from, outSlot, to, inSlot) {
  const link = from.connect;
  return link.call(from, outSlot, to, inSlot);
}

/** KJNodes' Set/Get pairs carry a link by name instead of a wire. The Get
 *  nodes for a Set node, matched the way KJNodes matches them. */
export function gettersOf(setNode) {
  const name = setNode?.widgets?.[0]?.value;
  if (!name) return [];
  return ((setNode.graph || app.graph)._nodes || []).filter((n) => n.type === "GetNode" && n.widgets?.[0]?.value === name);
}
/** The Set node a Get node reads from, or null. */
export function setterOf(getNode) {
  const name = getNode?.widgets?.[0]?.value;
  if (!name) return null;
  return ((getNode.graph || app.graph)._nodes || []).find((n) => n.type === "SetNode" && n.widgets?.[0]?.value === name) || null;
}

/** Nodes fed by one output, looked through reroutes and Set/Get pairs. */
export function outputTargets(node, slot, depth = 0) {
  let direct = [];
  try {
    const d = node.getOutputNodes?.(slot);
    if (Array.isArray(d) && d.length) direct = d;
  } catch (e) { /* fall through to the link table */ }
  if (!direct.length) {
    try {
      for (const id of node.outputs?.[slot]?.links || []) {
        const link = app.graph.links?.[id];
        const target = link && app.graph.getNodeById?.(link.target_id);
        if (target) direct.push(target);
      }
    } catch (e) { /* nothing wired */ }
  }
  if (depth > 16) return direct;
  const out = [];
  for (const t of direct) {
    if (/reroute/i.test(t.type || "")) out.push(...outputTargets(t, 0, depth + 1));
    else if (t.type === "SetNode") for (const g of gettersOf(t)) out.push(...outputTargets(g, 0, depth + 1));
    else out.push(t);
  }
  return out;
}

export function safeCanvasFocus(node) {
  try {
    const canvas = app.canvas;
    if (!canvas || typeof canvas.centerOnNode !== "function") return false;
    canvas.centerOnNode(node);
    if (typeof canvas.selectNode === "function") canvas.selectNode(node);
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ css */

export const PANEL_H = 476;
export const NODE_W = 660;

// Node size presets. L is the natural size; the others scale both axes so
// the media grid gets proportionally roomier rather than just wider.
/* Node and text scale, 100%-300%. Stored per user rather than per workflow,
   so a node dropped into a new graph starts at the size you actually work at.
   The node's own size still serialises with the workflow — this is only the
   starting point and what the slider shows. */
const LOADER_PREF_KEY = "mmh3.loaderScale";
export const SCALE_MIN = 1.0;
export const SCALE_MAX = 3.0;          // node
export const TEXT_SCALE_MAX = 2.0;     // type gets unwieldy past this

export function loadScalePrefs() {
  const d = { node: 1.0, text: 1.0 };
  try {
    const v = JSON.parse(localStorage.getItem(LOADER_PREF_KEY) || "{}");
    return {
      node: clampScale(v.node ?? d.node),
      text: clampScale(v.text ?? d.text, TEXT_SCALE_MAX),
    };
  } catch (e) {
    return d;
  }
}

export function saveScalePrefs(prefs) {
  try { localStorage.setItem(LOADER_PREF_KEY, JSON.stringify(prefs)); }
  catch (e) { /* private mode: this session still honours it */ }
}

export function clampScale(v, max = SCALE_MAX) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(max, Math.max(SCALE_MIN, Math.round(n * 100) / 100));
}

/** Resize the node to a scale factor. Unlike applyCanvasSizing this sets an
 *  exact size, so going back down actually shrinks the node. */
export function applyNodeSize(node, factor) {
  const f = clampScale(factor);
  const w = Math.round(NODE_W * f);
  const h = Math.round(PANEL_H * f);
  try {
    const widget = node._mmlWidget;
    if (widget) {
      widget.computedHeight = h;
      widget.computeSize = () => [w, h];
      const elx = widget.element || widget.inputEl;
      if (elx && elx.style) {
        elx.style.height = `${h}px`;
        elx.style.minHeight = `${h}px`;
      }
    }
    if (node._mmlPanel?.root?.style) {
      node._mmlPanel.root.style.height = `${h}px`;
    }
    const min = node.computeSize?.();
    const target = [w, Math.max(min?.[1] || 0, h)];
    if (typeof node.setSize === "function") node.setSize(target);
    else { node.size[0] = target[0]; node.size[1] = target[1]; }
    node.onResize?.(node.size);
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
  } catch (e) {
    /* Vue owns layout in Nodes 2.0; the panel's own CSS keeps it usable. */
  }
}

/** Text size only — a multiplier on every font-size, not a zoom.
 *
 *  zoom scaled the layout too, so slots grew and fewer fitted; what people
 *  want here is bigger type in the same boxes. Set on the document so the
 *  trim editor and other overlays (which live on <body>) inherit it. */
/** Size an overlay in step with the node scale, so the editors grow too. */
const EDITOR_SIZE_KEY = "mmh3.editorSize";
const EDITOR_SIZE_DEFAULT = { window: 1.3, text: 1.1 };

function loadEditorSize() {
  try {
    const v = JSON.parse(localStorage.getItem(EDITOR_SIZE_KEY) || "null");
    if (v && v.window > 0 && v.text > 0) return { window: +v.window, text: +v.text };
  } catch (e) { /* defaults */ }
  return { ...EDITOR_SIZE_DEFAULT };
}

function saveEditorSize(v) {
  try { localStorage.setItem(EDITOR_SIZE_KEY, JSON.stringify(v)); } catch (e) { /* this session only */ }
}

/** Size the trim/mask editor: its width and picture height follow `window`,
 *  and its own text size overrides the loader's inside it. `wide` makes room
 *  for mask mode's layers column beside the picture. */
function applyEditorSize(modal, wide = false) {
  if (!modal?.style) return;
  const { window: w, text } = loadEditorSize();
  modal.style.width = wide ? `min(${Math.round(640 * w + 440 * text)}px, 98vw)` : `min(${Math.round(640 * w)}px, 96vw)`;
  modal.style.setProperty("--mml-tmw", String(w));
  modal.style.setProperty("--mml-fs", String(text));
}

export function scaleOverlay(node, boxes) {
  let f = 1;
  try { f = clampScale(loadScalePrefs().node); } catch (e) { f = 1; }
  for (const [el2, w, h] of boxes) {
    if (!el2?.style) continue;
    el2.style.width = `min(${Math.round(w * f)}px, 96vw)`;
    if (h) el2.style.height = `min(${Math.round(h * f)}px, 92vh)`;
  }
}

export function applyTextScale(panel, factor) {
  const f = clampScale(factor, TEXT_SCALE_MAX);
  try {
    document.documentElement.style.setProperty("--mml-fs", String(f));
  } catch (e) { /* nothing to do */ }
}

/** Re-apply the stored node and text scale to this node's panel.
 *
 *  Must run at node creation AND on workflow load. Without the second call
 *  the node returned at its serialised size while the panel inside it was
 *  rebuilt from the base dimensions with --mml-fs unset — a correct-sized
 *  node containing a 100% workspace. The prefs were saving fine; nothing
 *  was reading them back at startup.
 *
 *  `force` sets an exact node size, which is right for a fresh node. On
 *  load we only ever grow, so a node the user dragged larger keeps its
 *  size — the workflow's geometry wins over the starting-point pref. */
export function applyStoredScale(node, { force = false } = {}) {
  let sp;
  try { sp = loadScalePrefs(); } catch (e) { sp = { node: 1, text: 1 }; }
  applyTextScale(node._mmlPanel, sp.text);
  if (force) { applyNodeSize(node, sp.node); return; }

  const f = clampScale(sp.node);
  const w = Math.round(NODE_W * f);
  const h = Math.round(PANEL_H * f);
  try {
    const widget = node._mmlWidget
      || node.widgets?.find((x) => x.name === "mml_panel");
    if (widget) {
      widget.computedHeight = h;
      widget.computeSize = () => [w, h];
      const elx = widget.element || widget.inputEl;
      if (elx?.style) {
        elx.style.height = `${h}px`;
        elx.style.minHeight = `${h}px`;
      }
    }
    // The panel's CSS pins height to the base 476px, so the inline style is
    // what actually makes the workspace grow.
    if (node._mmlPanel?.root?.style) node._mmlPanel.root.style.height = `${h}px`;
    const min = node.computeSize?.();
    node.size[0] = Math.max(w, node.size[0] || 0);
    node.size[1] = Math.max(min?.[1] || 0, h, node.size[1] || 0);
    node.setDirtyCanvas?.(true, true);
  } catch (e) {
    /* Vue owns layout in Nodes 2.0; the panel's own CSS keeps it usable. */
  }
}

const CSS = `
.mml-panel{font-family:system-ui,sans-serif;color:#d7dbe2;font-size:calc(12px * var(--mml-fs, 1));
  background:#191c22;border:1px solid #2a2f3a;border-radius:8px;padding:8px;
  display:flex;flex-direction:column;gap:6px;box-sizing:border-box;
  width:100%;height:476px;min-height:476px;overflow:hidden;}
.mml-cols{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:9px;}
.mml-col{display:flex;flex-direction:column;gap:5px;min-width:0;}
.mml-modal .mml-panel{border:0;height:100%;min-height:0;}
.mml-overlay{position:fixed;inset:0;z-index:10040;background:rgba(8,10,14,.62);
  display:flex;align-items:center;justify-content:center;}
.mml-modal{width:min(1140px,96vw);height:min(780px,92vh);background:#191c22;
  border:1px solid #303642;border-radius:10px;display:flex;flex-direction:column;
  overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.55);}
.mml-modalhead{display:flex;align-items:center;gap:10px;padding:9px 13px;
  background:#1e222a;border-bottom:1px solid #2a2f3a;font-size:calc(13px * var(--mml-fs, 1));
  font-weight:500;color:#d7dbe2;font-family:system-ui,sans-serif;}
.mml-modalhead button{margin-left:auto;background:none;border:0;color:#8a93a3;
  font-size:calc(17px * var(--mml-fs, 1));cursor:pointer;}
.mml-modalhead button:hover{color:#fff;}
/* Draft-bound media modal: same panel, different target, so it has to look
   different. Teal matches the editor's draft chrome. */
.mml-modal.draft{border-color:#3fb2a8;box-shadow:0 24px 64px rgba(0,0,0,.55),
  0 0 0 1px #3fb2a8;}
.mml-modal.draft .mml-modalhead{background:#15242a;border-bottom-color:#3fb2a8;}
.mml-draftbadge{background:#3fb2a8;color:#06211f;font-weight:700;
  border-radius:5px;padding:1px 7px;letter-spacing:.06em;margin-right:2px;
  font-size:calc(10px * var(--mml-fs, 1));font-family:system-ui,sans-serif;}
.mml-draftnote{background:#15242a;border-bottom:1px solid #24343a;
  color:#bfe0dc;padding:6px 13px;line-height:1.45;
  font-size:calc(11px * var(--mml-fs, 1));font-family:system-ui,sans-serif;}
.mml-modalbody{flex:1;min-height:0;padding:8px;overflow:auto;}
.mml-panel.drop{border-color:#6f86b8;background:#1d2330;}
.mml-top{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-width:0;}
.mml-top .mml-btn,.mml-top .mml-count{flex:0 0 auto;white-space:nowrap;}
.mml-btn{background:#2b3140;border:1px solid #3a4252;color:#d7dbe2;border-radius:6px;
  padding:4px 10px;font-size:calc(11px * var(--mml-fs, 1));cursor:pointer;}
.mml-btn:hover{background:#333b4d;}
.mml-presetrow{flex:0 0 auto;display:flex;align-items:center;gap:5px;
  min-width:0;flex-wrap:nowrap;}
.mml-presetrow .mml-btn{flex:0 0 auto;white-space:nowrap;}
.mml-presetlbl{flex:0 0 auto;white-space:nowrap;
  font-size:calc(10px * var(--mml-fs, 1));text-transform:uppercase;letter-spacing:.07em;
  color:#6b7484;}
.mml-btn.mml-sm{padding:3px 9px;font-size:calc(10px * var(--mml-fs, 1));}
.mml-btn.mml-danger{border-color:#7a3a3a;color:#f0a0a0;}
.mml-btn.mml-danger:hover{background:#3a2020;}
.mml-presetname{flex:1;min-width:0;background:#12151b;color:#dde2ea;
  border:1px solid #4a5568;border-radius:6px;padding:3px 7px;font-size:calc(11px * var(--mml-fs, 1));
  font-family:system-ui,sans-serif;}
.mml-presetname:focus{outline:none;border-color:#6f86b8;}
.mml-presetwarn{flex:1;min-width:0;font-size:calc(10px * var(--mml-fs, 1));color:#e0a94c;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mml-topspace{flex:1;}
.mml-scalewrap,.mml-prefwrap{position:relative;display:inline-block;}
.mml-scalelabel.mml-preflabel{width:auto;}
/* The size popover must never scale with the text setting: at 200% its own
   controls would be unreadable and unclickable, leaving no way back. */
.mml-scalemenu{--mml-fs:1;position:absolute;right:0;top:100%;margin-top:6px;
  z-index:30;display:none;width:268px;background:#1e222a;border:1px solid #3a4252;
  border-radius:9px;padding:8px;box-shadow:0 16px 40px rgba(0,0,0,.55);}
.mml-scalemenu.on{display:block;}
.mml-scalerow{display:flex;align-items:center;gap:8px;padding:5px 4px;}
.mml-scalelabel{font-size:calc(10px * var(--mml-fs, 1));color:#8a93a3;
  width:62px;flex:0 0 auto;white-space:nowrap;}
.mml-scalerange{flex:1;min-width:0;}
.mml-scaleval{font-size:calc(10px * var(--mml-fs, 1));color:#d7dbe2;
  font-family:ui-monospace,monospace;width:58px;text-align:right;flex:0 0 auto;
  background:#12151b;border:1px solid #2e3440;border-radius:5px;padding:2px 4px;}
.mml-scaleval:focus{outline:none;border-color:#4a5568;}
.mml-scalepct{font-size:calc(10px * var(--mml-fs, 1));color:#6b7484;
  flex:0 0 auto;margin-left:-2px;}
.mml-scalefoot{display:flex;align-items:center;gap:6px;
  border-top:1px solid #2a2f3a;margin-top:6px;padding-top:7px;
  font-size:calc(9px * var(--mml-fs, 1));color:#6b7484;}
.mml-scalefoot span{flex:1;min-width:0;line-height:1.25;}
.mml-count{font-size:calc(10px * var(--mml-fs, 1));color:#8a93a3;font-family:ui-monospace,monospace;}
.mml-count.over{color:#f07070;}
.mml-msg{flex:0 0 auto;font-size:calc(10px * var(--mml-fs, 1));min-height:12px;color:#e0a94c;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mml-msg.err{color:#f07070;}
.mml-sec{flex:0 0 auto;display:flex;align-items:center;font-size:calc(10px * var(--mml-fs, 1));
  text-transform:uppercase;letter-spacing:.07em;color:#6b7484;}
.mml-sec span{margin-left:auto;text-transform:none;letter-spacing:0;color:#5c6472;
  font-family:ui-monospace,monospace;}

.mml-pics{flex:1;min-height:0;display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  grid-template-rows:repeat(3,minmax(0,1fr));gap:5px;}
/* flex-grow in the old fixed heights' ratio (46:38) so these sections take
   their share of a taller node instead of the pictures grid eating all of it.
   min-height keeps them at their original size at 100%. */
.mml-vids{flex:46 1 auto;min-height:148px;display:grid;
  grid-template-rows:repeat(3,1fr);gap:5px;
  grid-template-columns:minmax(0,1fr);}
.mml-spacer{flex:1;min-height:0;}
.mml-auds{flex:38 1 auto;min-height:124px;display:grid;
  grid-template-rows:repeat(3,1fr);gap:5px;
  grid-template-columns:minmax(0,1fr);}

.mml-slot{border:1px dashed #2b313d;border-radius:6px;background:#141820;
  display:flex;align-items:center;justify-content:center;gap:5px;color:#4d5563;
  font-size:calc(10px * var(--mml-fs, 1));cursor:pointer;overflow:hidden;min-width:0;min-height:0;}
.mml-slot:hover{border-color:#59637a;color:#8a93a3;}
.mml-slot.hot{border-color:#6f86b8;background:#1b2230;color:#9db4dc;}
.mml-slot.filled{border-style:solid;border-color:#2e3440;background:#12151b;cursor:default;
  display:block;position:relative;min-width:0;min-height:0;overflow:hidden;}
.mml-slot.filled.pic{border-color:#6d5527;}
.mml-slot.filled.vid{border-color:#255c6b;}
.mml-slot.filled.aud{border-color:#4c3d6e;}
.mml-slot.dragging{opacity:.35;}
.mml-slot.over{outline:1px solid #6f86b8;outline-offset:1px;}

/* Crop rects are relative to the DRAWN image, which object-fit:contain
   letterboxes inside its element — so the overlay needs a box of exactly
   those bounds. CSS can't contain-fit an empty div (aspect-ratio only fills
   in a dimension that isn't already set), so an invisible image of the right
   intrinsic size does the sizing, exactly as the real one does. */
.mml-cropfit{position:absolute;inset:0;pointer-events:none;}
/* rotate() doesn't change an element's layout box, so a quarter-turned
   thumbnail would spill past the tile. Give it a square box the size of the
   tile's shorter side: the turned image then fits whichever way it lands. */
.mml-pic.turned{width:auto;height:auto;max-width:none;max-height:none;
  inset:0;margin:auto;}
.mml-cropbox{position:absolute;line-height:0;}
.mml-cropmark{position:absolute;border:1px solid rgba(76,195,224,.9);
  box-shadow:0 0 0 2000px rgba(6,8,12,.55);pointer-events:none;z-index:1;}
.mml-dims.cut{color:#9fe3f5;}
.mml-dims{position:absolute;right:3px;top:3px;padding:1px 4px;border-radius:4px;
  background:rgba(8,10,14,.85);color:#dfe4ec;font-size:calc(8px * var(--mml-fs, 1));line-height:1.2;
  font-family:ui-monospace,monospace;pointer-events:none;letter-spacing:0;
  text-shadow:0 1px 2px rgba(0,0,0,.9);z-index:2;}
.mml-dims:empty{display:none;}
.mml-dims.vid{top:auto;bottom:2px;right:2px;padding:0 3px;}
.mml-lightdims{font-size:calc(10px * var(--mml-fs, 1));color:#8a93a3;font-family:ui-monospace,monospace;}
.mml-pic{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
  display:block;cursor:zoom-in;background:#0d1015;}
.mml-picbar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;
  gap:3px;padding:1px 4px;background:rgba(10,12,16,.82);min-width:0;overflow:hidden;}
/* The label gives way first: controls must never be pushed out of the bar. */
.mml-picbar .mml-tag{flex:1 1 auto;min-width:0;overflow:hidden;
  text-overflow:ellipsis;}
.mml-picbar .mml-power,
.mml-picbar .mml-trimbtn,
.mml-picbar .mml-drag,
.mml-picbar .mml-x{flex:0 0 auto;}
.mml-picbar .mml-trimbtn{font-size:calc(12px * var(--mml-fs, 1));}
.mml-tag{font-family:ui-monospace,monospace;font-size:calc(9px * var(--mml-fs, 1));white-space:nowrap;}
.mml-tag.pic{color:#e0a94c;} .mml-tag.vid{color:#4cc3e0;} .mml-tag.aud{color:#b48ce8;}
.mml-tag.vid.edit{color:#e86a8a;}
.mml-editbadge{cursor:pointer;color:#e86a8a;font-size:calc(14px * var(--mml-fs, 1));line-height:1;flex-shrink:0;
  user-select:none;text-shadow:0 0 6px rgba(232,106,138,.5);}
.mml-ctxmenu{position:fixed;z-index:10060;min-width:180px;background:#1b1f27;border:1px solid #303642;
  border-radius:7px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:4px;font-family:system-ui,sans-serif;}
.mml-ctxitem{padding:6px 10px;border-radius:5px;cursor:pointer;color:#dde2ea;font-size:calc(12px * var(--mml-fs, 1));}
.mml-ctxitem:hover{background:#262c37;}
.mml-ctxsep{height:1px;margin:4px 6px;background:#2e3440;}
.mml-ctxitem.mml-ctxdanger{color:#e0848a;}
.mml-ctxitem.armed,.mml-btn.armed{background:#5a2328 !important;color:#ffd5d8 !important;}
.mml-msgact{margin-left:8px;background:none;border:1px solid #4a5568;border-radius:4px;color:#9fe9f2;
  cursor:pointer;padding:0 6px;font-size:calc(10px * var(--mml-fs, 1));}
.mml-maskmissing{position:absolute;right:1px;top:1px;color:#ffcf5a;font-size:calc(11px * var(--mml-fs, 1));
  line-height:1;text-shadow:0 0 3px #000;cursor:help;}
.mml-mkdim.err{color:#e0848a;}
.mml-tmmodal [hidden]{display:none !important;}
.mml-mkui .mml-tmfoot{flex-wrap:wrap;row-gap:6px;}
.mml-mkgo{background:#2b5f8a;border-color:#3b77a8;color:#fff;font-weight:600;padding:5px 14px;
  font-size:calc(12px * var(--mml-fs, 1));}
.mml-mkgo:hover{background:#34709f;}
.mml-mkgo:disabled{opacity:.55;cursor:default;}
.mml-mkdots{position:absolute;inset:0;cursor:crosshair;pointer-events:auto;}
.mml-mktab.on{border-color:#e86a8a;color:#f3b3c4;}
.mml-mkmark{display:inline-flex;align-items:center;gap:1px;padding:1px 5px;border:1px solid #2e3440;border-radius:9px;
  cursor:pointer;color:#c9cfda;font-family:ui-monospace,monospace;font-size:calc(10px * var(--mml-fs, 1));}
.mml-mkmark.here{border-color:#4cc3e0;}
.mml-mkmark.bad{border-color:#7a3a3a;}
.mml-mkmark b{font-weight:400;} .mml-mkmark b.pos{color:#3ec46d;} .mml-mkmark b.neg{color:#e0484f;}
.mml-mkmarkx{margin-left:4px;color:#6b7484;} .mml-mkmarkx:hover{color:#e0848a;}
.mml-mkmode{display:inline-flex;gap:4px;}
.mml-mkhint{font-size:calc(11px * var(--mml-fs, 1));color:#8b93a1;font-family:system-ui,sans-serif;}
.mml-mkmode .mml-btn{font-size:calc(11px * var(--mml-fs, 1));padding:3px 10px;}
.mml-mkmode .mml-btn.on{border-color:#e86a8a;color:#fff;background:#4a2331;}
.mml-mkmode .mml-btn:disabled{opacity:.4;cursor:default;}
.mml-seg button:disabled{opacity:.4;cursor:default;}
.mml-mkoverlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.mml-mknote{position:absolute;left:8px;bottom:8px;line-height:1.3;padding:2px 7px;border-radius:4px;
  background:rgba(8,10,14,.72);color:#9fe9f2;font-size:calc(10px * var(--mml-fs, 1));pointer-events:auto;
  cursor:help;font-family:system-ui,sans-serif;}
.mml-vthumbwrap{position:relative;display:inline-block;width:60px;height:34px;min-width:60px;flex-shrink:0;
  line-height:0;border-radius:4px;overflow:hidden;}
.mml-mkdim{font-size:calc(11px * var(--mml-fs, 1));color:#8b93a1;font-family:ui-monospace,monospace;}
.mml-mkhelp{padding:6px 12px 0;font-size:calc(11px * var(--mml-fs, 1));color:#8b93a1;line-height:1.4;}
.mml-mktext{flex:1 1 auto;min-width:0;background:#12151b;color:#dde2ea;border:1px solid #2e3440;border-radius:6px;
  padding:4px 7px;font-size:calc(12px * var(--mml-fs, 1));}
.mml-mkckpt{flex:0 1 200px;min-width:0;background:#12151b;color:#c9cfda;border:1px solid #2e3440;border-radius:6px;
  padding:3px 5px;font-size:calc(11px * var(--mml-fs, 1));}
.mml-mkstatus{padding:6px 12px 0;min-height:1.4em;font-size:calc(11px * var(--mml-fs, 1));color:#9fb4c8;line-height:1.4;}
.mml-mkstatus.err{color:#e0848a;}
.mml-mkstatus a{color:#4cc3e0;}
.mml-mklbl{display:flex;align-items:center;gap:5px;font-size:calc(11px * var(--mml-fs, 1));color:#c9cfda;}
.mml-mklbl input[type=range]{width:90px;}
.mml-mkui > .mml-mkhelp:last-child{padding-bottom:12px;}
.mml-mkunsaved{font-size:calc(11px * var(--mml-fs, 1));color:#ffb84d;}
.mml-tmbody{display:flex;align-items:flex-start;gap:12px;}
.mml-tmleft{flex:1 1 0;min-width:0;}
.mml-tmside{flex:0 0 calc(420px * var(--mml-fs, 1));max-width:48%;min-width:0;box-sizing:border-box;padding:10px 12px 0 0;}
.mml-lyrside{display:flex;flex-direction:column;gap:10px;}
.mml-lyrcard{position:relative;border:1px solid #2a2f3a;border-radius:8px;background:#1b1f27;padding:8px;}
.mml-lyrhead{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
.mml-lyrcap{font-size:calc(10px * var(--mml-fs, 1));color:#8a93a3;text-transform:uppercase;letter-spacing:.06em;font-weight:600;}
.mml-lyrlist{display:flex;flex-direction:column;gap:4px;}
.mml-lyrrow{display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid #2e3440;border-radius:6px;background:#161a21;}
.mml-lyrrow.hov{border-color:#5a6272;}
.mml-lyrrow.sel{border-color:#ffb84d;background:#241f16;}
.mml-lyrrow.off .mml-lyrname,.mml-lyrrow.off .mml-lyrbadge{opacity:.45;}
.mml-lyrrow.drop{box-shadow:0 -2px 0 #ffb84d;}
.mml-lyrrow.dropafter{box-shadow:0 2px 0 #ffb84d;}
.mml-lyreye,.mml-lyrmore{background:none;border:0;color:#8b93a1;cursor:pointer;padding:0 2px;line-height:1;
  font-size:calc(12px * var(--mml-fs, 1));}
.mml-lyreye:hover,.mml-lyrmore:hover{color:#dde2ea;}
.mml-lyrbadge{flex:0 0 auto;min-width:calc(28px * var(--mml-fs, 1));text-align:center;font-weight:700;padding:1px 3px;
  border:1px solid currentColor;border-radius:4px;font-size:calc(10px * var(--mml-fs, 1));}
.mml-lyrname{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-start;background:none;border:0;
  padding:0;cursor:pointer;text-align:left;}
.mml-lyrname b,.mml-lyrname i{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mml-lyrname b{font-weight:500;color:#dde2ea;font-size:calc(12px * var(--mml-fs, 1));}
.mml-lyrname i{font-style:normal;color:#8b93a1;font-size:calc(10px * var(--mml-fs, 1));}
.mml-addcut button.add.on,.mml-shownseg button.shown.on{background:#1d3a2a;color:#9be3b4;}
.mml-addcut button.cut.on{background:#4a2331;color:#f3b3c4;}
.mml-shownseg button.hidden.on{background:#4a3417;color:#ffc27a;}
.mml-lyrgrip{cursor:grab;color:#6b7484;line-height:1;touch-action:none;user-select:none;font-size:calc(13px * var(--mml-fs, 1));}
.mml-lyrmenu{position:absolute;right:8px;top:calc(34px * var(--mml-fs, 1));z-index:3;min-width:220px;max-width:calc(100% - 16px);
  background:#20242d;border:1px solid #3a4252;border-radius:7px;box-shadow:0 12px 32px rgba(0,0,0,.5);padding:4px;}
.mml-lyrmenuitem{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;background:none;border:0;
  border-radius:5px;padding:5px 8px;cursor:pointer;text-align:left;color:#dde2ea;font-size:calc(12px * var(--mml-fs, 1));}
.mml-lyrmenuitem:hover{background:#2b3140;}
.mml-lyrmenuitem i{font-style:normal;color:#8b93a1;line-height:1.3;font-size:calc(10px * var(--mml-fs, 1));}
.mml-lyrhelp{margin-top:6px;color:#8b93a1;line-height:1.4;font-size:calc(10px * var(--mml-fs, 1));}
.mml-lyrpanel{display:flex;flex-direction:column;gap:7px;}
.mml-lyrpanel .mml-lyrhead{margin-bottom:0;}
.mml-lyrhead .mml-mkdim{white-space:nowrap;}
.mml-lyrpanel .mml-lyrhelp{margin-top:0;}
.mml-lyrpanel .mml-seg button{padding:3px 9px;font-size:calc(11px * var(--mml-fs, 1));}
.mml-lyrrowctl{display:flex;flex-wrap:wrap;align-items:center;gap:5px;}
.mml-lyrrowctl > input[type=range]{flex:1 1 90px;min-width:60px;}
.mml-lyrnamein{flex:1 1 auto;}
.mml-lyrstale{color:#ffc27a;line-height:1.4;font-size:calc(10px * var(--mml-fs, 1));}
.mml-kchip{display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border:1px solid #2e3440;border-radius:9px;
  cursor:pointer;color:#c9cfda;font-family:ui-monospace,monospace;font-size:calc(10px * var(--mml-fs, 1));}
.mml-kchip .mml-kglyph,.mml-lyrmark{color:#9fe3f5;}
.mml-kchip.off .mml-kglyph,.mml-lyrmark.off{color:#ff8a3d;}
.mml-kchip.here{border-color:#ffb84d;}
.mml-lyrlane{position:relative;height:calc(14px * var(--mml-fs, 1));margin-top:2px;}
.mml-lyrmark{position:absolute;top:0;transform:translateX(-50%);cursor:pointer;line-height:1;
  font-size:calc(11px * var(--mml-fs, 1));}
.mml-lyrmark.dot{color:#3ec46d;}
.mml-lyrmark.stroke{color:#b48ce8;}
.mml-lyrmark.here{text-shadow:0 0 5px #fff;}
.mml-x{cursor:pointer;color:#7a8393;font-size:calc(11px * var(--mml-fs, 1));line-height:1;}
.mml-x:hover{color:#e05a5a;}

.mml-row{display:flex;align-items:center;gap:6px;padding:0 6px;height:100%;
  box-sizing:border-box;min-width:0;overflow:hidden;}
.mml-vthumb{width:60px;height:34px;min-width:60px;max-width:60px;border-radius:4px;
  object-fit:contain;background:#0d1015;flex-shrink:0;cursor:zoom-in;}
.mml-meta{min-width:0;flex:1;}
.mml-name{font-size:calc(9px * var(--mml-fs, 1));color:#6b7484;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;}
.mml-play{width:20px;height:20px;border-radius:50%;border:1px solid #3a4252;background:#20242d;
  color:#c9cfda;font-size:calc(9px * var(--mml-fs, 1));line-height:1;cursor:pointer;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;padding:0;}
.mml-play:hover{border-color:#59637a;}
.mml-bar{flex:1;height:3px;background:#2a2f3a;border-radius:2px;min-width:16px;
  cursor:pointer;position:relative;}
.mml-bar i{position:absolute;left:0;top:0;bottom:0;background:#7d63b8;border-radius:2px;
  display:block;width:0;}
.mml-time{font-size:calc(9px * var(--mml-fs, 1));color:#6b7484;font-family:ui-monospace,monospace;flex-shrink:0;}
.mml-seg{display:inline-flex;border:1px solid #2e3440;border-radius:4px;overflow:hidden;
  flex-shrink:0;}
.mml-seg button{background:none;border:0;color:#6b7484;font-size:calc(9px * var(--mml-fs, 1));padding:1px 5px;
  cursor:pointer;}
.mml-seg button.on{background:#3a2f56;color:#e2d6f8;}
.mml-power{cursor:pointer;color:#4d5563;font-size:calc(11px * var(--mml-fs, 1));line-height:1;flex-shrink:0;
  user-select:none;}
.mml-power.on{color:#7ec87e;}
.mml-power:hover{color:#a8e6a8;}
.mml-slot.filled.off{opacity:.42;border-style:dashed;}
.mml-slot.filled.off .mml-power{opacity:1;color:#6b7484;}
.mml-slot.filled.off:hover{opacity:.7;}
.mml-segstack{display:flex;flex-direction:column;align-items:center;gap:2px;
  flex-shrink:0;}
.mml-segtag{font-size:calc(9px * var(--mml-fs, 1));}
.mml-trimok{border-color:#3e5240;color:#7ec87e;}
.mml-trimbtn{cursor:pointer;color:#e0a94c;opacity:.65;font-size:calc(15px * var(--mml-fs, 1));line-height:1;
  flex-shrink:0;user-select:none;}
.mml-trimbtn:hover{opacity:1;}
.mml-trimbtn.on{opacity:1;text-shadow:0 0 6px rgba(224,169,76,.55);}
.mml-trimlen{margin-left:2px;vertical-align:middle;font-family:ui-monospace,monospace;text-shadow:none;
  font-size:calc(9px * var(--mml-fs, 1));}
.mml-tmover{position:fixed;inset:0;background:rgba(8,10,14,.72);z-index:10050;
  display:flex;align-items:center;justify-content:center;}
.mml-tmmodal{width:min(640px,92vw);background:#191c22;border:1px solid #303642;
  border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.55);display:flex;
  flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif;}
.mml-tmhead{display:flex;flex-wrap:wrap;row-gap:6px;align-items:center;gap:8px;padding:8px 12px;
  border-bottom:1px solid #2a2f3a;background:#1b1f27;}
.mml-tmtitle{flex:1;min-width:0;font-size:calc(12px * var(--mml-fs, 1));color:#dde2ea;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
/* overflow:hidden is the safety net for the rotate bug: a CSS transform does
   not change an element's layout box, so a quarter-turned preview painted
   outside the stage and across the toolbar above it — covering the very
   buttons you needed to turn it back. sizeMedia() computes a box that fits,
   and this clip guarantees a mis-measure can never reach the header again. */
.mml-tmstage{position:relative;background:#000;line-height:0;overflow:hidden;
  display:flex;align-items:center;justify-content:center;}
.mml-tmvideo{width:100%;max-height:min(calc(340px * var(--mml-tmw, 1)), 60vh);object-fit:contain;display:block;}
.mml-tmover .mml-tmmodal{max-height:96vh;overflow-y:auto;position:relative;}

/* Turned: sizeMedia() sets an explicit width, so the percentage rules that
   assume an upright box must stand down. */
.mml-tmvideo.turned{width:auto;max-height:none;}
.mml-tmcropwrap{position:absolute;inset:0;}

.mml-tmcrop{position:absolute;border:1.5px dashed #4cc3e0;cursor:move;
  background:
    linear-gradient(rgba(76,195,224,.25),rgba(76,195,224,.25)) 33.33% 0/1px 100% no-repeat,
    linear-gradient(rgba(76,195,224,.25),rgba(76,195,224,.25)) 66.66% 0/1px 100% no-repeat,
    linear-gradient(rgba(76,195,224,.25),rgba(76,195,224,.25)) 0 33.33%/100% 1px no-repeat,
    linear-gradient(rgba(76,195,224,.25),rgba(76,195,224,.25)) 0 66.66%/100% 1px no-repeat;
  box-shadow:0 0 0 4000px rgba(0,0,0,.45);}
.mml-tmcrop.locked{cursor:default;border-style:solid;
  border-color:rgba(76,195,224,.85);background:none;}
.mml-tmcrop.locked .mml-tmcorner{display:none;}
.mml-tmcorner{position:absolute;width:11px;height:11px;background:#4cc3e0;
  border-radius:2px;}
.mml-tmcorner.nw{left:-6px;top:-6px;cursor:nwse-resize;}
.mml-tmcorner.ne{right:-6px;top:-6px;cursor:nesw-resize;}
.mml-tmcorner.sw{left:-6px;bottom:-6px;cursor:nesw-resize;}
.mml-tmcorner.se{right:-6px;bottom:-6px;cursor:nwse-resize;}
.mml-tmcropbar{display:flex;align-items:center;gap:6px;}
.mml-tmcropinfo{font-size:calc(10px * var(--mml-fs, 1));color:#8a93a3;font-family:ui-monospace,monospace;
  white-space:nowrap;}
.mml-tmcropinfo.changed{color:#4cc3e0;}
.mml-tmlock{font-size:calc(11px * var(--mml-fs, 1));color:#b9cdef;border:1px solid #4d6ea6;border-radius:6px;
  padding:3px 8px;white-space:nowrap;}
.mml-tmaspect{background:#12151b;color:#c9cfda;border:1px solid #2e3440;
  border-radius:6px;padding:2px 5px;font-size:calc(11px * var(--mml-fs, 1));}
.mml-btn.on{background:#173642;border-color:#4cc3e0;color:#9fe3f5;}
.mml-tmtimeline{position:relative;padding:8px 14px 4px;}
.mml-tmwave{display:block;width:100%;height:46px;margin-bottom:2px;}
.mml-tmruler{position:relative;height:16px;}
.mml-tmzoomrow{display:flex;align-items:center;gap:5px;margin-bottom:6px;}
.mml-tmzoom{width:90px;}
.mml-tmmini{flex:1;position:relative;height:8px;margin-right:4px;background:#12151b;border-radius:3px;cursor:pointer;}
.mml-tmminisel{position:absolute;top:0;bottom:0;min-width:2px;background:#1f6f96;}
.mml-tmminiview{position:absolute;top:-2px;bottom:-2px;min-width:4px;box-sizing:border-box;border:1px solid #dde2ea;
  border-radius:3px;transform:translateX(-1px);}
.mml-tmminihead{position:absolute;top:-2px;bottom:-2px;width:2px;background:#ffb84d;transform:translateX(-50%);}
.mml-tmtick{position:absolute;transform:translateX(-50%);font-size:calc(9px * var(--mml-fs, 1));
  color:#6b7484;}
.mml-tmtick::before{content:"";position:absolute;left:50%;top:-3px;width:1px;
  height:3px;background:#3a4252;}
.mml-tmbar{position:relative;height:20px;background:#12151b;border-radius:5px;
  margin:2px 0 6px;cursor:pointer;}
.mml-tmsel{position:absolute;top:0;bottom:0;background:#1f6f96;border-radius:5px;}
.mml-tmhandle{position:absolute;top:-3px;bottom:-3px;width:9px;background:#4cc3e0;
  border-radius:3px;transform:translateX(-50%);cursor:ew-resize;z-index:2;}
.mml-tmhandle:hover{background:#7fd8ee;box-shadow:0 0 6px rgba(76,195,224,.7);}
.mml-tmplayhead{position:absolute;top:-5px;bottom:-5px;width:2px;
  background:#ffb84d;transform:translateX(-50%);pointer-events:none;z-index:4;
  box-shadow:0 0 0 1px rgba(0,0,0,.65), 0 0 7px rgba(255,184,77,.85);}
.mml-tmplayhead::before{content:"";position:absolute;left:50%;top:-4px;
  width:0;height:0;transform:translateX(-50%);
  border-left:4px solid transparent;border-right:4px solid transparent;
  border-top:5px solid #ffb84d;}
.mml-tmnow{display:flex;gap:5px;align-items:center;height:14px;
  font-size:calc(9px * var(--mml-fs, 1));color:#8a6a33;text-transform:uppercase;letter-spacing:.06em;}
.mml-tmplaytime{color:#ffb84d;font-family:ui-monospace,monospace;
  text-transform:none;letter-spacing:0;font-size:calc(10px * var(--mml-fs, 1));}
.mml-tmfoot{display:flex;align-items:center;gap:5px;padding:8px 12px 0;
  flex-wrap:wrap;}
.mml-tmfoot.act{padding:8px 12px 4px;border-top:1px solid #23272f;margin-top:8px;}
.mml-tmgap{width:8px;}
.mml-tmspace{flex:1;}
.mml-tmnum{width:52px;background:#12151b;color:#dde2ea;border:1px solid #2e3440;
  border-radius:6px;padding:3px 6px;font-size:calc(11px * var(--mml-fs, 1));text-align:right;
  font-family:ui-monospace,monospace;}
.mml-tmnum:focus{outline:none;border-color:#4cc3e0;}
.mml-tmdash{color:#5c6472;font-size:calc(11px * var(--mml-fs, 1));}
.mml-tmoutside{font-size:calc(10px * var(--mml-fs, 1));color:#f07070;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;text-transform:none;letter-spacing:0;}
.mml-tmplayhead.out{background:#f07070;
  box-shadow:0 0 0 1px rgba(0,0,0,.65), 0 0 7px rgba(240,112,112,.85);}
.mml-tmplayhead.out::before{border-top-color:#f07070;}
.mml-tmnote{padding:2px 12px 6px;font-size:calc(10px * var(--mml-fs, 1));color:#8a93a3;line-height:1.4;}
.mml-tmnote.bad{color:#f07070;}
.mml-tmnote:empty{display:none;}
.mml-tmkeys{padding:0 12px 10px;font-size:calc(10px * var(--mml-fs, 1));color:#5c6472;}
.mml-tmreadout{font-size:calc(11px * var(--mml-fs, 1));color:#8a93a3;font-family:ui-monospace,monospace;}
.mml-tmreadout.bad{color:#f07070;}
.mml-btn.primary{background:#1f4f7d;border-color:#3d7fbf;color:#dbeafe;}
.mml-trimrow{display:flex;align-items:center;flex-wrap:nowrap;gap:3px;
  padding:0 5px;height:100%;overflow:hidden;}
.mml-trimlbl{font-size:calc(9px * var(--mml-fs, 1));text-transform:uppercase;letter-spacing:.07em;
  color:#6b7484;}
.mml-triminput{width:38px;background:#12151b;color:#dde2ea;
  border:1px solid #2e3440;border-radius:5px;padding:2px 6px;font-size:calc(11px * var(--mml-fs, 1));}
.mml-triminput:focus{outline:none;border-color:#4a5568;}
.mml-trimdash{color:#6b7484;}
.mml-trimof{font-size:calc(10px * var(--mml-fs, 1));color:#6b7484;}
.mml-trimerr{flex-basis:100%;font-size:calc(10px * var(--mml-fs, 1));color:#f07070;}
.mml-trimerr:empty{display:none;}
.mml-drag{cursor:grab;color:#4d5563;font-size:calc(10px * var(--mml-fs, 1));user-select:none;flex-shrink:0;}

.mml-order{flex:0 0 auto;background:#1a2230;border:1px solid #2b3a52;border-radius:6px;
  padding:4px 7px;height:42px;box-sizing:border-box;overflow:hidden;}
.mml-order b{display:block;font-size:calc(9px * var(--mml-fs, 1));text-transform:uppercase;letter-spacing:.07em;
  color:#6f86b8;font-weight:500;margin-bottom:1px;}
.mml-order div{font-family:ui-monospace,monospace;font-size:calc(9px * var(--mml-fs, 1));color:#9db4dc;
  line-height:1.35;overflow:hidden;}

.mml-light{position:fixed;inset:0;z-index:10050;background:rgba(8,10,14,.75);
  display:flex;align-items:center;justify-content:center;}
.mml-lightbox{max-width:80vw;max-height:80vh;background:#1e222a;border:1px solid #3a4252;
  border-radius:10px;overflow:hidden;padding:8px;}
.mml-lightbox img,.mml-lightbox video{max-width:76vw;max-height:68vh;display:block;}
.mml-lightcap{display:flex;align-items:center;gap:8px;padding-top:6px;font-size:calc(11px * var(--mml-fs, 1));
  color:#8a93a3;}
.mml-helpbtn{margin-left:5px;width:13px;height:13px;line-height:1;padding:0;
  border-radius:50%;border:1px solid #3a4252;background:#20242d;color:#8a93a3;
  font-size:calc(9px * var(--mml-fs, 1));cursor:pointer;font-family:system-ui,sans-serif;}
.mml-helpbtn:hover{border-color:#6f86b8;color:#c9cfda;}
.mml-help{position:fixed;z-index:10055;width:370px;max-height:min(560px,88vh);
  background:#1e222a;border:1px solid #3a4252;border-radius:9px;overflow:hidden;
  display:flex;flex-direction:column;box-shadow:0 14px 36px rgba(0,0,0,.55);
  font-family:system-ui,sans-serif;}
.mml-helphead{display:flex;align-items:center;padding:7px 10px;background:#232833;
  border-bottom:1px solid #2a2f3a;font-size:calc(11px * var(--mml-fs, 1));text-transform:uppercase;
  letter-spacing:.07em;color:#8a93a3;}
.mml-helphead button{margin-left:auto;background:none;border:0;color:#6b7484;
  font-size:calc(13px * var(--mml-fs, 1));cursor:pointer;line-height:1;}
.mml-helphead button:hover{color:#fff;}
.mml-helpbody{overflow:auto;padding:9px 10px;}
.mml-helpbody p{margin:0;font-size:calc(11px * var(--mml-fs, 1));line-height:1.55;color:#aab2c0;}
.mml-helprow{display:flex;gap:8px;margin-bottom:9px;}
.mml-helpmode{flex:0 0 auto;font-family:ui-monospace,monospace;font-size:calc(10px * var(--mml-fs, 1));
  border-radius:9px;padding:1px 7px;height:16px;line-height:14px;
  border:1px solid #363d4a;background:#20242d;color:#8a93a3;}
.mml-helpmode.paired{border-color:#7d63b8;background:#3a2f56;color:#e2d6f8;}
.mml-helpmode.alone{border-color:#2c6f81;background:#1d3a44;color:#a5e2f0;}
.mml-helpsub{font-size:calc(10px * var(--mml-fs, 1));text-transform:uppercase;letter-spacing:.07em;
  color:#6b7484;margin:12px 0 6px;padding-top:8px;border-top:1px solid #2a2f3a;}
.mml-wirerow{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:6px;}
.mml-wirerow code{font-family:ui-monospace,monospace;font-size:calc(10px * var(--mml-fs, 1));color:#9db4dc;
  background:#181c24;border-radius:4px;padding:1px 5px;}
.mml-arrow{color:#5c6472;font-size:calc(10px * var(--mml-fs, 1));}
.mml-tags{font-family:ui-monospace,monospace;font-size:calc(9px * var(--mml-fs, 1));color:#6b7484;
  flex-basis:100%;padding-left:2px;}
.mml-helpnote{margin-top:10px !important;padding-top:9px;
  border-top:1px solid #2a2f3a;color:#8a93a3 !important;}
.mml-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10060;
  background:#2b3140;color:#fff;border:1px solid #4a5568;border-radius:8px;
  padding:8px 16px;font-size:calc(13px * var(--mml-fs, 1));font-family:system-ui,sans-serif;}
/* Owned preset popover — replaces the native <select>, which the frontend's
   per-draw widget management kept collapsing. Last in the sheet on purpose:
   later rules of equal specificity win (see the chip-CSS incident). */
.mml-presetwrap{position:relative;flex:1 1 0;min-width:0;display:flex;}
.mml-presetbtn{flex:1 1 0;min-width:0;text-align:left;background:#12151b;color:#c9cfda;
  border:1px solid #2e3440;border-radius:6px;padding:3px 22px 3px 7px;
  font-size:calc(11px * var(--mml-fs, 1));font-family:system-ui,sans-serif;cursor:pointer;
  position:relative;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mml-presetbtn:after{content:"\\25be";position:absolute;right:7px;top:50%;
  transform:translateY(-50%);color:#6b7484;}
.mml-presetbtn:hover,.mml-presetbtn.on{border-color:#4a5568;}
.mml-presetbtn:focus{outline:none;border-color:#4a5568;}
.mml-presetmenu{display:none;position:absolute;left:0;right:0;top:100%;margin-top:4px;
  background:#161a21;border:1px solid #2e3440;border-radius:6px;z-index:40;
  overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.5);}
.mml-presetmenu.on{display:block;}
.mml-presetitem{padding:4px 8px;font-size:calc(11px * var(--mml-fs, 1));color:#c9cfda;
  font-family:system-ui,sans-serif;cursor:pointer;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mml-presetitem{display:flex;align-items:baseline;gap:6px;}
.mml-presetitemname{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}
.mml-presetitemn{flex:0 0 auto;color:#5c6472;
  font-size:calc(9px * var(--mml-fs, 1));}
.mml-presetitem:hover{background:#232a35;}
.mml-presetcatbtn{flex:0 0 auto;background:none;border:0;color:#4a5568;
  cursor:pointer;padding:0 2px;font-size:calc(10px * var(--mml-fs, 1));}
.mml-presetitem:hover .mml-presetcatbtn{color:#8a93a3;}
.mml-presetcatbtn:hover{color:#dde2ea;}
.mml-presetitem.editing{background:#1d2430;gap:5px;flex-wrap:nowrap;
  align-items:center;}
/* The name is flex:1 in a normal row; in edit mode it must yield so the
   controls stay on the line instead of wrapping out of the clipped menu. */
.mml-presetitem.editing .mml-presetitemname{flex:0 1 auto;max-width:38%;}
.mml-presetitem.editing .mml-presetcat{flex:0 1 150px;min-width:0;}
.mml-presetitem.editing .mml-presetcatnew{flex:1 1 90px;min-width:0;}
.mml-presetitem.editing .mml-btn{flex:0 0 auto;}
.mml-presethead{padding:5px 8px 2px;color:#6b7484;letter-spacing:.05em;
  text-transform:uppercase;font-size:calc(9px * var(--mml-fs, 1));
  font-family:system-ui,sans-serif;position:sticky;top:0;background:#161a21;}
.mml-presetlist{max-height:220px;overflow:auto;}
/* The picker's bar mirrors the prompt library's: search, category select,
   rename. Same job, same shape. */
.mml-presetbar{display:flex;gap:5px;align-items:center;padding:6px 7px;
  border-bottom:1px solid #2e3440;background:#12151b;}
.mml-presetfilter{flex:1 1 auto;min-width:0;box-sizing:border-box;
  background:#191c22;color:#dde2ea;border:1px solid #2e3440;border-radius:6px;
  padding:4px 7px;font-size:calc(11px * var(--mml-fs, 1));
  font-family:system-ui,sans-serif;}
.mml-presetfilter:focus{outline:none;border-color:#4a5568;}
.mml-presetcatfilter{flex:0 1 130px;min-width:0;background:#191c22;
  color:#c9cfda;border:1px solid #2e3440;border-radius:6px;padding:4px 5px;
  font-size:calc(11px * var(--mml-fs, 1));font-family:system-ui,sans-serif;}
.mml-presetcatfilter:focus{outline:none;border-color:#4a5568;}
.mml-presetcatedit{flex:0 0 auto;}
.mml-presetcatedit.on{border-color:#4a5568;color:#dde2ea;}
.mml-presetrenamerow{display:flex;gap:5px;align-items:center;}
.mml-presetrenamerow:not(:empty){padding:6px 7px;
  border-bottom:1px solid #2e3440;background:#151920;}
.mml-presetrenamerow .mml-presetcatnew{flex:1 1 auto;min-width:0;display:block;}
.mml-presetcat,.mml-presetcatnew{background:#12151b;color:#c9cfda;
  border:1px solid #2e3440;border-radius:6px;padding:3px 6px;flex:0 0 auto;
  max-width:150px;font-size:calc(11px * var(--mml-fs, 1));
  font-family:system-ui,sans-serif;}
.mml-presetcat:focus,.mml-presetcatnew:focus{outline:none;border-color:#4a5568;}
.mml-presetitem.on{color:#dde2ea;background:#1d2430;}
.mml-presetempty{padding:4px 8px;font-size:calc(10px * var(--mml-fs, 1));color:#6b7484;
  font-family:system-ui,sans-serif;}
`;

let cssDone = false;
function injectCSS() {
  if (cssDone) return;
  document.head.append(el("style", { textContent: CSS }));
  cssDone = true;
}

/* ------------------------------------------------------------------ */
/* Trim / crop modal                                                   */
/* ------------------------------------------------------------------ */

const fmt = (t, d = 1) => `${Math.floor(t / 60)}:${(t % 60).toFixed(d).padStart(d ? d + 3 : 2, "0")}`;

/** Popout editor for a clip's trim range and (for video) a crop rect.
 *  Writes item.trim {start,end} and item.crop {x,y,w,h} on Apply only. */
const SIZE_CAPS = [2048, 1920, 1600, 1280, 1024, 832];     // the size menu's long-edge presets

class TrimModal {
  /** @param opts.aspect - lock the crop to this width/height ratio and open
   *  straight into crop editing (used by the RefMod library to fit a photo
   *  to the first one in a stack). @param opts.aspectLabel - its name in the
   *  ratio menu. @param opts.noAdd - hide the buttons that add new items to
   *  a loader (capture frame, use audio), for callers that have no loader. */
  constructor(panel, item, opts = {}) {
    this.panel = panel;
    this.item = item;
    this.opts = opts;
    this.dur = item.duration || 0;
    this.start = item.trim?.start || 0;
    this.end = item.trim?.end ?? this.dur;
    this.view = [0, this.dur];          // the part of the clip the timeline shows
    this.crop = item.crop ? { ...item.crop } : null;
    this.mirror = !!item.mirror;
    this.rotate = ((parseInt(item.rotate, 10) || 0) % 360 + 360) % 360;
    // RefMods ignore the loader's size cap (Create's resolution decides size).
    this.resize = opts.refmod ? 0 : (parseInt(item.resize, 10) || 0);
    this.customSize = !!this.resize && !SIZE_CAPS.includes(this.resize);
    this.cropMode = false;
    this.aspect = "free";
    if (opts.aspect > 0) {
      this.aspect = String(opts.aspect);
      if (!this.crop) this.crop = coverRect(item.width, item.height, opts.aspect);
    }
    this.drag = null;
    this.canMask = item.kind === "video" && !opts.refmod && !opts.noAdd && Array.isArray(panel?.items);
    injectCSS();
    this.build();
    document.body.append(this.overlay);
    // Overlays live on <body>, so they don't inherit the node's size; scale
    // them to match, or a 200% node still opens a 640px editor.
    this.modal = this.overlay.querySelector(".mml-tmmodal");
    applyEditorSize(this.modal, this.maskOn);
    this.modal.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".mml-scalewrap")) { this.sizeMenuEl?.classList.remove("on"); this.sizeBtnEl?.classList.remove("on"); }
    });
    // Capture phase: the editor sees keys before ComfyUI's shortcuts do. The
    // graph's undo tracker listens ahead of it; the modal's aria-modal is what
    // keeps Ctrl+Z here from also undoing the graph.
    window.addEventListener("keydown", this.onKey = (e) => this.key(e), true);
    if (!this.isStill && this.end - this.start < this.dur / 10) this.zoomToTrim();
    this.saved = this.editState();
  }

  /** The edits Apply writes, to tell whether any are unsaved. */
  editState() {
    return JSON.stringify([+this.start.toFixed(2), +this.end.toFixed(2), this.crop, this.mirror, this.rotate, this.resize]);
  }

  /** The editor's own window and text size — the loader's Size control, for
   *  this editor: sliders and typeable numbers set pending values, and
   *  nothing moves until Apply (resizing while dragging pulls the slider out
   *  from under the cursor). Kept for every clip, apart from the node's scale. */
  sizeControl() {
    const prefs = loadEditorSize();
    const pending = { ...prefs };
    const limits = { window: [60, 260], text: [70, 220] };
    const inputs = {}, outs = {};
    const dirty = () => applyBtn.classList.toggle("primary",
      pending.window !== prefs.window || pending.text !== prefs.text);
    const clamp = (key, v) => Math.min(limits[key][1], Math.max(limits[key][0], Math.round(v / 5) * 5)) / 100;
    const slider = (key, label) => {
      const out = el("input", { type: "number", class: "mml-scaleval", min: String(limits[key][0]),
        max: String(limits[key][1]), step: "5", value: String(Math.round(pending[key] * 100)),
        onchange: (e) => { pending[key] = clamp(key, Number(e.target.value));
          e.target.value = input.value = String(Math.round(pending[key] * 100)); dirty(); },
        onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); } });
      const input = el("input", { type: "range", class: "mml-scalerange", min: String(limits[key][0]),
        max: String(limits[key][1]), step: "5", value: String(Math.round(pending[key] * 100)),
        oninput: (e) => { pending[key] = clamp(key, Number(e.target.value));
          out.value = String(Math.round(pending[key] * 100)); dirty(); } });
      inputs[key] = input; outs[key] = out;
      return el("label", { class: "mml-scalerow" }, el("span", { class: "mml-scalelabel" }, label), input, out,
        el("span", { class: "mml-scalepct" }, "%"));
    };
    const commit = (v) => {
      Object.assign(prefs, v); Object.assign(pending, v);
      for (const key of ["window", "text"]) {
        inputs[key].value = outs[key].value = String(Math.round(v[key] * 100));
      }
      saveEditorSize(prefs);
      applyEditorSize(this.modal, this.maskOn);
      applyBtn.classList.remove("primary");
    };
    const applyBtn = el("button", { class: "mml-btn mml-sm",
      onclick: (e) => { e.stopPropagation(); commit({ ...pending }); } }, "Apply");
    const menu = el("div", { class: "mml-scalemenu", onmousedown: (e) => e.stopPropagation() },
      slider("window", "Window size"),
      slider("text", "Text size"),
      el("div", { class: "mml-scalefoot" },
        el("span", {}, "Remembered for this editor"),
        el("button", { class: "mml-btn mml-sm",
          onclick: (e) => { e.stopPropagation(); commit({ ...EDITOR_SIZE_DEFAULT }); } }, "Reset"),
        applyBtn));
    const btn = el("button", { class: "mml-btn mml-sm", title: "Editor window and text size",
      onclick: (e) => { e.stopPropagation(); btn.classList.toggle("on", menu.classList.toggle("on")); } },
      "\u2921 Size");
    this.sizeMenuEl = menu; this.sizeBtnEl = btn;
    return el("span", { class: "mml-scalewrap" }, btn, menu);
  }

  /** Keyboard control. Typing in a field always wins; every other key stays
   *  in the editor, so the graph behind it never moves or edits. A focused
   *  checkbox, slider or button isn't typing: arrows still step frames. */
  key(e) {
    const typing = !!e.target?.closest?.("textarea, select, input:not([type=checkbox]):not([type=range]):not([type=button])");
    if (!typing) e.stopPropagation();
    if (this.isStill) {
      if (e.key === "Escape" && !typing) this.tryClose();
      return;
    }
    if (!typing && this.maskOn && this.masker.key(e)) { e.preventDefault(); return; }
    if (e.key === "Escape") {
      if (!typing) this.tryClose();
      return;
    }
    if (typing) return;

    const frame = 1 / (this.item.fps || TRIM_FPS);
    const jump = e.shiftKey ? frame * 10 : frame;
    const at = this.media?.currentTime || 0;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault(); this.seek(at - jump); break;
      case "ArrowRight":
        e.preventDefault(); this.seek(at + jump); break;
      case "Home":
        e.preventDefault(); this.seek(this.start); break;
      case "End":
        e.preventDefault(); this.seek(Math.max(this.start, this.end - frame));
        break;
      case " ":
        e.preventDefault(); this.playBtn.click(); break;
      case "[":
        e.preventDefault();
        this.start = Math.min(at, this.end - 0.1); this.layoutTimeline(); break;
      case "]":
        e.preventDefault();
        this.end = Math.max(at, this.start + 0.1); this.layoutTimeline(); break;
      case "a": case "A":
        if (!this.opts.noAdd && (this.item.kind === "audio" || this.item.has_audio)) {
          e.preventDefault(); this.useAudio();
        }
        break;
      case "=": case "+":
        e.preventDefault(); this.zoomStep(0.5); break;
      case "-":
        e.preventDefault(); this.zoomStep(2); break;
      case "m": case "M":
        e.preventDefault(); this.toggleMute(); break;
      case "c": case "C":
        if (!this.opts.noAdd && this.item.kind === "video") { e.preventDefault(); this.captureFrame(); }
        break;
      default: break;
    }
  }

  /** Close, unless that would lose unsaved edits: then the first try only
   *  says so, and a click beside the editor never closes it. */
  tryClose(backdrop = false) {
    const mask = this.masker?.closeWarning() || "";
    const warn = mask || (this.editState() !== this.saved ? "Unsaved trim or crop changes: Apply keeps them" : "");
    if (!warn || (this.closeArmed && !backdrop)) { this.close(); return; }
    // A click beside the editor only warns: it doesn't count toward closing.
    const text = `${warn}; ${backdrop ? "close with \u2715 or Esc" : "press \u2715 or Esc again"} to drop them.`;
    if (!backdrop) {
      this.closeArmed = true;
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => { this.closeArmed = false; }, 6000);
    }
    if (mask) {
      if (!this.maskOn) this.setMaskMode(true);
      this.masker.say(text, true);
    } else this.modalSay(text, true);
  }

  close() {
    if (this.masker) this.masker.closed = true;
    this.maskLayer?.detach();
    if (this.stopFit) this.stopFit();
    if (this.raf) cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKey, true);
    try { this.media?.pause?.(); } catch (e) {}
    this.overlay.remove();
  }

  /** Write the edits to the item. `keepOpen` stays in the editor (mask
   *  mode's Use this mask), following the item through the commit. */
  apply(keepOpen = false) {
    // Resolve to whichever object the panel currently holds: a sync can have
    // replaced it since the modal opened, and writing to the old one would
    // drop the edit on the floor without any error.
    const it = this.panel.live?.(this.item) || this.item;
    this.item = it;
    const eps = 0.05;
    if (this.isStill) {
      delete it.trim;
    } else if (this.start <= eps && this.end >= this.dur - eps) {
      delete it.trim;
    } else {
      it.trim = { start: +this.start.toFixed(2),
        end: this.end >= this.dur - eps ? null : +this.end.toFixed(2) };
    }
    const visual = it.kind === "video" || it.kind === "picture";
    if (this.crop && visual) it.crop = { ...this.crop };
    else delete it.crop;
    if (this.mirror && visual) it.mirror = true;
    else delete it.mirror;
    if (this.rotate && visual) it.rotate = this.rotate;
    else delete it.rotate;
    if (this.resize && visual) it.resize = this.resize;
    else delete it.resize;
    // The mask was made for one span: say so if the trim now reaches past it.
    const range = it.mask_range;
    const past = range && ((it.trim?.start || 0) < range.start - 0.05 ||
      (it.trim?.end ?? this.dur) > range.end + 0.05);
    if (past) this.panel.say(`${it.name}'s mask covers ${range.start.toFixed(1)}\u2013${range.end.toFixed(1)} s; ` +
      "the trim now goes past that, and frames outside it won't change. Mask it again to cover them.", true);
    this.saved = this.editState();
    if (!keepOpen) this.tryClose();          // unsaved mask layers still hold it open
    this.panel.commit();
    this.item = this.panel.live?.(it) || it;
  }

  /* ---- media preview ---------------------------------------------- */

  get isStill() { return this.item.kind === "picture"; }

  buildMedia() {
    const url = viewURL(this.item.file);
    if (this.isStill) {
      this.media = el("img", { class: "mml-tmvideo", src: url,
        onload: () => this.sizeMedia() });   // naturalWidth is 0 until decoded
      this.media.addEventListener("load", () => {
        if (!this.item.width) {
          this.item.width = this.media.naturalWidth;
          this.item.height = this.media.naturalHeight;
        }
        this.syncCrop();
      });
      return;
    }
    if (this.item.kind === "video") {
      this.media = el("video", { class: "mml-tmvideo", src: url,
        muted: false, volume: 0.9,
        playsInline: true, loop: false, preload: "auto" });
    } else {
      this.media = el("audio", { src: url, preload: "auto" });
    }
    // keep playback inside the selected range
    this.media.addEventListener("loadedmetadata", () => {
      this.updatePlayhead();
      this.sizeMedia();               // videoWidth is 0 until metadata lands
    });
    this.media.addEventListener("seeked", () => this.updatePlayhead());
    this.media.addEventListener("timeupdate", () => {
      if (this.media.currentTime >= this.end - 0.02) {
        this.media.currentTime = this.start;
      }
      this.updatePlayhead();
    });
    this.muteBtn = el("button", { class: "mml-btn mml-sm",
      title: "Mute the preview (M)",
      onclick: () => this.toggleMute() }, "\u{1F50A}");
    this.playBtn = el("button", { class: "mml-btn mml-sm",
      onclick: () => {
        if (this.media.paused) {
          if (this.media.currentTime < this.start ||
              this.media.currentTime >= this.end - 0.02)
            this.media.currentTime = this.start;
          this.media.play();
          this.playBtn.textContent = "\u23f8";
          this.startTicking();
        } else { this.media.pause(); this.playBtn.textContent = "\u25b6"; }
      } }, "\u25b6");
  }

  toggleMute() {
    if (!this.media) return;
    this.media.muted = !this.media.muted;
    this.muteBtn.textContent = this.media.muted ? "\u{1F507}" : "\u{1F50A}";
    this.muteBtn.classList.toggle("on", this.media.muted);
  }

  seek(t, pause = true) {
    if (this.isStill || !this.media) return;
    if (pause && !this.media.paused) {
      this.media.pause(); this.playBtn.textContent = "\u25b6";
    }
    try { this.media.currentTime = Math.min(Math.max(t, 0), this.dur); }
    catch (e) {}
    this.follow(Math.min(Math.max(t, 0), this.dur));
    this.updatePlayhead();
  }

  /* ---- audio waveform --------------------------------------------- */

  /** Decode once to peaks, 100 a second, so the waveform can be drawn for
   *  whatever part of the clip the timeline shows. */
  async drawWave() {
    try {
      const resp = await fetch(viewURL(this.item.file));
      const buf = await resp.arrayBuffer();
      const ctx2 = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await ctx2.decodeAudioData(buf);
      const data = audio.getChannelData(0), per = Math.max(1, Math.round(audio.sampleRate / 100));
      const peaks = new Float32Array(Math.ceil(data.length / per));
      for (let i = 0; i < peaks.length; i++) {
        for (let j = i * per; j < Math.min(data.length, (i + 1) * per); j += 16)
          peaks[i] = Math.max(peaks[i], Math.abs(data[j]));
      }
      ctx2.close();
      this.peaks = peaks;
      this.paintWave();
    } catch (e) { /* waveform is decoration; the ruler still works */ }
  }

  paintWave() {
    if (!this.peaks) return;
    const g = this.wave.getContext("2d"), [t0, t1] = this.view;
    const W = this.wave.width, H = this.wave.height, N = 240;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#7d63b8";
    for (let i = 0; i < N; i++) {
      const a = Math.floor((t0 + (t1 - t0) * i / N) * 100), b = Math.floor((t0 + (t1 - t0) * (i + 1) / N) * 100);
      let peak = 0;
      for (let j = a; j < Math.max(a + 1, b) && j < this.peaks.length; j++) peak = Math.max(peak, this.peaks[j]);
      const h = Math.max(1, peak * H * 0.92);
      g.fillRect(i * (W / N), (H - h) / 2, W / N - 1, h);
    }
  }

  /* ---- timeline ---------------------------------------------------- */

  buildTimeline() {
    this.ruler = el("div", { class: "mml-tmruler" });
    // While zoomed: the whole clip, the kept range and the part shown
    this.mini = el("div", { class: "mml-tmmini",
      title: "The whole clip. Drag to move the zoomed timeline along it.",
      onmousedown: (e) => this.miniDown(e) },
      this.miniSel = el("div", { class: "mml-tmminisel" }),
      this.miniView = el("div", { class: "mml-tmminiview" }),
      this.miniHead = el("div", { class: "mml-tmminihead" }));
    this.zoomOut = el("button", { class: "mml-btn mml-sm", title: "Zoom out  ( - )",
      onclick: () => this.zoomStep(2) }, "\u2212");
    this.zoomRange = el("input", { type: "range", class: "mml-tmzoom", min: 0, max: 100, step: 1, value: 0,
      title: "Timeline zoom: the whole clip at the left, about a second across at the right. Scroll on the " +
             "timeline to zoom there; Shift+scroll moves along it.",
      oninput: (e) => this.zoomStep(this.dur * Math.min(1, 1 / this.dur) ** (e.target.value / 100) /
        (this.view[1] - this.view[0])) });
    this.zoomIn = el("button", { class: "mml-btn mml-sm", title: "Zoom in  ( = )",
      onclick: () => this.zoomStep(0.5) }, "+");
    this.selEl = el("div", { class: "mml-tmsel" });
    this.hStart = el("div", { class: "mml-tmhandle s",
      title: "Drag to move the start of the kept range",
      onmousedown: (e) => this.handleDown(e, "s") });
    this.hEnd = el("div", { class: "mml-tmhandle e",
      title: "Drag to move the end of the kept range",
      onmousedown: (e) => this.handleDown(e, "e") });
    this.playhead = el("div", { class: "mml-tmplayhead" });
    this.playTime = el("span", { class: "mml-tmplaytime" });
    this.fromStart = el("span", { class: "mml-tmplaytime",
      title: "How far the playhead is past the first kept frame, in seconds" });
    this.outside = el("span", { class: "mml-tmoutside" });
    this.note = el("div", { class: "mml-tmnote" });
    this.bar = el("div", { class: "mml-tmbar",
      onmousedown: (e) => this.barDown(e) },
      this.selEl, this.hStart, this.hEnd, this.playhead);
    if (this.item.kind === "audio") {
      this.wave = el("canvas", { class: "mml-tmwave", width: 560, height: 46 });
      this.drawWave();
    }
    const num = (label, get, set) => {
      const input = el("input", { class: "mml-tmnum", type: "text",
        inputmode: "decimal", title: `${label} time in seconds` });
      input.addEventListener("focus", () => { this.typing = input; input.select(); });
      input.addEventListener("blur", () => {
        if (this.typing === input) this.typing = null;
        this.layoutTimeline();               // snap display back to the value
      });
      const commit = () => {
        const v = parseFloat(input.value.replace(",", "."));
        if (Number.isNaN(v)) { this.layoutTimeline(); return; }
        set(Math.min(Math.max(v, 0), this.dur));
        this.seek(get());
        this.layoutTimeline();
      };
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { commit(); input.blur(); }
        if (e.key === "Escape") { this.layoutTimeline(); input.blur();
          e.stopPropagation(); }           // don't close the modal on field-escape
      });
      return input;
    };
    this.numStart = num("Start", () => this.start,
      (v) => { this.start = Math.min(v, this.end - 0.1); });
    this.numEnd = num("End", () => this.end,
      (v) => { this.end = Math.max(v, this.start + 0.1); });
    this.readout = el("span", { class: "mml-tmreadout" });
    this.setView(0, this.dur);          // ruler, layout and zoom controls
    return el("div", { class: "mml-tmtimeline", onwheel: (e) => this.wheel(e) },
      el("div", { class: "mml-tmzoomrow" }, this.mini, this.zoomOut, this.zoomRange, this.zoomIn,
        el("button", { class: "mml-btn mml-sm", title: "Zoom to the kept range", onclick: () => this.zoomToTrim() },
          "\u2922 Kept range")),
      this.wave || null, this.ruler, this.bar,
      el("div", { class: "mml-tmnow" },
        this.outside,
        el("span", { class: "mml-tmspace" }),
        el("span", {}, "playhead"), this.playTime,
        el("span", { class: "mml-tmgap" }),
        el("span", {}, "from start"), this.fromStart));
  }

  /** Time under the pointer, clamped to the part of the clip shown. */
  timeAt(e) {
    const r = this.bar.getBoundingClientRect(), [t0, t1] = this.view;
    return t0 + Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * (t1 - t0);
  }

  /** Where time t sits on the timeline, in % of the part shown. */
  pct(t) {
    const [t0, t1] = this.view;
    return t1 > t0 ? (t - t0) / (t1 - t0) * 100 : 0;
  }

  zoomed() { return this.view[1] - this.view[0] < this.dur - 1e-6; }

  /** Show t0..t1 of the clip: at least a second, at most all of it. */
  setView(t0, t1) {
    const w = Math.min(this.dur, Math.max(1, t1 - t0)), a = Math.min(Math.max(0, t0), this.dur - w);
    this.view = [a, a + w];
    const minW = Math.min(1, this.dur);
    this.zoomRange.value = String(this.dur > minW ? Math.round(100 * Math.log(w / this.dur) / Math.log(minW / this.dur)) : 0);
    this.zoomOut.disabled = !this.zoomed();
    this.zoomIn.disabled = w <= minW + 1e-6;
    this.drawRuler();
    this.paintWave();
    this.layoutTimeline();
    this.updatePlayhead();
    this.masker?.renderLane();
  }

  /** Zoom by `k` around the playhead, or the middle when it's out of view. */
  zoomStep(k) {
    const [t0, t1] = this.view, t = this.media?.currentTime || 0;
    this.zoomAt(t >= t0 && t <= t1 ? t : (t0 + t1) / 2, k);
  }

  /** Zoom by `k` (under 1 zooms in), keeping time t where it is. */
  zoomAt(t, k) {
    const [t0, t1] = this.view, f = (t - t0) / (t1 - t0), w = (t1 - t0) * k;
    this.setView(t - f * w, t - f * w + w);
  }

  /** The kept range, with a margin either side. */
  zoomToTrim() {
    const pad = Math.max(0.5, (this.end - this.start) * 0.15);
    this.setView(this.start - pad, this.end + pad);
  }

  /** Bring t back into view when a jump or playback leaves the part shown. */
  follow(t) {
    const [t0, t1] = this.view, w = t1 - t0;
    if (t < t0 || t > t1) this.setView(t - w / 2, t + w / 2);
  }

  /** Scroll zooms around the pointer; Shift+scroll or a sideways scroll pans. */
  wheel(e) {
    if (!this.dur) return;
    e.preventDefault();
    const [t0, t1] = this.view;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dt = (e.deltaX + (e.shiftKey ? e.deltaY : 0)) / this.bar.getBoundingClientRect().width * (t1 - t0);
      this.setView(t0 + dt, t1 + dt);
    } else this.zoomAt(this.timeAt(e), Math.exp(e.deltaY * 0.002));
  }

  /** Dragging on the whole-clip strip centres the zoomed view there. */
  miniDown(e) {
    e.preventDefault();
    const go = (ev) => {
      const r = this.mini.getBoundingClientRect(), w = this.view[1] - this.view[0];
      const t = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * this.dur;
      this.setView(t - w / 2, t + w / 2);
    };
    const up = () => { window.removeEventListener("mousemove", go); window.removeEventListener("mouseup", up); };
    go(e);
    window.addEventListener("mousemove", go);
    window.addEventListener("mouseup", up);
  }

  /** Ruler ticks at a round step for the part of the clip shown. */
  drawRuler() {
    const [t0, t1] = this.view;
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
      .find((st) => (t1 - t0) / st <= 8) || 7200;
    const digits = step >= 1 ? 0 : step === 0.25 ? 2 : 1;
    const ticks = [];
    for (let i = Math.ceil(t0 / step - 1e-9); i * step <= t1 + 1e-9; i++) {
      ticks.push(el("span", { class: "mml-tmtick", style: { left: `${this.pct(i * step)}%` } }, fmt(i * step, digits)));
    }
    this.ruler.replaceChildren(...ticks);
  }

  /** The whole-clip strip, shown while zoomed. */
  syncMini() {
    this.mini.style.visibility = this.zoomed() ? "" : "hidden";
    if (!this.zoomed()) return;
    const p = (t) => `${t / this.dur * 100}%`;
    Object.assign(this.miniSel.style, { left: p(this.start), width: p(this.end - this.start) });
    Object.assign(this.miniView.style, { left: p(this.view[0]), width: p(this.view[1] - this.view[0]) });
    this.miniHead.style.left = p(this.media?.currentTime || 0);
  }

  /** Clicking the bar scrubs the playhead only — the range is left alone.
   *  Handles have their own listener, so the two can't be confused. */
  barDown(e) {
    e.preventDefault();
    this.drag = "playhead";
    this.seek(this.timeAt(e));
    this.dragListen();
  }

  handleDown(e, which) {
    e.preventDefault();
    e.stopPropagation();               // don't also scrub
    this.drag = which;
    this.dragListen();
  }

  dragListen() {
    const move = (ev) => this.barMove(ev);
    const up = () => {
      this.drag = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  barMove(e) {
    if (!this.drag) return;
    const t = this.timeAt(e);
    if (this.drag === "playhead") { this.seek(t); return; }
    if (this.drag === "s") this.start = Math.min(t, this.end - 0.1);
    else this.end = Math.max(t, this.start + 0.1);
    this.seek(t);                      // preview follows the handle being moved
    this.layoutTimeline();
  }

  layoutTimeline() {
    if (this.isStill) return;
    const a = Math.min(Math.max(this.pct(this.start), 0), 100), b = Math.min(Math.max(this.pct(this.end), 0), 100);
    this.selEl.style.left = `${a}%`;
    this.selEl.style.width = `${b - a}%`;
    for (const [handle, t] of [[this.hStart, this.start], [this.hEnd, this.end]]) {
      handle.style.left = `${this.pct(t)}%`;
      handle.hidden = this.pct(t) < 0 || this.pct(t) > 100;     // zoomed away from it
    }
    this.syncMini();
    const span = this.end - this.start;
    if (this.numStart && this.typing !== this.numStart)
      this.numStart.value = this.start.toFixed(2);
    if (this.numEnd && this.typing !== this.numEnd)
      this.numEnd.value = this.end.toFixed(2);
    this.readout.textContent = `${span.toFixed(1)}s kept`;
    this.checkOutside();
    const bad = span < CLIP.min;
    this.readout.classList.toggle("bad", bad);
    this.readout.title = bad
      ? `Kept span is under ${CLIP.min}s. MiniMax H3 was trained on ` +
        `${CLIP.min}\u2013${CLIP.max}s reference clips; shorter ones tend to be ` +
        "weakly followed or ignored. Widen the range, or pad short files " +
        "(like sound effects) with silence before loading." : "";
  }

  updatePlayhead() {
    if (this.isStill || !this.playhead || !this.dur) return;
    const t = this.media?.currentTime || 0, x = this.pct(t);
    // Clamp a little inside the bar: at exactly 0% or 100% the centred
    // marker is half outside and reads as missing.
    this.playhead.style.left = `${Math.min(Math.max(x, 0.4), 99.6)}%`;
    this.playhead.hidden = x < 0 || x > 100;
    this.playTime.textContent = fmt(t);
    this.checkOutside(t);
    this.syncMini();
  }

  /** The previewed frame against the kept range: how far past its start,
   *  and a warning when it falls outside what will be sent. */
  checkOutside(t) {
    if (this.isStill || !this.outside) return;
    const at = t === undefined ? (this.media?.currentTime || 0) : t;
    const d = at - this.start;
    this.fromStart.textContent = `${(Math.abs(d) < 0.005 ? 0 : d).toFixed(2)} s`;
    const out = at < this.start - 0.001 || at > this.end + 0.001;
    this.outside.textContent = out
      ? `\u26a0 Frame at ${fmt(at)} is outside the kept range`
      : "";
    this.playhead.classList.toggle("out", out);
  }

  /** Keep the marker moving during playback; timeupdate alone is too coarse. */
  tick() {
    if (this.media && !this.media.paused) this.follow(this.media.currentTime);
    this.updatePlayhead();
    if (this.media && !this.media.paused && !this.media.ended) {
      this.raf = requestAnimationFrame(() => this.tick());
    } else this.raf = null;
  }

  startTicking() {
    if (!this.raf) this.tick();
  }

  /* ---- crop -------------------------------------------------------- */

  buildCrop() {
    if (this.item.kind !== "video" && !this.isStill) return null;
    this.cropRect = el("div", { class: "mml-tmcrop",
      onmousedown: (e) => this.cropDown(e, "move") },
      ...["nw", "ne", "sw", "se"].map((c) =>
        el("div", { class: `mml-tmcorner ${c}`,
          onmousedown: (e) => { e.stopPropagation(); this.cropDown(e, c); } })));
    this.cropBox = el("div", { class: "mml-cropbox" }, this.cropRect);
    this.cropWrap = el("div", { class: "mml-tmcropwrap" }, this.cropBox);
    requestAnimationFrame(() => {
      this.stopFit = fitToMedia(this.media, this.cropBox,
                                this.item.width, this.item.height,
                                this.stageEl);
    });
    this.cropInfo = el("span", { class: "mml-tmcropinfo" });
    this.rotBtn = el("button", { class: "mml-btn mml-sm",
      title: "Rotate 90\u00b0 clockwise (shift-click for anticlockwise)",
      onclick: (e) => {
        this.rotate = (this.rotate + (e.shiftKey ? 270 : 90)) % 360;
        // A quarter turn swaps the frame, so a crop rect drawn on the old
        // orientation would point at the wrong region — turn it with the
        // picture rather than leaving it stale.
        if (this.crop) {
          const c = this.crop;
          this.crop = e.shiftKey
            ? { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }
            : { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
        }
        const t = this.item.width; this.item.width = this.item.height;
        this.item.height = t;
        // A locked shape can't be turned with the picture: re-fit it.
        if (this.opts.aspect > 0)
          this.crop = coverRect(this.item.width, this.item.height, this.opts.aspect);
        this.syncRotate();
        this.syncCrop();
      } }, "\u21bb");
    this.mirrorBtn = el("button", { class: "mml-btn mml-sm",
      title: "Flip the clip left-to-right before it's sent",
      onclick: () => {
        this.mirror = !this.mirror;
        this.syncMirror();
      } }, "\u21c4 Mirror");
    this.cropBtn = el("button", { class: "mml-btn mml-sm",
      title: "Crop the frame",
      onclick: () => {
        this.cropMode = !this.cropMode;
        if (this.cropMode && !this.crop)
          this.crop = { x: 0.125, y: 0.125, w: 0.75, h: 0.75 };
        if (!this.cropMode && this.crop &&
            this.crop.w > 0.995 && this.crop.h > 0.995) this.crop = null;
        if (!this.cropMode) this.seek(this.media?.currentTime || 0, false);
        this.syncCrop();
      } }, "\u25a3 Crop");
    this.aspectEl = el("select", { class: "mml-tmaspect",
      onchange: (e) => { this.aspect = e.target.value; this.forceAspect(); } },
      [...(this.opts?.aspect > 0 ? [[String(this.opts.aspect), this.opts.aspectLabel || "locked"]] : []),
       ["free", "freeform"], ["1", "1:1"],
       [String(16 / 9), "16:9"], [String(9 / 16), "9:16"],
       [String(4 / 3), "4:3"], [String(3 / 4), "3:4"],
       [String(3 / 2), "3:2"], [String(2 / 3), "2:3"],
       [String(21 / 9), "21:9"], [String(9 / 21), "9:21"],
      ].map(([v, l]) => el("option", { value: v }, l)));
    this.aspectEl.value = this.aspect;
    // Pictures get a size cap: a 4K reference is decoded and rescaled on
    // every run, and the model downsizes it to the generation area anyway.
    // Not for RefMods: Create's resolution setting decides their size.
    this.sizeEl = (!this.opts.refmod && (this.isStill || this.item.kind === "video"))
      ? el("select", { class: "mml-tmaspect",
          title: "Cap the long edge of what's sent. The model rescales " +
                 "references anyway, so this mostly saves decode time and RAM " +
                 "\u2014 and on video it saves both per frame. Keep a keyframe " +
                 "or a continuation source at least as large as your generation. " +
                 "custom\u2026 takes any long edge you type.",
          onchange: (e) => {
            this.customSize = e.target.value === "custom";
            if (!this.customSize) this.resize = parseInt(e.target.value, 10) || 0;
            else if (!this.resize) {          // start the box at what's sent now
              const f = sentFrame(this.item, this.crop, 0);
              this.resize = Math.round(Math.max(f.W, f.H)) || 1024;
            }
            this.syncSize(); this.syncCrop();
          } },
          [[0, "size: full"], ...SIZE_CAPS.map((v) => [v, `max ${v}px`]), ["custom", "custom\u2026"]]
            .map(([v, label]) => el("option", { value: String(v) }, label)))
      : null;
    this.sizeNum = this.sizeEl ? el("input", { type: "text", inputmode: "numeric", class: "mml-tmnum",
      style: { width: "calc(4ch + 18px)" },          // four digits at any text size
      title: "The long edge in pixels. The shape is kept, and nothing is enlarged.",
      onchange: (e) => {
        const v = Math.round(+e.target.value);
        if (v >= 64) this.resize = Math.min(8192, v);      // a cleared or tiny box keeps the last size
        this.syncSize(); this.syncCrop();
      },
      onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); } }) : null;
    this.sizeCustom = this.sizeNum ? el("label", { class: "mml-mklbl" }, this.sizeNum, "px") : null;
    this.syncSize();
    // Only for stills: writing a resized copy of a video would mean
    // re-encoding it, which is a different job entirely.
    this.bakeBtn = (this.isStill && !this.opts.refmod)
      ? el("button", { class: "mml-btn mml-sm",
          title: "Write a resized copy into ComfyUI's input folder and use " +
                 "that instead. Your original file is left alone.",
          onclick: () => this.bake() }, "\u2b07 Write copy")
      : null;
    const locked = this.opts.aspect > 0;
    this.lockEl = locked
      ? el("span", { class: "mml-tmlock",
          title: "Every photo in the RefMod takes this shape, so the box can " +
                 "be moved and resized but not reshaped." },
          `\u{1F512} Shape locked to the ${this.opts.aspectLabel || "first photo"}`)
      : null;
    return el("span", { class: "mml-tmcropbar" },
      this.rotBtn, this.mirrorBtn,
      locked ? this.lockEl : this.cropBtn, locked ? null : this.aspectEl,
      this.sizeEl, this.sizeCustom, this.bakeBtn, this.cropInfo);
  }

  /** The size menu on a preset, or on custom… with its long edge beside it. */
  syncSize() {
    if (!this.sizeEl) return;
    this.sizeEl.value = this.customSize ? "custom" : String(this.resize);
    this.sizeCustom.style.display = this.customSize ? "" : "none";
    this.sizeNum.value = this.resize;
  }

  /** Mirror only the picture: the crop overlay stays in screen space, so a
   *  rect drawn here means the same region the backend will cut. */
  /** Write the current size/crop/rotation out as a new file and point the
   *  item at it. The edits then live in the pixels, so they're cleared. */
  async bake() {
    // A copy is worth writing whenever it would differ from the source —
    // a crop, rotation or mirror counts, not just a size cap.
    const changes = !!(this.resize || this.crop || this.mirror || this.rotate);
    if (!changes) {
      this.modalSay("Nothing to write yet \u2014 set a size, crop, rotation " +
        "or mirror first, then this saves a copy with those baked in.", true);
      return;
    }
    this.modalSay("Writing a resized copy\u2026");
    try {
      const resp = await postApi("/minimax_h3/bake", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: this.item.file, resize: this.resize, crop: this.crop,
          rotate: this.rotate, mirror: this.mirror,
        }),
      });
      const info = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(info.error || `failed (${resp.status})`);

      const it = this.item;
      it.file = info.file;
      it.name = info.name;
      it.width = info.width;
      it.height = info.height;
      delete it.crop; delete it.mirror; delete it.rotate; delete it.resize;
      this.crop = null; this.mirror = false; this.rotate = 0; this.resize = 0;

      this.panel.say(`Wrote ${info.width}\u00d7${info.height} copy of ` +
        `${info.was?.[0]}\u00d7${info.was?.[1]} \u2014 this reference now uses ` +
        "the smaller file. The original is untouched.");
      this.close();
      this.panel.commit();
    } catch (e) {
      this.modalSay(`Couldn't write the copy: ${e.message}`, true);
    }
  }

  /** Source size, and what will actually be sent when they differ. */
  showSize() {
    if (!this.cropInfo) return;
    this.maskLayer?.setLook(this.maskLook());      // grow and cells are in pixels of the frame sent
    const sw = this.item.width, sh = this.item.height;
    if (!sw || !sh) { this.cropInfo.textContent = ""; return; }
    const [ow, oh] = outSize({ ...this.item, crop: this.crop, rotate: 0,
                               resize: this.resize });
    this.cropInfo.textContent = (ow === sw && oh === sh)
      ? dimsLabel(sw, sh)
      : `${dimsLabel(sw, sh)} \u2192 ${dimsLabel(ow, oh)}`;
    this.cropInfo.classList.toggle("changed", ow !== sw || oh !== sh);
  }

  /** Say something inside the modal. Panel messages sit behind the overlay,
   *  so a refusal printed there is invisible until the modal closes. */
  modalSay(text, bad = false) {
    if (!this.note) return;
    this.note.textContent = text || "";
    this.note.classList.toggle("bad", !!bad);
  }

  /** Size the preview so its PAINTED box fits the stage.
   *
   *  rotate() leaves the layout box alone: a 736x414 element still occupies
   *  736x414 while painting 414x736, spilling ~161px above and below its
   *  centre. Above the stage is the toolbar, so the image covered the
   *  filename, Mirror, Crop, size and Write-copy buttons and the turn could
   *  not be undone. The thumbnail path already knew this (see .mml-pic.turned)
   *  — the editor never got the same treatment.
   *
   *  For a quarter turn the painted width is the element's HEIGHT and the
   *  painted height is its WIDTH, so the fit is solved with the axes swapped
   *  and the stage is given the resulting painted height explicitly. */
  sizeMedia() {
    const m = this.media;
    if (!m || this.item.kind === "audio") return;
    const stage = m.closest(".mml-tmstage");
    const turned = !!(this.rotate % 180);
    m.classList.toggle("turned", turned);
    if (!turned) {
      m.style.width = "";
      m.style.maxHeight = "";
      if (stage) stage.style.height = "";
      return;
    }
    const cap = 340;                                   // matches the CSS cap
    const availW = (stage && stage.clientWidth) || 600;
    // NOT item.width/height: the rotate handler swaps those before calling
    // us, so they already describe the turned orientation and would apply
    // the swap twice. The element's natural size is always upright.
    let nw = m.naturalWidth || m.videoWidth || 0;
    let nh = m.naturalHeight || m.videoHeight || 0;
    if (!nw || !nh) {                 // not decoded yet: undo the swap by hand
      nw = (turned ? this.item.height : this.item.width) || 1;
      nh = (turned ? this.item.width : this.item.height) || 1;
    }
    // painted height = elW <= cap, painted width = elH = elW*nh/nw <= availW
    const elW = Math.max(1, Math.min(cap, availW * nw / nh));
    m.style.width = `${Math.round(elW)}px`;
    m.style.maxHeight = "none";
    if (stage) stage.style.height = `${Math.round(elW)}px`;
  }

  /** Turn the preview and re-fit the crop overlay to the new bounds. */
  syncRotate() {
    if (this.media) {
      this.media.style.transform =
        `${this.mirror ? "scaleX(-1) " : ""}rotate(${this.rotate}deg)`;
      this.sizeMedia();
      // A quarter turn changes where the pixels land without changing the
      // layout box; re-measure against the painted rect.
      if (this.cropBox) {
        requestAnimationFrame(() => {
          const w = this.item.width, h = this.item.height;
          if (this.stopFit) this.stopFit();
          this.stopFit = fitToMedia(this.media, this.cropBox, w, h,
                                    this.stageEl);
        });
      }
    }
    if (this.rotBtn) this.rotBtn.classList.toggle("on", !!this.rotate);
    this.showSize();
  }

  syncMirror() {
    if (this.media) {
      this.media.style.transform =
        `${this.mirror ? "scaleX(-1) " : ""}rotate(${this.rotate || 0}deg)`;
    }
    this.maskLayer?.mirror(this.mirror);
    if (this.mirrorBtn) this.mirrorBtn.classList.toggle("on", this.mirror);
  }

  forceAspect() {
    if (this.aspect === "free" || !this.crop) return;
    const target = parseFloat(this.aspect);
    if (!target) return;
    const vw = this.item.width || 16, vh = this.item.height || 9;
    const px = vw / vh;                 // pixels per unit of normalised space
    const c = this.crop;

    // Height that gives the requested pixel aspect for the current width.
    let h = (c.w * px) / target;
    if (h > 1 - c.y) {
      // Too tall to fit: keep the ratio by narrowing instead of squashing —
      // otherwise a portrait crop on a landscape source silently comes out
      // the wrong shape.
      h = 1 - c.y;
      c.w = Math.min(1 - c.x, (h * target) / px);
      h = (c.w * px) / target;
    }
    c.h = Math.max(0.02, Math.min(h, 1 - c.y));
    this.syncCrop();
  }

  cropDown(e, mode) {
    if (!this.cropMode) return;
    e.preventDefault();
    const wrap = (this.cropBox || this.cropWrap).getBoundingClientRect();
    const c0 = { ...this.crop, mx: e.clientX, my: e.clientY };
    const move = (ev) => {
      const dx = (ev.clientX - c0.mx) / wrap.width;
      const dy = (ev.clientY - c0.my) / wrap.height;
      const c = this.crop;
      if (mode === "move") {
        c.x = Math.min(Math.max(c0.x + dx, 0), 1 - c.w);
        c.y = Math.min(Math.max(c0.y + dy, 0), 1 - c.h);
      } else {
        if (mode.includes("w")) { c.x = Math.min(Math.max(c0.x + dx, 0), c0.x + c0.w - 0.05);
          c.w = c0.w + (c0.x - c.x); }
        if (mode.includes("e")) c.w = Math.min(Math.max(c0.w + dx, 0.05), 1 - c.x);
        if (mode.includes("n")) { c.y = Math.min(Math.max(c0.y + dy, 0), c0.y + c0.h - 0.05);
          c.h = c0.h + (c0.y - c.y); }
        if (mode.includes("s")) c.h = Math.min(Math.max(c0.h + dy, 0.05), 1 - c.y);
        if (this.aspect !== "free") this.forceAspect();
      }
      this.syncCrop();
    };
    const up = () => { window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  syncCrop() {
    if (!this.cropWrap) return;
    // The rect stays on screen whenever a crop exists — only editing is
    // toggled — so you can always see what the frame will be cut to.
    const show = this.cropMode || !!this.crop || !!this.maskOn || !!(this.maskLayer && this.maskShown);
    this.cropWrap.style.display = show ? "" : "none";
    this.cropWrap.style.pointerEvents = this.cropMode ? "" : "none";
    this.cropRect.classList.toggle("locked", !this.cropMode);
    this.cropRect.style.visibility = this.crop || this.cropMode ? "" : "hidden";
    this.cropBtn.classList.toggle("on", !!this.crop);
    this.aspectEl.style.display = this.cropMode && !(this.opts.aspect > 0) ? "" : "none";
    if (this.crop && this.cropRect) {
      const c = this.crop;
      Object.assign(this.cropRect.style, {
        left: `${c.x * 100}%`, top: `${c.y * 100}%`,
        width: `${c.w * 100}%`, height: `${c.h * 100}%`,
      });
    }
    this.showSize();
  }

  /* ---- capture the displayed frame as a picture reference ---------- */

  async captureFrame() {
    const panel = this.panel;
    // Same limits a dropped file would hit, checked before doing any work.
    // Refusals stay in the modal — closing it hides the reason and loses the
    // trim you just set.
    if (panel.count("picture") >= MAX.picture) {
      this.modalSay(`All ${MAX.picture} picture slots are in use \u2014 remove ` +
        "a picture before capturing a frame.", true);
      return;
    }
    // Over the reference budget isn't a reason to lose the frame: there's a
    // slot for it, so capture it and leave it switched off. Off items don't
    // count toward the budget, so nothing is over-sent.
    const overBudget = fileCount(panel.items) >= MAX.total;

    const v = this.media;
    const W = v.videoWidth, H = v.videoHeight;
    if (!W || !H) {
      this.modalSay("The preview hasn't loaded a frame yet \u2014 give it a " +
        "moment, then try again.", true);
      return;
    }

    // Honour an active crop so the still matches what the video would send.
    const c = this.crop;
    const sx = c ? Math.round(c.x * W) : 0;
    const sy = c ? Math.round(c.y * H) : 0;
    const sw = c ? Math.max(16, Math.round(c.w * W)) : W;
    const sh = c ? Math.max(16, Math.round(c.h * H)) : H;

    const canvas = document.createElement("canvas");
    canvas.width = sw; canvas.height = sh;
    const g = canvas.getContext("2d");
    if (this.mirror) { g.translate(sw, 0); g.scale(-1, 1); }
    // With the crop drawn on the mirrored view, take the mirrored source x.
    const rx = this.mirror ? (v.videoWidth - sx - sw) : sx;
    g.drawImage(v, rx, sy, sw, sh, 0, 0, sw, sh);

    const at = this.media.currentTime;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) {
      this.modalSay("Couldn't read that frame from the preview.", true);
      return;
    }

    const base = (this.item.name || "video").replace(/\.[^.]+$/, "");
    const stamp = at.toFixed(2).replace(".", "-");
    const file = new File([blob], `${base}_frame_${stamp}s.png`,
      { type: "image/png" });

    this.close();
    panel.busy += 1;
    panel.say(`Capturing frame at ${at.toFixed(2)}s\u2026`);
    panel.render();
    try {
      const info = await uploadFile(file);
      panel.items.push({
        kind: "picture",
        file: info.file,
        name: info.original || info.name,
        duration: null,
        width: sw,
        height: sh,
        has_audio: false,
        audio_mode: "off",
        ...(overBudget ? { enabled: false } : {}),
      });
      const how = (c ? " (cropped)" : "") + (this.mirror ? " (mirrored)" : "");
      panel.say(overBudget
        ? `Added ${sw}\u00d7${sh} frame from ${at.toFixed(2)}s${how} \u2014 ` +
          `switched off, because all ${MAX.total} references were already in ` +
          "use. Free a slot (a video's soundtrack counts as one) and switch " +
          "it on with \u25c9."
        : `Added ${sw}\u00d7${sh} frame from ${at.toFixed(2)}s${how} as a ` +
          "picture reference.", overBudget);
      panel.commit();
    } catch (err) {
      panel.say(`Capture failed: ${err.message}`, true);
      panel.render();
    } finally {
      panel.busy = Math.max(0, panel.busy - 1);
      panel.render();          // otherwise "uploading 1…" sticks forever
    }
  }

  /* ---- pull the trimmed span out as a standalone audio reference ---- */

  async useAudio() {
    const panel = this.panel;
    if (audioCount(panel.items) >= MAX.audio) {
      this.modalSay(`All ${MAX.audio} audio clips are in use \u2014 switch one ` +
        "off or remove it before extracting another.", true);
      return;
    }
    const overBudget = fileCount(panel.items) >= MAX.total;
    const span = this.end - this.start;
    if (span < CLIP.min) {
      this.modalSay(`That range is ${span.toFixed(1)}s. H3 was trained on ` +
        `${CLIP.min}\u2013${CLIP.max}s reference clips \u2014 widen it first.`, true);
      return;
    }

    this.close();
    panel.busy += 1;
    panel.say(`Extracting ${span.toFixed(1)}s of audio\u2026`);
    panel.render();
    try {
      const resp = await postApi("/minimax_h3/extract_audio", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: this.item.file,
          start: +this.start.toFixed(3), end: +this.end.toFixed(3) }),
      });
      const info = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(info.error || `failed (${resp.status})`);
      panel.items.push({
        kind: "audio", file: info.file, name: info.name,
        duration: info.duration ?? span, has_audio: true, audio_mode: "off",
        ...(overBudget ? { enabled: false } : {}),
      });
      const secs = (info.duration ?? span).toFixed(1);
      panel.say(overBudget
        ? `Added ${secs}s of audio from ${this.item.name} \u2014 switched off, ` +
          `because all ${MAX.total} references were already in use. Free a ` +
          "slot and switch it on with \u25c9."
        : `Added ${secs}s of audio from ${this.item.name} as a standalone ` +
          "reference.", overBudget);
      panel.commit();
    } catch (err) {
      panel.say(`Couldn't extract that audio: ${err.message}`, true);
      panel.render();
    } finally {
      panel.busy = Math.max(0, panel.busy - 1);
      panel.render();
    }
  }

  /* ---- assembly ---------------------------------------------------- */

  build() {
    this.buildMedia();
    const isVid = this.item.kind === "video";
    const isStill = this.isStill;
    // Pictures need the stage too — it holds the image and the crop overlay.
    const stage = (isVid || isStill)
      ? el("div", { class: "mml-tmstage" }, this.media,
          (this.cropUI = this.buildCrop(), this.cropWrap))
      : null;
    // The crop overlay is a child of the stage, so that is the frame its
    // coordinates are in. buildCrop() defers its first fit to a rAF, which
    // runs after this assignment.
    this.stageEl = stage;

    const chips = [2, 3].map((secs) =>
      this.dur > secs ? el("button", { class: "mml-btn mml-sm",
        title: `Use only the final ${secs} seconds`,
        onclick: () => { this.start = this.dur - secs; this.end = this.dur;
          this.seek(this.start); this.layoutTimeline(); } },
        `last ${secs}s`) : null);

    const still = this.isStill;
    this.overlay = el("div", { class: "mml-tmover",
      onmousedown: (e) => { if (e.target === this.overlay) this.tryClose(true); } },
      el("div", { class: "mml-tmmodal" + (isVid || still ? "" : " audio"), role: "dialog", "aria-modal": "true" },
        el("div", { class: "mml-tmhead" },
          this.titleEl = el("span", { class: "mml-tmtitle" },
            `${still ? "\u25a3" : "\u2702"} ${this.item.name}`),
          (isVid || still) ? this.cropUI : null,
          this.sizeControl(),
          this.canMask ? (this.maskViewBtn = el("button", { class: "mml-btn mml-sm mml-mktab on",
            title: "Show the clip's saved mask over the picture",
            onclick: () => { this.maskShown = !this.maskShown; setOverlay(this.maskShown); this.refreshMaskLayer(); } },
            "\u25d0 show mask")) : null,
          this.canMask ? (this.maskRegenBtn = el("button", { class: "mml-btn mml-sm mml-mktab",
            title: "Show the area H3 actually regenerates: the mask grown and rounded out to the latent's 16-pixel " +
                   "cells at the sampling size (read from the Text Encode's width \u00d7 height)",
            onclick: () => { this.showRegen = !this.showRegen; this.refreshMaskLayer(); } }, "\u25a6 regenerated")) : null,
          this.canMask ? (this.maskTab = el("button", { class: "mml-btn mml-sm mml-mktab",
            title: "Mask part of this clip for editing, on the trim and crop set here",
            onclick: () => this.setMaskMode(!this.maskOn) }, "\u25d0 Mask")) : null,
          el("button", { class: "mml-x", onclick: () => this.tryClose() }, "\u2715")),
        el("div", { class: "mml-tmbody" },
          el("div", { class: "mml-tmleft" },
            stage,
            still ? null : this.buildTimeline(),
            still ? null : el("div", { class: "mml-tmfoot" },
              el("button", { class: "mml-btn mml-sm", title: "Jump the playhead to the trim start (Home)",
                onclick: () => this.seek(this.start) }, "\u25c2 to start"),
              el("button", { class: "mml-btn mml-sm", title: "Previous frame (\u2190)",
                onclick: () => this.seek((this.media?.currentTime || 0) -
                  1 / (this.item.fps || TRIM_FPS)) }, "\u25c0|"),
              this.playBtn,
              this.muteBtn,
              el("button", { class: "mml-btn mml-sm", title: "Next frame (\u2192)",
                onclick: () => this.seek((this.media?.currentTime || 0) +
                  1 / (this.item.fps || TRIM_FPS)) }, "|\u25b6"),
              el("button", { class: "mml-btn mml-sm", title: "Jump the playhead to the last kept frame (End)",
                onclick: () => this.seek(Math.max(this.start, this.end - 1 / (this.item.fps || TRIM_FPS))) }, "to end \u25b8"),
              el("span", { class: "mml-tmgap" }),
              el("button", { class: "mml-btn mml-sm",
                title: "Set start to the playhead  ( [ )",
                onclick: () => { this.start =
                  Math.min(this.media?.currentTime || 0, this.end - 0.1);
                  this.layoutTimeline(); } }, "\u21e4 start"),
              this.numStart, el("span", { class: "mml-tmdash" }, "\u2013"),
              this.numEnd,
              el("button", { class: "mml-btn mml-sm",
                title: "Set end to the playhead  ( ] )",
                onclick: () => { this.end =
                  Math.max(this.media?.currentTime || 0, this.start + 0.1);
                  this.layoutTimeline(); } }, "end \u21e5"),
              this.readout,
              el("span", { class: "mml-tmspace" }),
              el("button", { class: "mml-btn mml-sm",
                title: "Jump the playhead to the clip's first frame",
                onclick: () => this.seek(0) }, "\u23ee First"),
              el("button", { class: "mml-btn mml-sm",
                title: "Jump the playhead to the clip's last frame \u2014 " +
                       "then \u{1F4F7} to capture it",
                onclick: () => this.seek(Math.max(0,
                  this.dur - 1 / (this.item.fps || TRIM_FPS))) },
                "Last \u23ed"))),
          this.canMask ? (this.maskSide = el("div", { class: "mml-tmside", hidden: true })) : null),
        this.actRow = el("div", { class: "mml-tmfoot act" },
          ...(still ? [] : chips),
          (isVid && !still && !this.opts.noAdd) ? el("button", { class: "mml-btn mml-sm",
            title: "Add the frame shown above as a picture reference  ( C )",
            onclick: () => this.captureFrame() }, "\u{1F4F7} Use frame") : null,
          (!still && !this.opts.noAdd && (this.item.kind === "audio" || this.item.has_audio))
            ? el("button", { class: "mml-btn mml-sm",
                title: "Save the kept range as its own audio reference  ( A )",
                onclick: () => this.useAudio() }, "\u{1F3B5} Use audio")
            : null,
          el("span", { class: "mml-tmspace" }),
          (this.item.trim || this.item.crop || this.opts.aspect > 0)
            ? el("button", { class: "mml-btn mml-sm",
                title: this.opts.aspect > 0 ? "Back to the automatic centred fit" : "Whole clip, no crop",
                onclick: () => { this.start = 0; this.end = this.dur;
                  if (this.rotate % 180) {          // undo the turn's size swap too
                    const t = this.item.width; this.item.width = this.item.height; this.item.height = t;
                  }
                  this.crop = null; this.cropMode = false; this.mirror = false;
                  this.rotate = 0; this.resize = 0;
                  if (this.opts.aspect > 0) {
                    this.crop = coverRect(this.item.width, this.item.height, this.opts.aspect);
                    this.cropMode = true;
                  }
                  this.customSize = false; this.syncSize();
                  this.syncCrop(); this.syncMirror(); this.syncRotate();
                  this.layoutTimeline(); } },
                "\u21ba Reset")
            : null,
          el("button", { class: "mml-btn mml-sm primary",
            onclick: () => this.apply() }, "Apply"),
          el("button", { class: "mml-btn mml-sm",
            onclick: () => this.tryClose() }, "Cancel")),
        this.maskSlot = el("div", {}),
        this.note,
        still ? el("div", { class: "mml-tmkeys" }, this.opts.aspect > 0
          ? "Drag the box over the part to keep \u00b7 drag a corner to resize \u00b7 esc closes"
          : "Drag a box to crop \u00b7 \u25a3 toggles editing \u00b7 esc closes")
        : el("div", { class: "mml-tmkeys" },
          "\u2190 \u2192 step a frame (shift = 10) \u00b7 space play \u00b7 " +
          "[ ] set start/end here \u00b7 home/end jump \u00b7 M mute \u00b7 A use audio" +
          (isVid ? " \u00b7 C capture frame" : "") + " \u00b7 - / = zoom (or scroll the timeline)")));
    // Opening straight into crop editing made sense when cropping was the
    // only reason to be here; rotate and size mean it no longer is. Start in
    // whatever state the picture is already in.
    if (still && this.crop) this.cropMode = false;
    if (this.opts.aspect > 0) this.cropMode = true;
    this.showSize();
    this.syncCrop();
    this.syncMirror();
    this.syncRotate();
    if (!still) this.seek(this.start, false);
    this.maskShown = overlayOn();
    this.refreshMaskLayer();
    if (this.opts.mask && this.canMask) this.setMaskMode(true);
  }

  /** The mask drawn over the picture, synced to the playhead: in mask mode
   *  the layers as they are being edited, otherwise the saved mask. */
  refreshMaskLayer() {
    if (!this.canMask) return;
    const live = this.maskOn && this.masker;
    const sprite = !live && this.item.mask && this.item.mask_info?.sprite;
    const file = live ? "layers" : sprite?.file;
    if (this.maskLayer && this.maskLayer.file !== file) { this.maskLayer.detach(); this.maskLayer = null; }
    if (file && !this.maskLayer) {
      this.maskLayer = maskOverlay(this.media, this.cropBox, sprite, "fill",
        live ? { paint: (...a) => this.masker.paint(...a) } : {});
      this.maskLayer.file = file;
    }
    this.maskViewBtn.hidden = !file;
    this.maskViewBtn.classList.toggle("on", !!this.maskShown);
    this.maskRegenBtn.hidden = !file || !this.maskShown;
    this.maskRegenBtn.classList.toggle("on", !!this.showRegen);
    if (this.maskLayer) {
      this.maskLayer.setLook(this.maskLook());
      this.maskLayer.show(!!this.maskShown);
      this.maskLayer.mirror(this.mirror);
    }
    if (!this.maskNote) {
      this.maskNote = el("div", { class: "mml-mknote", title: OVERLAY_NOTE }, "\u25d0 mask preview \u2014 approximate");
      this.stageEl.append(this.maskNote);
    }
    this.maskNote.hidden = !(this.maskLayer && this.maskShown);
    this.maskNote.style.pointerEvents = this.maskOn ? "none" : "";     // it sits on the picture being drawn on
    this.syncCrop();
  }

  /** How the edit will shape the mask at the editor's current crop and size:
   *  mask mode's layers, otherwise the clip's saved mask. */
  maskLook() {
    return this.maskOn && this.masker ? this.masker.look()
      : { ...itemLook(this.item, this.crop, this.resize), block: this.showRegen ? regenBlock(this.item, this.crop, this.resize) : 0 };
  }

  /** Mask mode: the same clip, trim and crop, with the mask's layers beside
   *  the picture. Crop editing is set aside while it's on. */
  setMaskMode(on) {
    if (!this.canMask) return;
    if (on && !this.masker) {
      this.masker = new MaskMode(this);
      this.maskSide.append(this.masker.side);
      this.maskSlot.append(this.masker.bottom);
    }
    this.maskOn = on;
    if (on) this.cropMode = false;
    this.cropUI.style.display = on ? "none" : "";
    this.actRow.hidden = on;
    this.maskSide.hidden = this.maskSlot.hidden = !on;
    applyEditorSize(this.modal, on);
    this.maskTab.classList.toggle("on", on);
    this.maskTab.textContent = on ? "\u2702 Trim & crop" : "\u25d0 Mask";
    this.titleEl.textContent = `${on ? "\u25d0 Mask for editing \u2014" : "\u2702"} ${this.item.name}`;
    this.syncCrop();
    this.masker.show(on);
    this.refreshMaskLayer();
  }
}

/* ------------------------------------------------------------------ */
/* Mask for editing: the editor's mask mode, with SAM 3.1              */
/* ------------------------------------------------------------------ */

const MASK_NODE = "MiniMaxH3FantasticObjectMask";
const MASK_KEYS = ["edit", "mask_box", "mask", "mask_info", "mask_layers", "mask_grow", "mask_range", "keep_audio",
  "mask_feather", "mask_invert", "mask_crop", "mask_context", "mask_ref_strength", "mask_hide", "mask_blur"];
const REF_TOKEN_WARN = 30000;   // matches the Text Encode's warning

/** Reference tokens a loader clip costs when cited, as the Text Encode will
 *  size it: its kept span and frame (crop, size cap) on H3's reference
 *  canvas (768 short edge, 768 x 1344 area cap, never enlarged), cut to
 *  17k + 5 frames. `over` overrides the item's trim/crop/resize (the editor's
 *  unapplied values). */
export function refTokenEstimate(item, over = {}) {
  const crop = "crop" in over ? over.crop : item.crop;
  const resize = "resize" in over ? over.resize : item.resize;
  const box = "box" in over ? over.box : item.mask_crop && item.mask_box;
  let w = (item.width || 0) * (crop?.w ?? 1), h = (item.height || 0) * (crop?.h ?? 1);
  if (!w || !h) return 0;
  if (resize && Math.max(w, h) > resize) { const k = resize / Math.max(w, h); w *= k; h *= k; }
  // crop to mask cites just its box
  if (box) { w *= box.w / (crop?.w ?? 1); h *= box.h / (crop?.h ?? 1); }
  const r = w / h;
  let nw = r >= 1 ? 768 * r : 768, nh = r >= 1 ? 768 : 768 / r;
  if (nw * nh > 768 * 1344) { const k = Math.sqrt(768 * 1344 / (nw * nh)); nw *= k; nh *= k; }
  let cw = Math.max(32, Math.round(nw / 32) * 32), ch = Math.max(32, Math.round(nh / 32) * 32);
  if (w * h < cw * ch) { cw = Math.max(32, Math.round(w / 32) * 32); ch = Math.max(32, Math.round(h / 32) * 32); }
  const start = "start" in over ? over.start : (item.trim?.start || 0);
  const end = "end" in over ? over.end : (item.trim?.end ?? item.duration ?? 0);
  const frames = Math.floor(Math.max(0, end - start) * TRIM_FPS);
  if (frames < 5) return 0;
  const k = Math.floor((frames - 5) / 17) * 17 + 5;
  return ((k - 5) / 17 * 5 + 2) * (ch / 32) * (cw / 32);
}

/** Take a clip's mask off, with an Undo in the loader's message line. The
 *  mask file stays on disk, so undoing just puts the settings back. */
function clearMaskOn(panel, item, commit = true) {
  const it = panel.live?.(item) || item;
  const saved = {};
  MASK_KEYS.forEach((k) => { if (k in it) saved[k] = it[k]; delete it[k]; });
  panel.say(`${it.name} is no longer being edited \u2014 its mask was cleared, so the next run regenerates ` +
    "the whole clip.", true, { label: "Undo", fn: () => {
      Object.assign(panel.live?.(it) || it, saved);
      panel.say(`${it.name}'s mask is back.`);
      panel.commit();
    } });
  if (commit) panel.commit();
  return it;
}

/** A button that acts on its second click within a few seconds, so a stray
 *  click can't do something hard to notice. */
function armTwice(btn, armedLabel, fn) {
  const label = btn.textContent;
  let timer = null;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed"); btn.textContent = armedLabel;
      timer = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = label; }, 3500);
      return;
    }
    clearTimeout(timer); btn.classList.remove("armed"); btn.textContent = label;
    fn();
  });
  return btn;
}
const setKids = (node, kids) => node.replaceChildren(...[kids].flat(Infinity).filter((k) => k != null));
const SAM_LINK = "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors";
const SAM_KEY = "mmh3.samCheckpoint";

const CLEANUP_KEY = "mmh3.maskCleanupMB";

/** The ⚙ clean-up reminder: MB of unused mask files that prompt a Clean up
 *  (0 = never). */
function cleanupMB() {
  try {
    const v = localStorage.getItem(CLEANUP_KEY);
    return v === null ? 500 : Math.max(0, Math.round(+v || 0));
  } catch (e) { return 500; }
}

const fmtMB = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
// Shared by every loader on the page: one check at a time, and after a
// reminder the next waits until another threshold's worth has piled up.
let nudgeAt = 0, nudgeChecking = false;

const OVERLAY_KEY = "mmh3.maskOverlay";
const OVERLAY_NOTE = "Mask preview: a low-resolution copy drawn for reference. The mask sent to the model is " +
  "full resolution, so edges may differ slightly.";

/** Whether saved masks are drawn over clips, in the editor and on loader cards. */
export function overlayOn() {
  try { return localStorage.getItem(OVERLAY_KEY) !== "off"; } catch (e) { return true; }
}

function setOverlay(on) {
  try { localStorage.setItem(OVERLAY_KEY, on ? "on" : "off"); } catch (e) { /* this session only */ }
  for (const n of app.graph?._nodes || []) (n._mmlPanels || []).forEach((p) => p.render());
}

const spriteCache = new Map();
function spriteImage(file) {
  let img = spriteCache.get(file);
  if (!img) { img = new Image(); img.src = viewURL(file); spriteCache.set(file, img); }
  return img;
}

/** Draw a clip's saved mask over `video` for the frame on screen, from the
 *  masking run's sprite (one small tile per frame). `fit` is "fill" when `box`
 *  is exactly the drawn frame (the editor's crop box) or "contain" when it's
 *  the whole element (the loader card). Frames outside the masked span draw
 *  nothing, so the overlay also shows where it stops.
 *
 *  `look` shapes it the way the edit will: `grow` (pixels of the frame the
 *  edit is built from; `frameW` is the uncropped frame's width in those
 *  pixels) widens it, `invert` shows everything else,
 *  `block` (frame pixels) rounds it out to the latent's 16-pixel cells at
 *  the sampling size — the area really regenerated — and `cropBox` ({x, y, w, h}
 *  on the source frame) outlines what crop to mask samples.
 *
 *  `paint(ctx, t, dx, dy, dw, dh)` draws the mask for time t in white instead
 *  of a sprite (mask mode's layers, which cover the whole clip). */
export function maskOverlay(video, box, sprite, fit, { append = false, onMissing = null, look = {}, paint = null } = {}) {
  const canvas = el("canvas", { class: "mml-mkoverlay" });
  if (append) box.append(canvas); else box.prepend(canvas);
  const img = paint ? null : spriteImage(sprite.file);
  const work = document.createElement("canvas"), base = document.createElement("canvas");
  let raf = null, on = true;
  const draw = () => {
    const r = box.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    if (!on || (img && (!img.complete || !img.naturalWidth))) return;
    const f = paint ? 0 : Math.round((video.currentTime || 0) * TRIM_FPS) - (sprite.start || 0);
    const i = paint ? 0 : Math.floor(f / (sprite.step || 1));
    let dx = 0, dy = 0, dw = W, dh = H;
    if (fit === "contain") {
      const vw = video.videoWidth || sprite.tw, vh = video.videoHeight || sprite.th;
      const k = Math.min(W / vw, H / vh);
      dw = vw * k; dh = vh * k; dx = (W - dw) / 2; dy = (H - dh) / 2;
    }
    const covered = paint || (f >= 0 && i < sprite.count);
    if (covered) {
      work.width = W; work.height = H;
      const w = work.getContext("2d");
      base.width = W; base.height = H;
      if (paint) paint(base.getContext("2d"), video.currentTime || 0, dx, dy, dw, dh);
      else base.getContext("2d").drawImage(img, (i % sprite.cols) * sprite.tw, Math.floor(i / sprite.cols) * sprite.th,
        sprite.tw, sprite.th, dx, dy, dw, dh);
      // grow: the mask stamped around a ring of offsets is its dilation
      const g = look.grow && look.frameW ? look.grow * dw / look.frameW : 0;
      const rings = g >= 1 ? [g, g / 2] : [];
      w.drawImage(base, 0, 0);
      for (const rad of rings) {
        for (let a = 0; a < 16; a++) w.drawImage(base, rad * Math.cos(a * Math.PI / 8), rad * Math.sin(a * Math.PI / 8));
      }
      if (look.invert) {
        w.globalCompositeOperation = "xor";
        w.fillStyle = "#fff";
        w.fillRect(dx, dy, dw, dh);
        w.globalCompositeOperation = "source-over";
      }
      const cell = look.block && look.frameW ? look.block * dw / look.frameW : 0;
      if (cell >= 2) {
        // the area H3 regenerates: any patch the mask touches, whole
        const cw = Math.max(1, Math.ceil(dw / cell)), ch = Math.max(1, Math.ceil(dh / cell));
        const small = document.createElement("canvas");
        small.width = cw; small.height = ch;
        const s2 = small.getContext("2d");
        s2.drawImage(work, dx, dy, dw, dh, 0, 0, cw, ch);
        const px = s2.getImageData(0, 0, cw, ch);
        for (let p = 3; p < px.data.length; p += 4) px.data[p] = px.data[p] > 0 ? 255 : 0;
        s2.putImageData(px, 0, 0);
        w.clearRect(0, 0, W, H);
        w.imageSmoothingEnabled = false;
        w.drawImage(small, 0, 0, cw, ch, dx, dy, cw * cell, ch * cell);
      }
      ctx.drawImage(work, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = cell >= 2 ? "rgba(255, 160, 40, 0.45)" : "rgba(26, 242, 255, 0.5)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    }
    if (look.cropBox) {
      const c = look.cropBox;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = "rgba(255, 220, 90, 0.95)";
      ctx.strokeRect(dx + c.x * dw, dy + c.y * dh, c.w * dw, c.h * dh);
      ctx.setLineDash([]);
    }
  };
  const loop = () => { draw(); raf = video.paused || video.ended ? null : requestAnimationFrame(loop); };
  const kick = () => { if (!raf) loop(); };
  const events = ["play", "seeked", "timeupdate", "loadedmetadata"];
  events.forEach((e) => video.addEventListener(e, kick));
  img?.addEventListener("load", draw);
  if (onMissing) {
    if (img.complete && !img.naturalWidth && img.src) onMissing();
    else img.addEventListener("error", onMissing, { once: true });
  }
  const ro = new ResizeObserver(draw);
  ro.observe(box);
  draw();
  return {
    show(v) { on = v; canvas.hidden = !v; draw(); },
    mirror(m) { canvas.style.transform = m ? "scaleX(-1)" : ""; },
    setLook(next) { look = next || {}; draw(); },
    redraw: draw,
    detach() {
      events.forEach((e) => video.removeEventListener(e, kick));
      img?.removeEventListener("load", draw);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}

/** The union of a mask sprite's tiles over frames [from, to) as {x, y, w, h}
 *  on the source frame, or null — for placing the crop-to-mask box. */
export async function spriteBounds(sprite, from = 0, to = Infinity) {
  const img = spriteImage(sprite.file);
  if (!img.complete) await new Promise((res) => { img.addEventListener("load", res, { once: true });
    img.addEventListener("error", res, { once: true }); });
  if (!img.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const first = Math.max(0, Math.floor((from - (sprite.start || 0)) / (sprite.step || 1)));
  const last = Math.min(sprite.count, Math.ceil((to - (sprite.start || 0)) / (sprite.step || 1)));
  for (let i = first; i < last; i++) {
    const ox = (i % sprite.cols) * sprite.tw, oy = Math.floor(i / sprite.cols) * sprite.th;
    for (let y = 0; y < sprite.th; y++) {
      for (let x = 0; x < sprite.tw; x++) {
        if (data[((oy + y) * c.width + ox + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  }
  return x1 < 0 ? null : { x: x0 / sprite.tw, y: y0 / sprite.th, w: (x1 - x0 + 1) / sprite.tw, h: (y1 - y0 + 1) / sprite.th };
}

/** A clip's frame as the loader sends it, in pixels (its crop and size cap). */
function sentFrame(item, crop = item.crop, resize = item.resize) {
  let w = (item.width || 0) * (crop?.w ?? 1), h = (item.height || 0) * (crop?.h ?? 1);
  if (resize && Math.max(w, h) > resize) { const k = resize / Math.max(w, h); w *= k; h *= k; }
  return { W: w, H: h };
}

/** How a saved mask is shaped for the edit, for drawing it (no crop box: that
 *  needs the mask itself, and mask mode draws it). */
export function itemLook(item, crop = item.crop, resize = item.resize) {
  return { grow: Number.isFinite(+item.mask_grow) ? +item.mask_grow : 16,
    frameW: sentFrame(item, crop, resize).W / (crop?.w ?? 1), invert: !!item.mask_invert };
}

/** A latent cell in frame pixels at the sampling size, without crop to mask:
 *  the sampler holds or regenerates whole 16-pixel cells. */
function regenBlock(item, crop, resize) {
  const { W, H } = sentFrame(item, crop, resize);
  return 16 / Math.min(1, Math.sqrt(sampleBudget() / Math.max(1, W * H)));
}

/** The Text Encode's width x height in this graph, for sizing previews of
 *  what an edit samples; 1344 x 768 when there isn't one to read. */
function sampleBudget() {
  for (const n of app.graph?._nodes || []) {
    if (!/RefModTextEncode/.test(n.type || "")) continue;
    const w = +n.widgets?.find((x) => x.name === "width")?.value, h = +n.widgets?.find((x) => x.name === "height")?.value;
    if (w > 0 && h > 0) return w * h;
  }
  return 1344 * 768;
}

/** Checkpoints ComfyUI can see, SAM 3 ones first. */
async function samCheckpoints() {
  try {
    const info = await (await api.fetchApi("/object_info/CheckpointLoaderSimple")).json();
    const spec = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name || [];
    const list = Array.isArray(spec[0]) ? spec[0] : (spec[1]?.options || []);
    return [...list].sort((a, b) => (/sam3/i.test(b) ? 1 : 0) - (/sam3/i.test(a) ? 1 : 0));
  } catch (e) { return []; }
}

/* The mask editor builds a clip's mask from a stack of layers, like an image
   editor's: new ones go on top, and each adds to or cuts from the layers
   below it. `layers` is in stack order, bottom first; the list shows it top
   first. The kinds: Auto Mask (SAM 3.1, run
   through the queue), keyframed ellipses, rectangles and polygons, and brush
   strokes. The layers are kept on the clip (mask_layers) and drawn here live;
   Use this mask has object_mask.compose_layers draw them into the one mask the
   edit uses. Everything is stored against the source frame (no crop, no
   mirror) in source seconds, like the dots always were. The shape keyframing
   follows BISAM20's Animated Mask Editor,
   https://github.com/BISAM20/ComfyUI-AnimatedMaskEditor
   (MIT License, Copyright (c) 2026 Bishoy Samaan). */

const LAYER_KIND = {
  auto: { badge: "Auto", color: "#3ec46d", label: "Auto Mask", name: "auto mask" },
  ellipse: { badge: "◯", color: "#9fe3f5", label: "Ellipse", name: "ellipse" },
  rect: { badge: "▭", color: "#9fe3f5", label: "Rectangle", name: "rectangle" },
  poly: { badge: "⬠", color: "#9fe3f5", label: "Polygon", name: "polygon" },
  brush: { badge: "✎", color: "#b48ce8", label: "Brush", name: "brush" },
};
const MOTION_HINT = {
  smooth: "Curves through each key without stopping. Best for following motion.",
  linear: "Constant speed, with a sharp turn at each key.",
  ease: "Slows into and out of every key. For things that start and stop.",
};
/** Whether a layer has anything to draw yet. */
const layerDraws = (l) => l.kind === "auto" ? !!l.result
  : l.kind === "brush" ? (l.strokes || []).some((s) => !s.erase) : sortedKeys(l).length > 0;
const ANIMATE_HINT = "To animate it, go to another frame and move, resize or turn it there.";
const isShape = (layer) => layer.kind === "ellipse" || layer.kind === "rect" || layer.kind === "poly";
const frameTime = (t) => Math.round(t * TRIM_FPS) / TRIM_FPS;
const sameFrame = (a, b) => Math.abs(a - b) < 0.5 / TRIM_FPS;
const clone = (v) => JSON.parse(JSON.stringify(v));
const layerId = () => `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A shape layer's keys by time, one per time: object_mask._keys. */
function sortedKeys(layer) {
  const out = [];
  for (const k of [...(layer.keys || [])].sort((a, b) => a.t - b.t)) {
    if (out.length && Math.abs(k.t - out[out.length - 1].t) < 1e-6) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/** get(key) at time t between keys, held before the first and after the
 *  last: the twin of object_mask._curve, so the preview is the saved mask. */
function keyCurve(keys, t, get, motion) {
  if (t <= keys[0].t) return get(keys[0]);
  if (t >= keys[keys.length - 1].t) return get(keys[keys.length - 1]);
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1], span = b.t - a.t, u = (t - a.t) / span;
  const va = get(a), vb = get(b);
  if (motion === "linear") return va + (vb - va) * u;
  if (motion === "ease") return va + (vb - va) * u * u * (3 - 2 * u);
  const p0 = keys[i - 1] || a, p3 = keys[i + 2] || b;
  const m1 = (vb - get(p0)) / (b.t - p0.t) * span, m2 = (get(p3) - va) / (p3.t - a.t) * span;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * va + (u3 - 2 * u2 + u) * m1 + (3 * u2 - 2 * u3) * vb + (u3 - u2) * m2;
}

/** A shape layer at time t, {x, y, w, h, rot} or {pts, rot} with `off`; null
 *  with no keys, and while hidden unless `hidden` asks for it anyway. */
function shapeAt(layer, t, hidden = false) {
  const keys = sortedKeys(layer);
  if (!keys.length) return null;
  let cur = keys[0];
  for (const k of keys) if (k.t <= t + 1e-6) cur = k;
  if (cur.off && !hidden) return null;
  const motion = MOTION_HINT[layer.motion] ? layer.motion : "smooth";
  const val = (get) => keyCurve(keys, t, get, motion);
  const rot = val((k) => k.rot || 0);
  if (layer.kind === "poly") {
    return { pts: keys[0].pts.map((_, i) => [val((k) => k.pts[i][0]), val((k) => k.pts[i][1])]), rot, off: !!cur.off };
  }
  return { x: val((k) => k.x), y: val((k) => k.y), w: val((k) => k.w), h: val((k) => k.h), rot, off: !!cur.off };
}

/** The stored part of a shape state, rounded. */
function shapeGeo(kind, s) {
  const r = (v) => +(+v).toFixed(5);
  return kind === "poly" ? { pts: s.pts.map((q) => [r(q[0]), r(q[1])]), rot: +(s.rot || 0).toFixed(3) }
    : { x: r(s.x), y: r(s.y), w: r(s.w), h: r(s.h), rot: +(s.rot || 0).toFixed(3) };
}

/** A shape's centre, half-size and angle in pixels of a W x H frame. A
 *  polygon turns about its bounding box's centre, as object_mask._outline. */
function shapeFrame(kind, s, W, H) {
  if (kind === "poly") {
    const xs = s.pts.map((q) => q[0] * W), ys = s.pts.map((q) => q[1] * H);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2, a: s.rot * Math.PI / 180 };
  }
  return { cx: s.x * W, cy: s.y * H, rx: Math.abs(s.w) * W / 2, ry: Math.abs(s.h) * H / 2, a: s.rot * Math.PI / 180 };
}
const toPx = (f, lx, ly) => [f.cx + lx * Math.cos(f.a) - ly * Math.sin(f.a), f.cy + lx * Math.sin(f.a) + ly * Math.cos(f.a)];
function toLocal(f, px, py) {
  const dx = px - f.cx, dy = py - f.cy;
  return [dx * Math.cos(f.a) + dy * Math.sin(f.a), -dx * Math.sin(f.a) + dy * Math.cos(f.a)];
}

/** A shape's outline in pixels of a W x H frame: object_mask._outline. */
function shapeOutline(kind, s, W, H) {
  const f = shapeFrame(kind, s, W, H);
  const local = kind === "poly" ? s.pts.map((q) => [q[0] * W - f.cx, q[1] * H - f.cy])
    : kind === "ellipse" ? Array.from({ length: 96 }, (_, i) => [f.rx * Math.cos(2 * Math.PI * i / 96), f.ry * Math.sin(2 * Math.PI * i / 96)])
    : [[-f.rx, -f.ry], [f.rx, -f.ry], [f.rx, f.ry], [-f.rx, f.ry]];
  return local.map((q) => toPx(f, q[0], q[1]));
}

function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, y) to segment a-b, and how far along it the nearest point is. */
function toSegment(a, b, x, y) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const u = len ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len)) : 0;
  return { d: Math.hypot(x - (a[0] + u * dx), y - (a[1] + u * dy)), u };
}

/** Whether a brush stroke paints frame f: its own frame, from there on, or all. */
function strokeReaches(s, f) {
  const k = Math.round((s.time || 0) * TRIM_FPS);
  return s.reach === "all" || (s.reach === "forward" ? f >= k : f === k);
}

function strokePath(c, s, dx, dy, dw, dh) {
  const r = (s.r || 0.02) * dh;
  const pts = s.points || [];
  if (pts.length === 1) {
    c.beginPath(); c.arc(dx + pts[0].x * dw, dy + pts[0].y * dh, r, 0, 2 * Math.PI); c.fill();
    return;
  }
  c.lineWidth = 2 * r; c.lineCap = "round"; c.lineJoin = "round";
  c.beginPath();
  pts.forEach((q, i) => (i ? c.lineTo : c.moveTo).call(c, dx + q.x * dw, dy + q.y * dh));
  c.stroke();
}

class MaskMode {
  constructor(host) {
    this.host = host;
    const item = host.item;
    this.layers = clone(item.mask_layers || []);
    if (!this.layers.length) this.layers.push(this.newLayer("auto"));
    this.sel = this.layers[0].id;
    this.hover = null;
    this.dirty = false;
    this.undos = [];
    this.autokey = true;
    this.brush = { erase: false, size: 4, reach: "frame" };
    this.drawing = null;             // a polygon being clicked out: { layer, pts, t }
    this.drag = null;
    this.pointer = null;
    this.running = null;             // the Auto Mask layer whose SAM job is queued
    this.lastFrame = -1;
    this.composed = item.mask && item.mask_info?.sprite ? { file: item.mask, ...item.mask_info } : null;
    this.grow = Number.isFinite(+item.mask_grow) ? +item.mask_grow : 16;
    this.feather = Number.isFinite(+item.mask_feather) ? +item.mask_feather : 12;
    this.invert = !!item.mask_invert;
    this.cropOn = !!item.mask_crop;
    this.context = Number.isFinite(+item.mask_context) && +item.mask_context > 0 ? +item.mask_context : 1.75;
    this.keepAudio = item.keep_audio !== false;
    this.refStrength = Number.isFinite(+item.mask_ref_strength) && +item.mask_ref_strength > 0 ? +item.mask_ref_strength : 1;
    this.hide = ["blur", "invert", "blur_invert"].includes(item.mask_hide) ? item.mask_hide : "off";
    this.blur = Number.isFinite(+item.mask_blur) && +item.mask_blur > 0 ? +item.mask_blur : 24;
    this.build();
    this.syncHide();
    const onTime = () => this.onTime();
    host.media.addEventListener("timeupdate", onTime);
    host.media.addEventListener("seeked", onTime);
    host.media.addEventListener("play", () => this.playLoop());
    this.loadCheckpoints();
  }

  build() {
    const h = this.host;
    // Outlines, handles, dots and strokes are drawn in the source frame's
    // coordinates and mirrored with the picture; the pointer lands on the
    // surface, which isn't mirrored (pos() turns it back).
    this.decor = el("canvas", { class: "mml-mkoverlay mml-mkdecor" });
    this.surface = el("div", { class: "mml-mkdots",
      onpointerdown: (e) => this.down(e), onpointermove: (e) => this.move(e),
      onpointerup: (e) => this.up(e),
      onpointerleave: () => { this.pointer = null; this.drawDecor(); },
      oncontextmenu: (e) => { e.preventDefault(); this.rightClick(e); } });
    h.cropBox.append(this.decor, this.surface);
    new ResizeObserver(() => this.drawDecor()).observe(h.cropBox);
    this.lane = el("div", { class: "mml-lyrlane" });
    h.bar.after(this.lane);
    h.overlay.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".mml-lyrmenu, .mml-lyraddbtn, .mml-lyrmore")) this.hideMenus();
    });

    this.ckpt = el("select", { class: "mml-mkckpt", title: "The SAM 3.1 checkpoint in models/checkpoints",
      onchange: (e) => { try { localStorage.setItem(SAM_KEY, e.target.value); } catch (err) {} } });
    const addItem = (kind, title, help) => el("button", { class: "mml-lyrmenuitem",
      onclick: (e) => { e.stopPropagation(); this.addLayer(kind); } },
      el("span", {}, el("span", { style: { color: LAYER_KIND[kind].color } }, kind === "auto" ? "◉" : LAYER_KIND[kind].badge),
        ` ${title}`),
      el("i", {}, help));
    this.addMenu = el("div", { class: "mml-lyrmenu", hidden: true },
      addItem("auto", "Auto Mask with SAM", "Click on what you want masked and type what it is; SAM outlines it and follows it through the clip"),
      addItem("ellipse", "Ellipse", "Drag to draw; move or resize it on other frames to animate"),
      addItem("rect", "Rectangle", "Drag to draw; rotates and keys like the ellipse"),
      addItem("poly", "Polygon", "Click points; click the first point to close it"),
      addItem("brush", "Brush", "Paint by hand on a frame, a span or the whole clip"));
    this.rowMenu = el("div", { class: "mml-lyrmenu mml-lyrrowmenu", hidden: true });
    this.layerList = el("div", { class: "mml-lyrlist" });
    this.panel = el("div", { class: "mml-lyrcard mml-lyrpanel" });
    this.side = el("div", { class: "mml-lyrside" },
      el("div", { class: "mml-lyrcard" },
        el("div", { class: "mml-lyrhead" },
          el("span", { class: "mml-lyrcap" }, "Layers"),
          el("span", { class: "mml-mkhint" }, "new ones on top"),
          el("span", { class: "mml-tmspace" }),
          el("button", { class: "mml-btn mml-sm on mml-lyraddbtn",
            onclick: (e) => { e.stopPropagation(); this.rowMenu.hidden = true; this.addMenu.hidden = !this.addMenu.hidden; } },
            "+ Add layer ▾")),
        this.layerList, this.addMenu, this.rowMenu,
        el("div", { class: "mml-lyrhelp" }, "Add paints a layer into the mask; Cut takes its area out of the layers " +
          "below it. The eye leaves a layer out without deleting it. Drag ⠇ to reorder; hover a row to outline it " +
          "on the video.")),
      this.panel);

    const slider = (label, title, min, max, step, get, set, unit = "px", digits = 0) => {
      const val = el("span", { class: "mml-mkdim" }, `${get().toFixed(digits)}${unit}`);
      const input = el("input", { type: "range", min, max, step, value: get(),
        oninput: (e) => { set(+e.target.value); val.textContent = `${get().toFixed(digits)}${unit}`; this.dirty = true; this.syncFoot(); } });
      return { el: el("label", { class: "mml-mklbl", title }, label, input, val), input, val, unit, digits };
    };
    this.growS = slider("grow", "Widen the mask so edges and shadows are replaced too", 0, 64, 4,
      () => this.grow, (v) => { this.grow = v; this.refresh(); });
    this.featherS = slider("feather", "Soft edge: the regenerated area fades into the kept footage over this width, " +
      "so there's no hard seam. It's rounded up to whole 16-pixel latent cells at the sampling size, so any " +
      "feather is at least one cell. The inside stays fully regenerated.", 0, 64, 4,
      () => this.feather, (v) => { this.feather = v; });
    this.contextS = slider("context", "How much of the surroundings the crop keeps around the mask. More matches the " +
      "lighting and colour better; less gives the masked area more detail.", 1.25, 3, 0.25,
      () => this.context, (v) => { this.context = v; this.refresh(); }, "×", 2);
    this.refS = slider("reference strength", "How strongly the cited clip is shown to the model. 1 is the clip as it " +
      "is. Lower mixes it toward a blurred copy: its colours and placement stay, its detail goes, so the model has to " +
      "generate the masked area instead of copying the clip back. Try 0.5 when an edit comes back unchanged.",
      0.2, 1, 0.05, () => this.refStrength, (v) => { this.refStrength = v; }, "", 2);
    this.hideSel = el("select", { class: "mml-mkckpt",
      onchange: (e) => { this.hide = e.target.value; this.dirty = true; this.syncHide(); this.syncFoot(); } },
      [["off", "unchanged"], ["blur", "blurred"], ["invert", "inverted"], ["blur_invert", "blurred and inverted"]].map(([v, t]) =>
        el("option", { value: v, selected: v === this.hide }, t)));
    // the slider covers 1-64; typing goes further, for big clips
    const setBlur = (v) => {
      const n = Math.round(v);
      this.blur = n >= 1 ? Math.min(256, n) : this.blur;      // a cleared or zero box keeps the last value
      blurRange.value = blurNum.value = this.blur;
      this.dirty = true; this.syncFoot();
    };
    const blurRange = el("input", { type: "range", min: 1, max: 64, step: 1, value: this.blur,
      oninput: (e) => setBlur(+e.target.value) });
    const blurNum = el("input", { type: "number", class: "mml-tmnum", min: 1, max: 256, step: 1, value: this.blur,
      onchange: (e) => setBlur(+e.target.value), onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); } });
    this.blurS = { range: blurRange, num: blurNum, el: el("label", { class: "mml-mklbl", title: "How much the masked " +
      "area is blurred: the Gaussian radius, in pixels of the clip at the size it's sent, so a smaller size " +
      "setting makes the same number blur more. A few pixels soften what makes someone " +
      "recognisable while eyes, mouth and expression still read; 20 or more leaves only the silhouette and movement." },
      "blur", blurRange, blurNum, "px") };
    this.invertIn = el("input", { type: "checkbox", checked: this.invert,
      onchange: (e) => { this.invert = e.target.checked; this.dirty = true; this.syncCrop(); this.refresh(); } });
    this.cropIn = el("input", { type: "checkbox", checked: this.cropOn,
      onchange: (e) => { this.cropOn = e.target.checked; this.dirty = true; this.syncCrop(); this.refresh(); } });
    this.cropNote = el("span", { class: "mml-mkdim" });
    this.costEl = el("span", { class: "mml-mkdim", title: "The clip is also sent as a <Video N> reference for " +
      "the prompt to cite (“The target video is an edited version of <Video 1>”); this is what that costs. " +
      "With crop to mask, only the cropped area is sent." });
    this.status = el("div", { class: "mml-mkstatus" });
    this.unsaved = el("span", { class: "mml-mkunsaved" }, "● unsaved changes");
    this.useBtn = el("button", { class: "mml-btn mml-sm primary",
      title: "Combine the layers into the clip's mask and save it, with these settings and the trim and crop set " +
        "here. The editor stays open.", onclick: () => this.use() }, "Use this mask");
    this.clearBtn = armTwice(el("button", { class: "mml-btn mml-sm mml-danger",
      title: "Remove the saved mask from the clip (click twice). The layers stay here." }, "Clear mask"),
      "Click again to clear", () => this.clear());
    this.overBtn = armTwice(el("button", { class: "mml-btn mml-sm",
      title: "Remove every layer and put the settings back to their defaults (click twice)" }, "↺ Start over"),
      "Click again to start over", () => this.startOver());
    this.bottom = el("div", { class: "mml-mkui" },
      el("div", { class: "mml-tmfoot" },
        el("span", { class: "mml-lyrcap" }, "Mask settings"),
        el("span", { class: "mml-mkhint" }, "for the combined mask")),
      el("div", { class: "mml-tmfoot" }, this.growS.el, this.featherS.el,
        el("label", { class: "mml-mklbl", title: "Keep what's masked and regenerate everything else — the same " +
          "person in a new background. Grow then protects a margin around them." }, this.invertIn, "invert"),
        el("label", { class: "mml-mklbl", title: "Sample only the area around the mask, enlarged, for far more " +
          "detail in small edits; Edit Composite pastes it back. The box is fixed for the whole clip, so it holds " +
          "everywhere the masked area goes; it's off when that box would cover most of the frame." },
          this.cropIn, "crop to mask"),
        this.contextS.el, this.cropNote),
      el("div", { class: "mml-tmfoot" },
        this.host.item.has_audio ? el("label", { class: "mml-mklbl", title: "Off: the soundtrack is generated fresh" },
          this.audioIn = el("input", { type: "checkbox", checked: this.keepAudio,
            onchange: (e) => { this.keepAudio = e.target.checked; this.dirty = true; this.syncFoot(); } }),
          "keep the original sound") : null,
        this.refS.el),
      el("div", { class: "mml-tmfoot" },
        el("label", { class: "mml-mklbl", style: { whiteSpace: "nowrap" }, title: "EXPERIMENTAL: What the model sees " +
          "inside the mask in the clip it's shown as a reference. Blurred or inverted, the original person is less " +
          "likely to creep back into the edit: blurred keeps their colours and movement, and the blur slider sets how " +
          "much detail goes; inverted keeps their shape, movement and expressions as a photographic negative; " +
          "blurred and inverted does both, so even less of the original gets through. " +
          "Everything outside the mask stays as it is. Worth trying when replacing a whole person." },
          "Masked area in the reference:", this.hideSel),
        this.blurS.el),
      el("div", { class: "mml-tmfoot" }, this.costEl),
      this.status,
      el("div", { class: "mml-tmfoot act" },
        this.clearBtn, this.overBtn,
        el("span", { class: "mml-tmspace" }),
        this.unsaved, this.useBtn,
        el("button", { class: "mml-btn mml-sm", title: "Close the editor", onclick: () => h.tryClose() }, "Close")),
      el("div", { class: "mml-mkhelp" },
        "The clip becomes the footage being edited: only the masked area is regenerated. Describe the finished " +
        "clip in your prompt, including what the masked area becomes. When removing something, describe what's " +
        "there instead and don't name what you removed."),
      el("div", { class: "mml-mkhelp" }, "Clicks and drags on the video work on the selected layer · Ctrl+Z undo " +
        "· Del deletes the key at the playhead · Enter closes a polygon, Esc cancels it"));
    this.syncCrop();
    this.renderAll();
  }

  /* ---- the layers ---------------------------------------------------- */

  selected() { return this.layers.find((l) => l.id === this.sel) || null; }

  now() { return this.host.media?.currentTime || 0; }

  pushUndo() {
    this.undos.push(JSON.stringify({ layers: this.layers, sel: this.sel }));
    if (this.undos.length > 60) this.undos.shift();
  }

  undo() {
    const last = this.undos.pop();
    if (!last) { this.say("Nothing to undo."); return; }
    const s = JSON.parse(last);
    this.layers = s.layers; this.sel = s.sel; this.drawing = null;
    this.dirty = true;
    this.renderAll(); this.redraw();
    this.say("Undone.");
  }

  /** A change to the layers: undoable, unsaved until Use this mask. */
  change(fn) {
    this.pushUndo();
    fn();
    this.dirty = true;
    this.renderAll();
    this.redraw();
  }

  select(id) {
    this.sel = id; this.drawing = null;
    this.renderAll(); this.drawDecor();
  }

  /** An empty layer of `kind`, numbered after the others of its kind. */
  newLayer(kind) {
    const n = this.layers.filter((l) => l.kind === kind).length;
    const layer = { id: layerId(), kind, name: LAYER_KIND[kind].name + (n ? ` ${n + 1}` : ""), mode: "add", visible: true };
    if (kind === "auto") Object.assign(layer, { text: "", marks: [], runMode: "replace", everyFrame: false });
    else if (kind === "brush") layer.strokes = [];
    else Object.assign(layer, { keys: [], motion: "smooth" });
    return layer;
  }

  addLayer(kind) {
    const layer = this.newLayer(kind);
    this.hideMenus();
    this.change(() => { this.layers.push(layer); this.sel = layer.id; this.drawing = null; });
    this.say({
      auto: "Left-click what you want masked, type what it is, then Run Auto.",
      ellipse: "Drag on the video to draw the ellipse.", rect: "Drag on the video to draw the rectangle.",
      poly: "Click points on the video; click the first point (or press Enter) to close the polygon.",
      brush: "Paint on the video.",
    }[kind]);
  }

  hideMenus() { this.addMenu.hidden = true; this.rowMenu.hidden = true; }

  openRowMenu(layer, btn) {
    this.addMenu.hidden = true;
    const item = (label, fn) => el("button", { class: "mml-lyrmenuitem",
      onclick: (e) => { e.stopPropagation(); this.hideMenus(); fn(); } }, el("span", {}, label));
    setKids(this.rowMenu, [
      item("Rename", () => { this.select(layer.id); this.nameInput?.focus(); this.nameInput?.select(); }),
      item("Duplicate", () => this.change(() => {
        const copy = { ...clone(layer), id: layerId(), name: `${layer.name} copy` };
        this.layers.splice(this.layers.indexOf(layer) + 1, 0, copy);
        this.sel = copy.id;
      })),
      item("Delete", () => this.change(() => {
        const i = this.layers.indexOf(layer);
        this.layers.splice(i, 1);
        if (!this.layers.length) this.layers.push(this.newLayer("auto"));
        this.sel = (this.layers[i] || this.layers[i - 1]).id;
      })),
    ]);
    const card = this.layerList.parentElement.getBoundingClientRect(), r = btn.getBoundingClientRect();
    this.rowMenu.style.top = `${r.bottom - card.top + 2}px`;
    this.rowMenu.hidden = false;
  }

  /** Drag a row by its grip to reorder. */
  reorderStart(e, layer) {
    e.preventDefault(); e.stopPropagation();
    const shown = [...this.layers].reverse();       // the list's order, top first
    const from = shown.indexOf(layer);
    let to = from;
    const rows = [...this.layerList.children];
    const move = (ev) => {
      to = rows.findIndex((r) => ev.clientY < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2);
      if (to < 0) to = rows.length;
      rows.forEach((r, i) => { r.classList.toggle("drop", i === to); r.classList.toggle("dropafter", to === rows.length && i === rows.length - 1); });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      rows.forEach((r) => r.classList.remove("drop", "dropafter"));
      const at = to > from ? to - 1 : to;
      if (at !== from) this.change(() => { shown.splice(from, 1); shown.splice(at, 0, layer); this.layers = shown.reverse(); });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  subText(layer) {
    const k = LAYER_KIND[layer.kind].label;
    if (layer.kind === "auto") {
      const dots = (layer.marks || []).filter((m) => m.positive.length).length;
      if (layer.result_info) return `${k} · found on ${layer.result_info.hit} of ${layer.result_info.frames}` +
        (layer.stale ? " · run again" : "");
      return `${k} · ` + (dots ? `dots on ${dots} frame${dots === 1 ? "" : "s"} · not run yet` : "no dots yet");
    }
    if (layer.kind === "brush") {
      const s = layer.strokes || [];
      const frames = new Set(s.map((q) => Math.round(q.time * TRIM_FPS))).size;
      return s.length ? `${k} · ${s.length} stroke${s.length === 1 ? "" : "s"} on ${frames} frame${frames === 1 ? "" : "s"}`
        : `${k} · no strokes yet`;
    }
    const keys = sortedKeys(layer);
    if (!keys.length) return `${k} · draw it on the video`;
    const hidden = keys.filter((q) => q.off).length;
    return `${k} · ` + (layer.kind === "poly" ? `${keys[0].pts.length} points · ` : "") +
      `${keys.length} key${keys.length === 1 ? "" : "s"}` + (hidden ? ` · ${hidden} hidden` : "") +
      ` · ${layer.motion || "smooth"}`;
  }

  renderAll() {
    this.renderLayers();
    this.renderPanel();
    this.renderLane();
    this.syncFoot();
  }

  renderLayers() {
    setKids(this.layerList, [...this.layers].reverse().map((layer) => {
      const k = LAYER_KIND[layer.kind], on = layer.id === this.sel, shown = layer.visible !== false;
      const more = el("button", { class: "mml-lyrmore", title: "Rename, duplicate or delete",
        onclick: (e) => { e.stopPropagation(); this.openRowMenu(layer, more); } }, "⋯");
      const row = el("div", { class: "mml-lyrrow" + (on ? " sel" : "") + (shown ? "" : " off"),
        onmouseenter: () => { this.hover = layer.id; row.classList.add("hov"); this.drawDecor(); },
        onmouseleave: () => { if (this.hover === layer.id) this.hover = null; row.classList.remove("hov"); this.drawDecor(); } },
        el("button", { class: "mml-lyreye", title: shown ? "Leave this layer out of the mask" : "Put this layer back in the mask",
          onclick: (e) => { e.stopPropagation(); this.change(() => { layer.visible = !shown; }); } },
          shown ? "◉" : "○"),
        el("span", { class: "mml-lyrbadge", style: { color: k.color } }, k.badge),
        el("button", { class: "mml-lyrname", onclick: () => this.select(layer.id),
          ondblclick: () => { this.nameInput?.focus(); this.nameInput?.select(); } },
          el("b", {}, layer.name), el("i", {}, this.subText(layer))),
        el("span", { class: "mml-seg mml-addcut" },
          el("button", { class: "add" + (layer.mode !== "cut" ? " on" : ""), title: "Paint this layer into the mask",
            onclick: (e) => { e.stopPropagation(); if (layer.mode === "cut") this.change(() => { layer.mode = "add"; }); } }, "Add"),
          el("button", { class: "cut" + (layer.mode === "cut" ? " on" : ""), title: "Take this layer's area out of the layers below it",
            onclick: (e) => { e.stopPropagation(); if (layer.mode !== "cut") this.change(() => { layer.mode = "cut"; }); } }, "Cut")),
        el("span", { class: "mml-lyrgrip", title: "Drag to reorder", onpointerdown: (e) => this.reorderStart(e, layer) }, "⠇"),
        more);
      if (this.hover === layer.id) row.classList.add("hov");
      return row;
    }));
  }

  renderPanel() {
    const layer = this.selected();
    this.keyChips = []; this.hereSeg = null; this.rotInput = null;
    const k = LAYER_KIND[layer.kind];
    this.nameInput = el("input", { type: "text", class: "mml-mktext mml-lyrnamein", value: layer.name, "aria-label": "Layer name",
      onchange: (e) => { const v = e.target.value.trim(); if (v && v !== layer.name) this.change(() => { layer.name = v; }); } });
    const head = el("div", { class: "mml-lyrhead" },
      el("span", { class: "mml-lyrbadge", style: { color: k.color } }, k.badge),
      this.nameInput,
      el("span", { class: "mml-mkdim" }, `${k.label} layer`),
      el("span", { class: "mml-tmspace" }),
      el("span", { class: "mml-seg mml-addcut" },
        el("button", { class: "add" + (layer.mode !== "cut" ? " on" : ""),
          onclick: () => { if (layer.mode === "cut") this.change(() => { layer.mode = "add"; }); } }, "Add"),
        el("button", { class: "cut" + (layer.mode === "cut" ? " on" : ""),
          onclick: () => { if (layer.mode !== "cut") this.change(() => { layer.mode = "cut"; }); } }, "Cut")));
    const body = layer.kind === "auto" ? this.autoPanel(layer) : layer.kind === "brush" ? this.brushPanel(layer)
      : this.shapePanel(layer);
    setKids(this.panel, [head, ...body]);
    this.syncHere();
  }

  autoPanel(layer) {
    const h = this.host;
    const text = el("input", { type: "text", class: "mml-mktext", value: layer.text || "",
      placeholder: "what it is, e.g. phone, the man, his jacket", "aria-label": "What it is",
      oninput: (e) => { layer.text = e.target.value; if (layer.result) layer.stale = true; this.dirty = true; this.syncFoot(); },
      onchange: () => { this.renderLayers(); this.renderPanel(); },
      onkeydown: (e) => { if (e.key === "Enter") this.run(layer); } });
    const mode = layer.result ? (layer.runMode || "replace") : "replace";
    const modes = el("span", { class: "mml-mkmode" },
      [["replace", "Replace", "What SAM finds becomes this layer's mask"],
        ["add", "Add", "What SAM finds is added to this layer's mask — e.g. dot the shirt under the jacket"],
        ["subtract", "Cut", "What SAM finds is cut out of this layer's mask — e.g. dot a strap it shouldn't include"]]
        .map(([m, t, title]) => el("button", { class: "mml-btn mml-sm" + (mode === m ? " on" : ""),
          disabled: m !== "replace" && !layer.result,
          title: m !== "replace" && !layer.result ? "Needs a result first: run it once, then add to it or cut from it" : title,
          onclick: () => { layer.runMode = m; this.renderPanel(); } }, t)));
    const marks = [...(layer.marks || [])].sort((a, b) => a.time - b.time);
    const chips = this.keyChips = marks.map((m) => el("span", { class: "mml-mkmark" + (m.positive.length ? "" : " bad"),
      title: m.positive.length ? "Go to this frame" : "No green dot here: this frame is skipped until it has one",
      dataset: { t: String(m.time) }, onclick: () => h.seek(m.time) },
      `${m.time.toFixed(2)}s`, el("b", { class: "pos" }, ` ●${m.positive.length}`),
      m.negative.length ? el("b", { class: "neg" }, ` ●${m.negative.length}`) : null,
      el("span", { class: "mml-mkmarkx", title: "Remove this frame's dots",
        onclick: (e) => { e.stopPropagation(); this.change(() => { layer.marks = layer.marks.filter((q) => q !== m); if (layer.result) layer.stale = true; }); } },
        "✕")));
    const info = layer.result_info;
    return [
      el("div", { class: "mml-lyrhelp" }, "Left-click what you want masked (a green dot) on a frame where it's clearly " +
        "visible, and right-click anything that shouldn't be included (a red dot). Click a dot to remove it. You can " +
        "dot several frames: if the mask drifts later in the clip, add a dot there and run again. Only the kept range is masked."),
      el("div", { class: "mml-lyrrowctl" }, text,
        el("button", { class: "mml-btn mml-mkgo", disabled: !!this.running, onclick: () => this.run(layer) },
          this.running === layer.id ? "Masking…" : "▶ Run Auto")),
      el("div", { class: "mml-lyrrowctl" }, el("span", { class: "mml-mklbl" }, "When I run Auto:"), modes),
      el("div", { class: "mml-lyrrowctl" }, marks.length ? el("span", { class: "mml-mkdim" }, "dots on") : null, ...chips,
        el("span", { class: "mml-tmspace" }),
        el("button", { class: "mml-btn mml-sm", title: "Remove the dots on the frame shown",
          onclick: () => this.change(() => { layer.marks = (layer.marks || []).filter((q) => !sameFrame(q.time, frameTime(this.now()))); if (layer.result) layer.stale = true; }) }, "Clear this frame"),
        el("button", { class: "mml-btn mml-sm", title: "Remove the dots on every frame",
          onclick: () => this.change(() => { layer.marks = []; if (layer.result) layer.stale = true; }) }, "Clear all dots")),
      el("label", { class: "mml-mklbl", title: "With dots and a name: also look for the name on every frame, and use " +
          "what it finds wherever tracking lost the object, such as after a cut. It can pick up look-alikes, and it's slower." },
        el("input", { type: "checkbox", checked: !!layer.everyFrame,
          onchange: (e) => { layer.everyFrame = e.target.checked; if (layer.result) layer.stale = true; this.dirty = true; this.renderAll(); } }),
        "Look for it by name on every frame"),
      el("label", { class: "mml-mklbl", title: "The SAM 3.1 checkpoint Auto Mask runs with (from models/checkpoints)" },
        "Auto model", this.ckpt),
      el("div", { class: "mml-mkdim" }, info ? `Found on ${info.hit} of ${info.frames} frames (${info.how}).` : "Not run yet."),
      layer.stale && layer.result ? el("div", { class: "mml-lyrstale" }, "Dots or name changed since the last run: Run " +
        "Auto to update this layer. Until then it keeps its last result.") : null,
    ];
  }

  shapePanel(layer) {
    const keys = sortedKeys(layer);
    if (!keys.length) {
      return [el("div", { class: "mml-lyrhelp" }, layer.kind === "poly"
        ? "Click points on the video; click the first point, or press Enter, to close the polygon. Esc cancels."
        : `Drag on the video to draw the ${LAYER_KIND[layer.kind].name}; a click makes a round one.`)];
    }
    this.keyChips = keys.map((q) => {
      const chip = el("span", { class: "mml-kchip" + (q.off ? " off" : ""), title: "Go to this key",
        onclick: () => this.host.seek(q.t) },
        el("span", { class: "mml-kglyph" }, q.off ? "◇" : "◆"), ` ${q.t.toFixed(2)} s${q.off ? " hidden" : ""}`,
        el("span", { class: "mml-mkmarkx", title: "Delete this key",
          onclick: (e) => { e.stopPropagation(); this.deleteKey(layer, q.t); } }, "✕"));
      chip.dataset.t = String(q.t);
      return chip;
    });
    this.hereSeg = el("span", { class: "mml-seg mml-shownseg" },
      el("button", { class: "shown", onclick: () => this.setShown(layer, true) }, "Shown"),
      el("button", { class: "hidden", onclick: () => this.setShown(layer, false) }, "Hidden"));
    const motion = MOTION_HINT[layer.motion] ? layer.motion : "smooth";
    this.rotVal = el("span", { class: "mml-mkdim" });
    this.rotInput = el("input", { type: "range", min: -180, max: 180, step: 1, "aria-label": "Rotation",
      onpointerdown: () => this.pushUndo(), onkeydown: () => this.pushUndo(),
      oninput: (e) => {
        const v = +e.target.value;
        this.editShape(layer, frameTime(this.now()), (s) => ({ ...s, rot: v }));
        this.rotVal.textContent = `${v}°`;
        this.dirty = true; this.redraw(); this.renderLane(); this.syncFoot();
      },
      onchange: () => this.renderAll() });
    return [
      el("div", { class: "mml-lyrrowctl" }, el("span", { class: "mml-lyrcap" }, "Keyframes"), ...this.keyChips),
      el("div", { class: "mml-lyrrowctl" },
        el("button", { class: "mml-btn mml-sm", title: "Key the shape as it is on this frame", onclick: () => this.addKey(layer) },
          "◆ Key this frame"),
        el("button", { class: "mml-btn mml-sm", title: "Delete the key on this frame  (Del)",
          onclick: () => this.deleteKey(layer, frameTime(this.now())) }, "Delete this key"),
        el("span", { class: "mml-mkhint" }, "At this frame:"), this.hereSeg),
      el("label", { class: "mml-mklbl", title: "Off: moving, resizing or turning the shape changes it on every key instead" },
        el("input", { type: "checkbox", checked: this.autokey, onchange: (e) => { this.autokey = e.target.checked; } }),
        "Auto-key: moving, resizing or hiding it on a frame keys it"),
      el("div", { class: "mml-lyrhelp" }, "A Hidden key takes the shape out of the mask from that frame until the next " +
        "Shown key, for things that leave or come back, like across cuts. Hidden keys are orange on the timeline."),
      el("div", { class: "mml-lyrrowctl" }, el("span", { class: "mml-lyrcap" }, "Motion"),
        el("span", { class: "mml-seg mml-motionseg" }, ["smooth", "linear", "ease"].map((m) =>
          el("button", { class: m === motion ? "on" : "", onclick: () => { if (m !== motion) this.change(() => { layer.motion = m; }); } },
            m[0].toUpperCase() + m.slice(1)))),
        el("span", { class: "mml-mkhint" }, MOTION_HINT[motion])),
      el("div", { class: "mml-lyrrowctl" }, el("span", { class: "mml-lyrcap" }, "Rotation"), this.rotInput, this.rotVal,
        el("span", { class: "mml-mkhint" }, "or drag the round handle on the video")),
      layer.kind === "poly" ? el("div", { class: "mml-lyrhelp" }, `${keys[0].pts.length} points. Drag one to move it; ` +
        "click an edge to add one; right-click one to remove it.") : null,
    ];
  }

  brushPanel(layer) {
    const strokes = layer.strokes || [];
    const frames = new Set(strokes.map((q) => Math.round(q.time * TRIM_FPS))).size;
    const size = el("span", { class: "mml-mkdim" }, `${this.brush.size}%`);
    return [
      el("div", { class: "mml-lyrrowctl" },
        el("span", { class: "mml-seg mml-motionseg" },
          el("button", { class: this.brush.erase ? "" : "on", onclick: () => { this.brush.erase = false; this.renderPanel(); } }, "Paint"),
          el("button", { class: this.brush.erase ? "on" : "", onclick: () => { this.brush.erase = true; this.renderPanel(); } }, "Erase")),
        el("label", { class: "mml-mklbl", title: "Brush radius, as a share of the frame height" }, "size",
          el("input", { type: "range", min: 1, max: 20, step: 1, value: this.brush.size,
            oninput: (e) => { this.brush.size = +e.target.value; size.textContent = `${this.brush.size}%`; this.drawDecor(); } }),
          size)),
      el("div", { class: "mml-lyrrowctl" },
        el("label", { class: "mml-mklbl", title: "Which frames a new stroke paints" }, "strokes reach",
          el("select", { class: "mml-mkckpt", onchange: (e) => { this.brush.reach = e.target.value; } },
            [["frame", "this frame"], ["forward", "from here to the end"], ["all", "the whole clip"]]
              .map(([v, t]) => el("option", { value: v, selected: this.brush.reach === v }, t))))),
      el("div", { class: "mml-lyrrowctl" },
        el("span", { class: "mml-mkdim" }, strokes.length ? `${strokes.length} stroke${strokes.length === 1 ? "" : "s"} on ` +
          `${frames} frame${frames === 1 ? "" : "s"}` : "no strokes yet"),
        el("span", { class: "mml-tmspace" }),
        el("button", { class: "mml-btn mml-sm", title: "Remove the strokes drawn on the frame shown",
          onclick: () => {
            const f = Math.round(this.now() * TRIM_FPS), here = (q) => Math.round(q.time * TRIM_FPS) === f;
            if (layer.strokes.some(here)) this.change(() => { layer.strokes = layer.strokes.filter((q) => !here(q)); });
          } }, "Discard strokes on this frame")),
      el("div", { class: "mml-lyrhelp" }, "Paint and Erase change only this layer. Its Add or Cut decides what the " +
        "painted area does to the mask."),
    ];
  }

  /** The bits of the panel that follow the playhead, without rebuilding it
   *  (a rebuild would take the focus out of a field being typed in). */
  syncHere() {
    const layer = this.selected(), t = frameTime(this.now());
    for (const chip of this.keyChips || []) chip.classList.toggle("here", sameFrame(+chip.dataset.t, t));
    if (!isShape(layer)) return;
    const s = shapeAt(layer, t, true);
    if (this.hereSeg && s) {
      this.hereSeg.querySelector(".shown").classList.toggle("on", !s.off);
      this.hereSeg.querySelector(".hidden").classList.toggle("on", !!s.off);
    }
    if (this.rotInput && s && document.activeElement !== this.rotInput) {
      this.rotInput.value = String(Math.round(s.rot));
      this.rotVal.textContent = `${Math.round(s.rot)}°`;
    }
  }

  /** Marks for the selected layer under the timeline: keys, dot frames or
   *  stroke frames. Click one to go there. */
  renderLane() {
    const h = this.host, layer = this.selected();
    const t = frameTime(this.now());
    let marks = [];
    if (isShape(layer)) {
      marks = sortedKeys(layer).map((q) => ({ t: q.t, glyph: q.off ? "◇" : "◆",
        cls: q.off ? "off" : "", title: `${q.t.toFixed(2)} s${q.off ? " — hidden from here" : ""}` }));
    } else if (layer.kind === "auto") {
      marks = (layer.marks || []).map((m) => ({ t: m.time, glyph: "●", cls: "dot", title: `dots at ${m.time.toFixed(2)} s` }));
    } else if (layer.kind === "brush") {
      const seen = new Set();
      for (const q of layer.strokes || []) {
        const f = Math.round(q.time * TRIM_FPS);
        if (!seen.has(f)) { seen.add(f); marks.push({ t: f / TRIM_FPS, glyph: "▮", cls: "stroke", title: `strokes at ${(f / TRIM_FPS).toFixed(2)} s` }); }
      }
    }
    setKids(this.lane, marks.filter((m) => h.pct(m.t) >= 0 && h.pct(m.t) <= 100).map((m) =>
      el("span", { class: `mml-lyrmark ${m.cls}` + (sameFrame(m.t, t) ? " here" : ""),
        style: { left: `${h.pct(m.t)}%` }, title: m.title, onclick: () => h.seek(m.t) }, m.glyph)));
  }

  onTime() {
    const f = Math.round(this.now() * TRIM_FPS);
    if (f === this.lastFrame) return;
    this.lastFrame = f;
    this.syncHere();
    this.renderLane();
    this.drawDecor();
  }

  playLoop() {
    const step = () => {
      if (this.closed || this.host.media.paused) return;
      this.onTime();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---- keys ---------------------------------------------------------- */

  /** Change a shape at time t with `edit(state) -> state`. With auto-key on,
   *  the key on that frame takes the result (added if there's none); off,
   *  every key takes the same change. */
  editShape(layer, t, edit) {
    if (this.autokey || !layer.keys.length) {
      const s = shapeAt(layer, t, true);
      let k = layer.keys.find((q) => sameFrame(q.t, t));
      if (!k) {
        k = { t: frameTime(t), off: !!s.off };
        layer.keys.push(k);
        layer.keys.sort((a, b) => a.t - b.t);
      }
      Object.assign(k, shapeGeo(layer.kind, edit(s)));
    } else {
      for (const k of layer.keys) Object.assign(k, shapeGeo(layer.kind, edit(k)));
    }
  }

  addKey(layer) {
    const t = frameTime(this.now());
    if (layer.keys.some((q) => sameFrame(q.t, t))) { this.say("This frame already has a key."); return; }
    this.change(() => {
      const s = shapeAt(layer, t, true);
      layer.keys.push({ t, off: !!s.off, ...shapeGeo(layer.kind, s) });
      layer.keys.sort((a, b) => a.t - b.t);
    });
  }

  deleteKey(layer, t) {
    const hit = layer.keys.filter((q) => sameFrame(q.t, t));
    if (!hit.length) { this.say("There's no key on this frame."); return; }
    if (layer.keys.length <= hit.length) { this.say("A shape needs at least one key; delete the layer instead.", true); return; }
    this.change(() => { layer.keys = layer.keys.filter((q) => !sameFrame(q.t, t)); });
  }

  /** Shown or Hidden from this frame: sets the key here, or adds one. */
  setShown(layer, shown) {
    const t = frameTime(this.now());
    this.change(() => {
      let k = layer.keys.find((q) => sameFrame(q.t, t));
      if (!k) {
        k = { t, ...shapeGeo(layer.kind, shapeAt(layer, t, true)) };
        layer.keys.push(k);
        layer.keys.sort((a, b) => a.t - b.t);
      }
      k.off = !shown;
    });
  }

  /* ---- pointer on the video ------------------------------------------ */

  /** The pointer as fractions of the source frame (mirror undone), with the
   *  frame's drawn size in CSS pixels; null outside the picture unless `free`
   *  (a drag can carry a shape past the edge). */
  pos(e, free = false) {
    const r = this.surface.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (!free && !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;     // NaN too: an unsized surface
    return { x: this.host.mirror ? 1 - x : x, y, W: r.width, H: r.height };
  }

  /** What's under the pointer on a keyed shape: its rotate knob, a resize
   *  handle, a polygon point or edge, or its inside. */
  hitShape(layer, p, t) {
    const s = shapeAt(layer, t, true);
    if (!s) return null;
    const px = p.x * p.W, py = p.y * p.H, f = shapeFrame(layer.kind, s, p.W, p.H), tol = 8;
    const near = (q) => Math.hypot(px - q[0], py - q[1]) <= tol;
    if (near(toPx(f, 0, -f.ry - 22))) return { kind: "rotate" };
    if (layer.kind === "poly") {
      const pts = shapeOutline("poly", s, p.W, p.H);
      const i = pts.findIndex(near);
      if (i >= 0) return { kind: "point", index: i };
      for (let j = 0; j < pts.length; j++) {
        const q = toSegment(pts[j], pts[(j + 1) % pts.length], px, py);
        if (q.d <= tol) return { kind: "edge", index: j, u: q.u };
      }
      return pointInPoly(pts, px, py) ? { kind: "move" } : null;
    }
    const handles = layer.kind === "rect"
      ? [[-f.rx, -f.ry, "xy"], [f.rx, -f.ry, "xy"], [f.rx, f.ry, "xy"], [-f.rx, f.ry, "xy"]]
      : [[0, -f.ry, "y"], [f.rx, 0, "x"], [0, f.ry, "y"], [-f.rx, 0, "x"]];
    for (const [lx, ly, axis] of handles) if (near(toPx(f, lx, ly))) return { kind: "resize", axis };
    const [lx, ly] = toLocal(f, px, py);
    const inside = layer.kind === "rect" ? Math.abs(lx) <= f.rx && Math.abs(ly) <= f.ry
      : f.rx > 0 && f.ry > 0 && (lx / f.rx) ** 2 + (ly / f.ry) ** 2 <= 1;
    return inside ? { kind: "move" } : null;
  }

  down(e) {
    if (e.button !== 0) return;
    this.hideMenus();
    const layer = this.selected(), p = this.pos(e), h = this.host;
    if (!p) return;
    if (!h.media.paused) { h.media.pause(); h.playBtn.textContent = "▶"; }
    const t = frameTime(this.now());
    const grab = () => { try { this.surface.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } };
    if (layer.kind === "auto") { this.dot(layer, p, t, "positive"); return; }
    if (layer.kind === "brush") {
      this.pushUndo();
      this.drag = { mode: "stroke", layer, stroke: { time: t, erase: this.brush.erase, r: this.brush.size / 100,
        reach: this.brush.reach, points: [{ x: +p.x.toFixed(4), y: +p.y.toFixed(4) }] } };
      grab(); this.drawDecor();
      return;
    }
    if (!sortedKeys(layer).length) {
      if (layer.kind === "poly") this.polyClick(layer, p, t);
      else { this.drag = { mode: "create", layer, p0: p, p1: p, t }; grab(); }
      return;
    }
    const hit = this.hitShape(layer, p, t);
    if (!hit) return;
    // on a polygon's edge, a click adds a point and a drag moves the shape
    const edge = hit.kind === "edge" ? hit : null;
    this.pushUndo();
    this.drag = { mode: "shape", layer, hit: edge ? { kind: "move" } : hit, edge, p0: p, t,
      keys0: clone(layer.keys), s0: shapeAt(layer, t, true) };
    grab();
  }

  move(e) {
    const d = this.drag, p = this.pos(e, !!d);
    this.pointer = p;
    if (!d) { this.cursor(p); if (this.selected().kind === "brush" || this.drawing) this.drawDecor(); return; }
    if (d.mode === "stroke") d.stroke.points.push({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) });
    else if (d.mode === "create") d.p1 = p;
    else { d.moved = true; this.dragShape(d, p); }
    this.drawDecor();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.mode === "shape" && !d.moved) {         // a click, not a drag
      this.undos.pop();
      if (d.edge) this.addPoint(d.layer, d.edge);
      return;
    }
    if (d.mode === "stroke") d.layer.strokes = [...(d.layer.strokes || []), d.stroke];
    else if (d.mode === "create") {
      const { p0, p1 } = d;
      let w = Math.abs(p1.x - p0.x), hh = Math.abs(p1.y - p0.y), x = (p0.x + p1.x) / 2, y = (p0.y + p1.y) / 2;
      if (w * p0.W < 6 && hh * p0.H < 6) { w = 0.15; hh = 0.15 * p0.W / p0.H; x = p0.x; y = p0.y; }   // a click: a round one
      this.pushUndo();
      d.layer.keys = [{ t: d.t, off: false, ...shapeGeo(d.layer.kind, { x, y, w, h: hh, rot: 0 }) }];
      this.say(ANIMATE_HINT);
    }
    this.dirty = true;
    this.renderAll(); this.redraw();
  }

  /** Move, resize, turn or reshape from where the drag began, so repeated
   *  moves don't pile up. */
  dragShape(d, p) {
    const layer = d.layer, W = p.W, H = p.H;
    layer.keys = clone(d.keys0);
    const f0 = shapeFrame(layer.kind, d.s0, W, H);
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    let edit;
    if (d.hit.kind === "move") {
      edit = (s) => layer.kind === "poly" ? { ...s, pts: s.pts.map((q) => [q[0] + dx, q[1] + dy]) } : { ...s, x: s.x + dx, y: s.y + dy };
    } else if (d.hit.kind === "rotate") {
      const a0 = Math.atan2(d.p0.y * H - f0.cy, d.p0.x * W - f0.cx), a1 = Math.atan2(p.y * H - f0.cy, p.x * W - f0.cx);
      const da = (a1 - a0) * 180 / Math.PI;
      edit = (s) => ({ ...s, rot: (s.rot || 0) + da });
    } else if (d.hit.kind === "resize") {
      const [lx, ly] = toLocal(f0, p.x * W, p.y * H);
      const sx = d.hit.axis !== "y" && f0.rx > 0 ? Math.max(Math.abs(lx), 2) / f0.rx : 1;
      const sy = d.hit.axis !== "x" && f0.ry > 0 ? Math.max(Math.abs(ly), 2) / f0.ry : 1;
      edit = (s) => ({ ...s, w: s.w * sx, h: s.h * sy });
    } else {
      const [lx, ly] = toLocal(f0, p.x * W, p.y * H), [lx0, ly0] = toLocal(f0, d.p0.x * W, d.p0.y * H);
      const ddx = (lx - lx0) / W, ddy = (ly - ly0) / H;      // in the key's own, unturned frame
      edit = (s) => ({ ...s, pts: s.pts.map((q, i) => (i === d.hit.index ? [q[0] + ddx, q[1] + ddy] : q)) });
    }
    this.editShape(layer, d.t, edit);
    this.redraw();
  }

  /** A point on edge `index` of every key, `u` of the way along it. */
  addPoint(layer, { index, u }) {
    this.change(() => layer.keys.forEach((k) => {
      const a = k.pts[index], b = k.pts[(index + 1) % k.pts.length];
      k.pts.splice(index + 1, 0, [+(a[0] + (b[0] - a[0]) * u).toFixed(5), +(a[1] + (b[1] - a[1]) * u).toFixed(5)]);
    }));
  }

  polyClick(layer, p, t) {
    if (!this.drawing || this.drawing.layer !== layer) this.drawing = { layer, pts: [], t };
    const d = this.drawing;
    if (d.pts.length >= 3 && Math.hypot((p.x - d.pts[0][0]) * p.W, (p.y - d.pts[0][1]) * p.H) < 10) { this.finishPoly(); return; }
    d.pts.push([p.x, p.y]);
    this.drawDecor();
  }

  finishPoly() {
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    if (d.pts.length < 3) { this.say("A polygon needs at least 3 points.", true); this.drawDecor(); return; }
    this.change(() => { d.layer.keys = [{ t: d.t, off: false, ...shapeGeo("poly", { pts: d.pts, rot: 0 }) }]; });
    this.say(ANIMATE_HINT);
  }

  rightClick(e) {
    const layer = this.selected(), p = this.pos(e);
    if (!p) return;
    const t = frameTime(this.now());
    if (layer.kind === "auto") { this.dot(layer, p, t, "negative"); return; }
    if (layer.kind === "poly" && sortedKeys(layer).length) {
      const hit = this.hitShape(layer, p, t);
      if (hit?.kind !== "point") return;
      if (sortedKeys(layer)[0].pts.length <= 3) { this.say("A polygon needs at least 3 points.", true); return; }
      this.change(() => layer.keys.forEach((k) => k.pts.splice(hit.index, 1)));
    }
  }

  /** A dot for an Auto Mask layer, or remove the one clicked. */
  dot(layer, p, t, kind) {
    const h = this.host, f = Math.round(t * TRIM_FPS);
    // whole frames, as a masking run counts them: t is snapped to one, the trim isn't
    if (f < Math.round(h.start * TRIM_FPS) || f > Math.round(h.end * TRIM_FPS)) {
      this.say("That frame is outside the kept range; move into it first.", true);
      return;
    }
    const m = (layer.marks || []).find((q) => sameFrame(q.time, t));
    for (const list of ["positive", "negative"]) {
      const i = (m?.[list] || []).findIndex((q) => Math.hypot((q.x - p.x) * p.W, (q.y - p.y) * p.H) < 8);
      if (i >= 0) {
        this.change(() => {
          m[list].splice(i, 1);
          if (!m.positive.length && !m.negative.length) layer.marks = layer.marks.filter((q) => q !== m);
          if (layer.result) layer.stale = true;
        });
        return;
      }
    }
    const c = h.crop, sx = h.mirror ? 1 - p.x : p.x;      // the crop is drawn on the picture as shown
    if (c && (sx < c.x || sx > c.x + c.w || p.y < c.y || p.y > c.y + c.h)) {
      this.say("That's outside the crop — only the cropped area is sent.", true);
      return;
    }
    this.change(() => {
      let mark = (layer.marks || []).find((q) => sameFrame(q.time, t));
      if (!mark) { mark = { time: t, positive: [], negative: [] }; layer.marks = [...(layer.marks || []), mark]; }
      mark[kind].push({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) });
      if (layer.result) layer.stale = true;
    });
  }

  cursor(p) {
    const layer = this.selected();
    let c = "crosshair";
    if (layer.kind === "brush") c = "none";
    else if (isShape(layer) && p && sortedKeys(layer).length) {
      const hit = this.hitShape(layer, p, frameTime(this.now()));
      c = !hit ? "default" : { move: "move", rotate: "grab", resize: "nwse-resize", point: "pointer", edge: "copy" }[hit.kind];
    }
    this.surface.style.cursor = c;
  }

  /* ---- drawing ------------------------------------------------------- */

  /** The layers at time t, white on transparent, for the mask overlay: shown
   *  layers from the bottom of the stack up, Add painting and Cut erasing. */
  paint(b, t, dx, dy, dw, dh) {
    const W = b.canvas.width, H = b.canvas.height;
    const tmp = this.tmp || (this.tmp = document.createElement("canvas"));
    if (tmp.width !== W || tmp.height !== H) { tmp.width = W; tmp.height = H; }
    const c = tmp.getContext("2d");
    for (const layer of this.layers) {
      if (layer.visible === false) continue;
      c.clearRect(0, 0, W, H);
      if (!this.paintLayer(c, layer, frameTime(t), dx, dy, dw, dh)) continue;
      b.globalCompositeOperation = layer.mode === "cut" ? "destination-out" : "source-over";
      b.drawImage(tmp, 0, 0);
    }
    b.globalCompositeOperation = "source-over";
  }

  paintLayer(c, layer, t, dx, dy, dw, dh) {
    c.fillStyle = c.strokeStyle = "#fff";
    c.globalCompositeOperation = "source-over";
    if (layer.kind === "auto") {
      const sp = layer.result_info?.sprite;
      if (!sp) return false;
      const img = spriteImage(sp.file);
      if (!img.complete || !img.naturalWidth) {
        img.addEventListener("load", () => this.redraw(), { once: true });
        return false;
      }
      const f = Math.round(t * TRIM_FPS) - (sp.start || 0), i = Math.floor(f / (sp.step || 1));
      if (f < 0 || i >= sp.count) return false;
      c.drawImage(img, (i % sp.cols) * sp.tw, Math.floor(i / sp.cols) * sp.th, sp.tw, sp.th, dx, dy, dw, dh);
      return true;
    }
    if (layer.kind === "brush") {
      const f = Math.round(t * TRIM_FPS);
      let drew = false;
      for (const s of layer.strokes || []) {
        if (!strokeReaches(s, f)) continue;
        c.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
        strokePath(c, s, dx, dy, dw, dh);
        drew = drew || !s.erase;
      }
      c.globalCompositeOperation = "source-over";
      return drew;
    }
    const s = shapeAt(layer, t);
    if (!s) return false;
    c.beginPath();
    shapeOutline(layer.kind, s, dw, dh).forEach((q, i) => (i ? c.lineTo : c.moveTo).call(c, dx + q[0], dy + q[1]));
    c.closePath();
    c.fill();
    return true;
  }

  redraw() {
    this.host.maskLayer?.redraw();
    this.drawDecor();
  }

  /** The selected layer's handles, dots or strokes, a hovered layer's
   *  outline, and whatever is being drawn, over the picture. */
  drawDecor() {
    const h = this.host, c = this.decor;
    if (c.hidden) return;
    const r = h.cropBox.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    c.style.transform = h.mirror ? "scaleX(-1)" : "";
    const g = c.getContext("2d");
    g.clearRect(0, 0, W, H);
    const t = frameTime(this.now()), f = Math.round(t * TRIM_FPS);
    const path = (pts) => { g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo : g.moveTo).call(g, q[0], q[1])); g.closePath(); };
    const handle = (q, size = 4) => { g.fillRect(q[0] - size * dpr, q[1] - size * dpr, 2 * size * dpr, 2 * size * dpr);
      g.strokeRect(q[0] - size * dpr, q[1] - size * dpr, 2 * size * dpr, 2 * size * dpr); };

    const hov = this.layers.find((l) => l.id === this.hover && l.id !== this.sel);
    if (hov) {
      if (isShape(hov)) {
        const s = shapeAt(hov, t, true);
        if (s) {
          g.setLineDash([5 * dpr, 4 * dpr]); g.lineWidth = 2 * dpr; g.strokeStyle = "rgba(255, 255, 255, 0.9)";
          path(shapeOutline(hov.kind, s, W, H)); g.stroke(); g.setLineDash([]);
        }
      } else {
        const tmp = this.tmpHover || (this.tmpHover = document.createElement("canvas"));
        tmp.width = W; tmp.height = H;
        if (this.paintLayer(tmp.getContext("2d"), hov, t, 0, 0, W, H)) {
          g.globalAlpha = 0.45; g.drawImage(tmp, 0, 0); g.globalAlpha = 1;
        }
      }
    }

    const layer = this.selected();
    if (layer.kind === "auto") {
      const m = (layer.marks || []).find((q) => sameFrame(q.time, t));
      for (const [list, color] of [["positive", "#3ec46d"], ["negative", "#e0484f"]]) {
        for (const q of m?.[list] || []) {
          g.beginPath(); g.arc(q.x * W, q.y * H, 6 * dpr, 0, 2 * Math.PI);
          g.fillStyle = color; g.fill(); g.lineWidth = 2 * dpr; g.strokeStyle = "#0d0f13"; g.stroke();
        }
      }
    } else if (isShape(layer)) {
      const s = shapeAt(layer, t, true);
      if (s) {
        const fr = shapeFrame(layer.kind, s, W, H);
        g.lineWidth = 2 * dpr; g.strokeStyle = s.off ? "#8b93a1" : "#ffb84d";
        g.setLineDash([6 * dpr, 5 * dpr]); path(shapeOutline(layer.kind, s, W, H)); g.stroke(); g.setLineDash([]);
        g.fillStyle = s.off ? "#8b93a1" : "#ffb84d"; g.strokeStyle = "#0d0f13"; g.lineWidth = 1 * dpr;
        const knob = toPx(fr, 0, -fr.ry - 22 * dpr);
        g.beginPath(); g.moveTo(...toPx(fr, 0, -fr.ry)); g.lineTo(...knob); g.strokeStyle = g.fillStyle; g.stroke();
        g.beginPath(); g.arc(knob[0], knob[1], 5 * dpr, 0, 2 * Math.PI); g.fillStyle = "#191c22"; g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = s.off ? "#8b93a1" : "#ffb84d"; g.stroke();
        g.fillStyle = s.off ? "#8b93a1" : "#ffb84d"; g.strokeStyle = "#0d0f13"; g.lineWidth = 1 * dpr;
        const local = layer.kind === "poly" ? null : layer.kind === "rect"
          ? [[-fr.rx, -fr.ry], [fr.rx, -fr.ry], [fr.rx, fr.ry], [-fr.rx, fr.ry]]
          : [[0, -fr.ry], [fr.rx, 0], [0, fr.ry], [-fr.rx, 0]];
        (local ? local.map((q) => toPx(fr, q[0], q[1])) : shapeOutline("poly", s, W, H)).forEach((q) => handle(q));
      }
    } else if (layer.kind === "brush") {
      for (const s of layer.strokes || []) {
        if (!strokeReaches(s, f)) continue;
        g.fillStyle = g.strokeStyle = s.erase ? "rgba(255, 90, 90, 0.55)" : "rgba(90, 255, 160, 0.55)";
        strokePath(g, s, 0, 0, W, H);
      }
    }

    const d = this.drag;
    if (d?.mode === "stroke") {
      g.fillStyle = g.strokeStyle = d.stroke.erase ? "rgba(255, 90, 90, 0.7)" : "rgba(90, 255, 160, 0.7)";
      strokePath(g, d.stroke, 0, 0, W, H);
    } else if (d?.mode === "create") {
      const x0 = Math.min(d.p0.x, d.p1.x) * W, y0 = Math.min(d.p0.y, d.p1.y) * H;
      const w = Math.abs(d.p1.x - d.p0.x) * W, hh = Math.abs(d.p1.y - d.p0.y) * H;
      g.setLineDash([6 * dpr, 5 * dpr]); g.lineWidth = 2 * dpr; g.strokeStyle = "#ffb84d";
      g.beginPath();
      if (d.layer.kind === "ellipse") g.ellipse(x0 + w / 2, y0 + hh / 2, w / 2, hh / 2, 0, 0, 2 * Math.PI);
      else g.rect(x0, y0, w, hh);
      g.stroke(); g.setLineDash([]);
    }
    if (this.drawing) {
      const pts = this.drawing.pts.map((q) => [q[0] * W, q[1] * H]);
      if (this.pointer) pts.push([this.pointer.x * W, this.pointer.y * H]);
      g.lineWidth = 2 * dpr; g.strokeStyle = "#ffaa00";
      g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo : g.moveTo).call(g, q[0], q[1])); g.stroke();
      g.fillStyle = "#ffaa00"; g.strokeStyle = "#0d0f13";
      this.drawing.pts.forEach((q, i) => handle([q[0] * W, q[1] * H], i === 0 && this.drawing.pts.length >= 3 ? 6 : 4));
    }
    if (layer.kind === "brush" && this.pointer && !d) {
      g.lineWidth = 1.5 * dpr; g.strokeStyle = this.brush.erase ? "#ff9a9a" : "#9affc8";
      g.beginPath(); g.arc(this.pointer.x * W, this.pointer.y * H, this.brush.size / 100 * H, 0, 2 * Math.PI); g.stroke();
    }
  }

  /* ---- the mask overlay's look and crop to mask ---------------------- */

  /** The frame the edit is built from, in pixels: the loader's crop and size cap. */
  frameSize() {
    const h = this.host, it = h.item;
    let w = (it.width || 0) * (h.crop?.w ?? 1), hh = (it.height || 0) * (h.crop?.h ?? 1);
    if (h.resize && Math.max(w, hh) > h.resize) { const k = h.resize / Math.max(w, hh); w *= k; hh *= k; }
    return { W: w, H: hh };
  }

  look() {
    const { W, H } = this.frameSize();
    const c = this.host.crop || { w: 1, h: 1 };        // the box and the overlay are on the uncropped frame
    const budget = sampleBudget();
    const box = this.cropOn && !this.invert ? this.cropBox : null;
    let scale = Math.min(1, Math.sqrt(budget / Math.max(1, W * H)));
    if (box) scale = Math.min(4, Math.sqrt(budget / Math.max(1, box.w / c.w * W * box.h / c.h * H)));
    return { grow: this.grow, frameW: W / c.w, invert: this.invert, cropBox: box,
      block: this.host.showRegen ? 16 / scale : 0 };
  }

  refresh() {
    this.updateCropBox();
    this.host.refreshMaskLayer();
  }

  /** Where crop to mask will sample, from the saved (combined) mask: the mask
   *  over the kept range, grown, padded by `context`, no longer than 2.5:1,
   *  inside the frame. The Text Encode works it out the same way. */
  async updateCropBox() {
    const sprite = this.composed?.sprite;
    const h = this.host;
    if (!this.cropOn || this.invert || !sprite) {
      this.cropBox = null;
      this.cropNote.textContent = this.cropOn && !this.invert && !sprite ? "the box shows once the mask is saved" : "";
      this.showCost();
      return;
    }
    const b = await spriteBounds(sprite, Math.round(h.start * TRIM_FPS), Math.round(h.end * TRIM_FPS) + 1);
    const { W, H } = this.frameSize();
    if (!b || !W) { this.cropBox = null; this.showCost(); return; }
    // the loader's crop, on the source frame (its rect is drawn on the mirrored view)
    const c = h.crop ? { x: h.mirror ? 1 - h.crop.x - h.crop.w : h.crop.x, y: h.crop.y, w: h.crop.w, h: h.crop.h }
      : { x: 0, y: 0, w: 1, h: 1 };
    const gx = this.grow / W * c.w, gy = this.grow / H * c.h;
    const x0 = Math.max(c.x, b.x - gx), y0 = Math.max(c.y, b.y - gy);
    const x1 = Math.min(c.x + c.w, b.x + b.w + gx), y1 = Math.min(c.y + c.h, b.y + b.h + gy);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let bw = (x1 - x0) * this.context * W / c.w, bh = (y1 - y0) * this.context * H / c.h;   // frame pixels
    if (bw / bh > 2.5) bh = bw / 2.5; else if (bh / bw > 2.5) bw = bh / 2.5;
    bw = Math.min(W, Math.max(64, bw)); bh = Math.min(H, Math.max(64, bh));
    const nw = bw / W * c.w, nh = bh / H * c.h;
    const nx = Math.min(c.x + c.w - nw, Math.max(c.x, cx - nw / 2)), ny = Math.min(c.y + c.h - nh, Math.max(c.y, cy - nh / 2));
    if (bw * bh > 0.6 * W * H) {
      this.cropBox = null;
      const span = Math.round((x1 - x0) * (y1 - y0) / (c.w * c.h) * 100);
      this.cropNote.textContent = `no crop: over the clip the mask moves through ${span}% of the frame, ` +
        `${Math.round(bw * bh / (W * H) * 100)}% with context`;
    } else {
      this.cropBox = { x: nx, y: ny, w: nw, h: nh };
      const k = Math.min(4, Math.sqrt(sampleBudget() / (bw * bh)));
      this.cropNote.textContent = `≈${k.toFixed(1)}× detail` + (this.dirty ? " (from the saved mask)" : "");
    }
    this.showCost();
    this.host.refreshMaskLayer();
  }

  syncCrop() {
    this.cropIn.disabled = this.invert;
    this.contextS.el.hidden = !this.cropOn || this.invert;
    if (this.invert) this.cropNote.textContent = this.cropOn ? "off while inverted" : "";
    this.updateCropBox();
  }

  /** What citing the clip costs at the editor's current trim and frame. */
  showCost() {
    const h = this.host;
    const n = Math.round(refTokenEstimate(h.item, { start: h.start, end: h.end, crop: h.crop, resize: h.resize,
      box: this.cropOn && !this.invert ? this.cropBox : null }));
    this.costEl.textContent = n ? `cited as a reference: ≈${n.toLocaleString()} tokens` : "";
    this.costEl.classList.toggle("err", n > REF_TOKEN_WARN);
  }

  /** The blur slider only means something while the masked area is blurred. */
  syncHide() {
    this.blurS.el.style.display = this.hide === "blur" || this.hide === "blur_invert" ? "" : "none";
  }

  syncFoot() {
    const content = this.layers.some((l) => l.visible !== false && layerDraws(l));
    this.unsaved.hidden = !this.dirty;
    this.useBtn.disabled = this.saving || !content;
    this.useBtn.title = content ? "Combine the layers into the clip's mask and save it, with these settings and the " +
      "trim and crop set here. The editor stays open." : "Nothing to save yet: add a layer, then draw it or run it";
    this.clearBtn.hidden = !this.host.item.mask;
    this.showCost();
  }

  show(on) {
    this.decor.hidden = this.surface.hidden = this.lane.hidden = !on;
    if (on) { this.updateCropBox(); this.renderAll(); this.drawDecor(); }
  }

  say(msg, err = false) {
    setKids(this.status, msg || "");
    this.status.className = "mml-mkstatus" + (err ? " err" : "");
  }

  /** What closing now would lose, for the editor's close guard, or "". A
   *  save under way finishes on its own. */
  closeWarning() {
    return this.dirty && !this.saving ? "Unsaved mask changes: Use this mask keeps them" : "";
  }

  key(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") { this.undo(); return true; }
    if (e.key === "Enter" && this.drawing) { this.finishPoly(); return true; }
    if (e.key === "Escape" && (this.drawing || !this.addMenu.hidden || !this.rowMenu.hidden)) {
      this.drawing = null; this.hideMenus(); this.drawDecor();
      return true;
    }
    const layer = this.selected();
    if ((e.key === "Delete" || e.key === "Backspace") && isShape(layer)) {
      const t = frameTime(this.now());
      if (layer.keys.some((q) => sameFrame(q.t, t))) { this.deleteKey(layer, t); return true; }
    }
    return false;
  }

  /* ---- saving -------------------------------------------------------- */

  async use() {
    const h = this.host;
    this.saving = true; this.syncFoot();
    this.say("Combining the layers…");
    // Only the kept range is combined, as a masking run only covers it.
    const start = +h.start.toFixed(3), end = h.end >= h.dur - 0.05 ? 0 : +h.end.toFixed(3);
    try {
      const r = await postApi("/minimax_h3/mask_compose", { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clip: h.item.file, layers: this.layers, start, end }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const info = d.mask;
      this.composed = { file: info.file, ...info };
      this.dirty = false;
      await this.updateCropBox();
      const it = h.panel.live?.(h.item) || h.item;
      // One clip is edited at a time; any other goes back to being a reference.
      for (const other of h.panel.items) if (other !== it && other.edit) MASK_KEYS.forEach((k) => delete other[k]);
      Object.assign(it, { edit: true, mask: info.file, mask_layers: clone(this.layers),
        mask_info: { hit: info.hit, frames: info.frames, how: info.how, sprite: info.sprite },
        mask_range: { start: +start.toFixed(2), end: +(end || h.dur).toFixed(2) },
        mask_grow: this.grow, mask_feather: this.feather, mask_invert: this.invert,
        mask_crop: this.cropOn && !this.invert, mask_context: this.context,
        mask_box: this.cropOn && !this.invert ? this.cropBox : null, mask_ref_strength: this.refStrength,
        mask_hide: this.hide, mask_blur: this.blur });
      if (it.has_audio) it.keep_audio = this.keepAudio;
      h.panel.say(`${it.name} is the clip being edited. Describe the finished clip in your prompt.`);
      h.apply(true);
      h.refreshMaskLayer();
      h.panel.maskCheck();
      this.say(`Saved on the clip: masked on ${info.hit} of ${info.frames} frames. Keep adjusting, or close the editor.`);
    } catch (err) {
      this.say(`Couldn't save the mask: ${err.message}`, true);
    } finally {
      this.saving = false;
      this.syncFoot();
    }
  }

  clear() {
    const h = this.host;
    clearMaskOn(h.panel, h.item, false);
    h.apply(true);
    this.composed = null; this.cropBox = null;
    this.dirty = this.layers.length > 0;
    this.renderAll(); this.redraw();
    h.refreshMaskLayer();
    this.say("Mask cleared from the clip. The layers are still here: Use this mask saves them again, and Start over " +
      "clears them. The Media Loader's message line has Undo.");
  }

  startOver() {
    this.pushUndo();
    this.layers = [];
    this.layers.push(this.newLayer("auto"));
    this.sel = this.layers[0].id; this.drawing = null;
    this.grow = 16; this.feather = 12; this.invert = false; this.cropOn = false; this.context = 1.75;
    this.keepAudio = true; this.refStrength = 1; this.hide = "off"; this.hideSel.value = "off";
    this.blur = this.blurS.range.value = this.blurS.num.value = 24;
    this.syncHide();
    for (const [s, v] of [[this.growS, 16], [this.featherS, 12], [this.contextS, 1.75], [this.refS, 1]]) {
      s.input.value = v; s.val.textContent = `${v.toFixed(s.digits)}${s.unit}`;
    }
    this.invertIn.checked = false; this.cropIn.checked = false;
    if (this.audioIn) this.audioIn.checked = true;
    this.dirty = true;
    this.syncCrop(); this.renderAll(); this.redraw();
    this.say("Started over. Use this mask saves the new mask; closing keeps the one already on the clip. Ctrl+Z brings the layers back.");
  }

  /* ---- Auto Mask ----------------------------------------------------- */

  async loadCheckpoints() {
    const list = await samCheckpoints();
    let saved = "";
    try { saved = localStorage.getItem(SAM_KEY) || ""; } catch (e) {}
    const sam = list.filter((c) => /sam3/i.test(c));
    setKids(this.ckpt, list.map((c) => el("option", { value: c }, c)));
    this.ckpt.value = list.includes(saved) ? saved : (sam[0] || "");
    if (!sam.length) {
      setKids(this.status, el("span", {}, "No SAM 3.1 checkpoint found for Auto Mask. Put ",
        el("a", { href: SAM_LINK, target: "_blank", rel: "noopener" }, "sam3.1_multiplex_fp16.safetensors"),
        " in models/checkpoints, then reopen the editor. Nothing is downloaded for you."));
      this.status.className = "mml-mkstatus err";
    }
  }

  async run(layer) {
    if (this.running) return;
    const h = this.host;
    const text = (layer.text || "").trim();
    const frames = (layer.marks || []).filter((m) => m.positive.length);
    if (!frames.length && !text) { this.say("Click on what you want masked, or type what it is, first.", true); return; }
    if (!this.ckpt.value) { this.say("Choose the Auto model first.", true); return; }
    const points = frames.length ? JSON.stringify({ frames: frames.map((m) => ({ time: m.time,
      positive: m.positive, negative: m.negative })) }) : "";
    const end = h.end >= h.dur - 0.05 ? 0 : +h.end.toFixed(3);
    const mode = layer.result ? (layer.runMode || "replace") : "replace";
    const prompt = {
      1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: this.ckpt.value } },
      2: { class_type: MASK_NODE, inputs: { model: ["1", 0], clip: ["1", 1], video: h.item.file, text, points,
        start: +h.start.toFixed(3), end, threshold: 0.5, max_objects: 4, mode,
        base: mode === "replace" ? "" : layer.result, every_frame: !!layer.everyFrame } },
    };
    this.running = layer.id;
    this.renderPanel();
    const skipped = (layer.marks || []).length - frames.length;
    this.say("Masking… (in the queue; a running generation finishes first)" +
      (skipped ? ` — ${skipped} frame(s) with only red dots are skipped` : ""));
    try {
      const r = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: api.clientId }) });
      const d = await r.json();
      if (!r.ok || d.error) {
        const errs = Object.values(d.node_errors || {}).flatMap((n) => (n.errors || []).map((x) => x.details || x.message || ""));
        throw new Error((d.error?.message || d.error || `HTTP ${r.status}`) + (errs.length ? `: ${errs.join("; ")}` : ""));
      }
      const info = await this.wait(d.prompt_id);
      if (!info) return;                  // the editor was closed meanwhile
      // Undo swaps in copies of the layers, and the layer may be gone.
      const target = this.layers.find((l) => l.id === layer.id);
      if (!target) { this.say(`${layer.name} was deleted while Auto Mask ran; its result was dropped.`); return; }
      this.pushUndo();
      Object.assign(target, { result: info.file, stale: false,
        result_info: { hit: info.hit, frames: info.frames, how: info.how, sprite: info.sprite } });
      this.dirty = true;
      this.say(`${layer.name}: found on ${info.hit} of ${info.frames} frames (${info.how}). ` +
        (this.host.maskShown ? "Scrub or play to check it, then Use this mask."
          : "The overlay is off — turn on ◐ show mask at the top to see it, then Use this mask."));
    } catch (err) {
      this.say(`Auto Mask failed: ${err.message}`, true);
    } finally {
      this.running = null;
      this.renderAll();
      this.redraw();
    }
  }

  /** The job's mask info, or null if the editor closes first. The websocket's
   *  executed event carries it the moment the job ends; /history is asked
   *  every few seconds too, in case that message was missed. A history
   *  request that hangs or fails is retried, and only a long run of
   *  failures gives up, with the reason. */
  wait(pid) {
    return new Promise((resolve, reject) => {
      let done = false, asking = false, failures = 0;
      const finish = (err, info = null) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        for (const [k, f] of Object.entries(on)) api.removeEventListener(k, f);
        if (err) reject(err); else resolve(info);
      };
      const on = {
        executed: (e) => {
          const info = e.detail?.prompt_id === pid && e.detail.output?.mmh3_mask?.[0];
          if (info) finish(null, info);
        },
        execution_error: (e) => {
          if (e.detail?.prompt_id === pid)
            finish(new Error(e.detail.exception_message || "the job failed — the ComfyUI console has the details"));
        },
        execution_interrupted: (e) => { if (e.detail?.prompt_id === pid) finish(new Error("the job was cancelled")); },
      };
      for (const [k, f] of Object.entries(on)) api.addEventListener(k, f);
      const started = Date.now();
      const timer = setInterval(async () => {
        if (this.closed) return finish(null);
        if (Date.now() - started > 30 * 60 * 1000) return finish(new Error("no result after 30 minutes"));
        if (asking) return;
        asking = true;
        const ctl = new AbortController();
        const cut = setTimeout(() => ctl.abort(), 10000);
        try {
          const r = await api.fetchApi(`/history/${pid}`, { signal: ctl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const entry = (await r.json())?.[pid];
          failures = 0;
          if (!entry?.status || entry.status.completed === undefined) return;
          if (entry.status.status_str !== "success") {
            const msg = (entry.status.messages || []).map((m) => m[0] === "execution_error" ? m[1]?.exception_message : "")
              .find(Boolean);
            return finish(new Error(msg || "the job failed — the ComfyUI console has the details"));
          }
          const info = ((entry.outputs?.["2"] || {}).mmh3_mask || [])[0];
          finish(info ? null : new Error("the job finished without a mask"), info || null);
        } catch (err) {
          failures += 1;
          if (failures >= 20) finish(new Error(`couldn't read the job's result from ComfyUI (${err.name === "AbortError" ? "no answer" : err.message})`));
        } finally {
          clearTimeout(cut);
          asking = false;
        }
      }, 3000);
    });
  }
}

/** Right-click menu on a loader video. */
function videoMenu(panel, item, e) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll(".mml-ctxmenu").forEach((m) => m.remove());
  const entry = (label, title, fn) => el("div", { class: "mml-ctxitem", title,
    onclick: () => { menu.remove(); fn(); } }, label);
  const armed = (label, armedLabel, title, fn) => {
    const it = el("div", { class: "mml-ctxitem mml-ctxdanger", title }, label);
    return armTwice(it, armedLabel, () => { menu.remove(); fn(); });
  };
  const menu = el("div", { class: "mml-ctxmenu", style: { left: `${e.clientX}px`, top: `${e.clientY}px` } },
    entry("✂ Trim & crop…", "Open the editor", () => new TrimModal(panel, item)),
    entry(item.mask ? "◐ Edit the mask…" : "◐ Mask for editing…",
      "Mark part of this clip to replace, change or remove; only that area is regenerated",
      () => new TrimModal(panel, item, { mask: true })),
    item.mask && item.mask_info?.sprite
      ? entry(overlayOn() ? "Hide the mask overlay" : "Show the mask overlay",
          "Draw saved masks over clips here and in the editor. It's a preview, not the exact mask.",
          () => setOverlay(!overlayOn()))
      : null,
    item.mask ? el("div", { class: "mml-ctxsep" }) : null,
    item.mask ? armed("Clear the mask", "Click again to clear the mask",
      "Remove the mask; the clip goes back to being a reference (click twice)", () => clearMaskOn(panel, item)) : null);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 6}px`;
  if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 6}px`;
  const off = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); window.removeEventListener("pointerdown", off, true); } };
  setTimeout(() => window.addEventListener("pointerdown", off, true), 0);
}

/** The largest centred rect of `aspect` (w/h) inside a w x h frame, in the
 *  normalised x/y/w/h the crop uses — the same region an automatic
 *  centre-crop keeps. */
function coverRect(w, h, aspect) {
  const px = (w || 1) / (h || 1);
  if (px > aspect) { const cw = aspect / px; return { x: (1 - cw) / 2, y: 0, w: cw, h: 1 }; }
  const ch = px / aspect;
  return { x: 0, y: (1 - ch) / 2, w: 1, h: ch };
}

/** The trim/crop editor for an item that doesn't live in a Media Loader.
 *  Edits are written to `item` on Apply, then `onApply(item)` runs. */
export function openCropEditor(item, { onApply, aspect, aspectLabel, say } = {}) {
  const panel = {
    node: null,
    live: () => item,
    commit: () => onApply?.(item),
    say: (msg) => say?.(msg),
  };
  // Rotating swaps item.width/height straight away; on Cancel put them back,
  // or the item would describe a turn it never got.
  const size = [item.width, item.height];
  let applied = false;
  const modal = new TrimModal(panel, item, { aspect, aspectLabel, noAdd: true, refmod: true });
  const apply = modal.apply, close = modal.close;
  modal.apply = () => { applied = true; apply.call(modal); };
  modal.close = () => { close.call(modal); if (!applied) [item.width, item.height] = size; };
  modal.overlay.style.zIndex = "10060";          // above the RefMod library
  return modal;
}

function lightbox(item, tag) {
  const url = viewURL(item.file);
  const media = item.kind === "video"
    ? el("video", { src: url, controls: true, autoplay: true, loop: true })
    : el("img", { src: url });
  if (!item.width) {
    media.addEventListener(item.kind === "video" ? "loadedmetadata" : "load",
      () => {
        const w = media.naturalWidth || media.videoWidth;
        const h = media.naturalHeight || media.videoHeight;
        if (!w) return;
        item.width = w; item.height = h;
        const cap = overlay.querySelector(".mml-lightdims");
        if (cap) cap.textContent = dimsLabel(w, h);
      });
  }
  const overlay = el("div", { class: "mml-light",
    onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    el("div", { class: "mml-lightbox" }, media,
      el("div", { class: "mml-lightcap" },
        el("span", { class: `mml-tag ${tag.startsWith("<Video") ? "vid" : "pic"}` }, tag),
        el("span", {}, item.name),
        el("span", { class: "mml-lightdims" },
          dimsLabel(item.width, item.height)),
        el("button", { class: "mml-btn", style: { marginLeft: "auto" },
          onclick: () => overlay.remove() }, "Close"))));
  const esc = (e) => {
    if (e.key === "Escape") { overlay.remove(); window.removeEventListener("keydown", esc); }
  };
  window.addEventListener("keydown", esc);
  document.body.append(overlay);
}

// The ratios ComfyUI's resolution selector offers, so the badge speaks the
// same vocabulary as the preset you'd pick to match a reference.
const ASPECTS = [
  [1, 1, "Square"], [2, 3, "Portrait Photo"], [3, 2, "Photo"],
  [3, 4, "Portrait Standard"], [4, 3, "Standard"],
  [9, 16, "Portrait Widescreen"], [16, 9, "Widescreen"],
  [9, 21, "Portrait Ultrawide"], [21, 9, "Ultrawide"],
];

/** Where object-fit:contain actually draws inside an element, in element
 *  coordinates. CSS can't express this (percentage max-heights need a
 *  definite parent, and aspect-ratio won't override a set dimension), so the
 *  overlay boxes are measured and positioned in script. */
function drawnBox(mediaEl, natW, natH) {
  const bw = mediaEl.clientWidth, bh = mediaEl.clientHeight;
  const nw = natW || mediaEl.naturalWidth || mediaEl.videoWidth;
  const nh = natH || mediaEl.naturalHeight || mediaEl.videoHeight;
  if (!bw || !bh || !nw || !nh) return null;
  const nat = nw / nh, box = bw / bh;
  const w = nat > box ? bw : bh * nat;
  const h = nat > box ? bw / nat : bh;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/** A quarter-turned image keeps its pre-rotation layout box, so constrain it
 *  to the tile's shorter side — after the turn it then fits either way. */
function fitTurned(img) {
  const place = () => {
    const p = img.parentElement;
    if (!p) return;
    const side = Math.min(p.clientWidth, p.clientHeight);
    if (!side) return;
    img.style.maxWidth = `${side}px`;
    img.style.maxHeight = `${side}px`;
  };
  place();
  img.addEventListener("load", place);
  if (typeof ResizeObserver === "function") {
    if (img._mmlTurnRO) img._mmlTurnRO.disconnect();
    const ro = new ResizeObserver(place);
    img._mmlTurnRO = ro;
    ro.observe(img.parentElement || img);
  }
}

/** Keep an overlay box glued to the drawn media, now and on every resize. */
/** Where the picture is actually PAINTED, in hostEl's coordinate space.
 *
 *  drawnBox() above reads the LAYOUT box, which a CSS transform does not
 *  touch. That is right for the thumbnail path, where `.mml-cropfit` carries
 *  the same transform as the image and the two share one frame. The editor
 *  rotates only the image, so its overlay has to be placed where the pixels
 *  land: getBoundingClientRect() does account for transforms.
 *
 *  It also positions against hostEl rather than the media element. drawnBox
 *  returns offsets measured inside the media box but the overlay is a child
 *  of the stage; those two agreed only while the media filled the stage.
 *  sizeMedia() gives a turned preview an explicit width and centres it, so
 *  they no longer do — the marquee landed in the letterbox beside the image.
 *
 *  natW/natH describe the DISPLAYED orientation. The rotate handler swaps
 *  item.width/height on every quarter turn, so passing those is already
 *  correct; naturalWidth/naturalHeight are upright and only stand in before
 *  the media has decoded. */
function paintedBox(mediaEl, natW, natH, hostEl) {
  const host = hostEl && hostEl.getBoundingClientRect();
  if (!host || !host.width) return null;
  const r = mediaEl.getBoundingClientRect();
  const bw = r.width, bh = r.height;
  const nw = natW || mediaEl.naturalWidth || mediaEl.videoWidth;
  const nh = natH || mediaEl.naturalHeight || mediaEl.videoHeight;
  if (!bw || !bh || !nw || !nh) return null;
  // object-fit:contain letterboxes inside the element when the element's
  // aspect and the media's disagree — the cap on the long edge can do that.
  const nat = nw / nh, box = bw / bh;
  const w = nat > box ? bw : bh * nat;
  const h = nat > box ? bw / nat : bh;
  return { x: r.left - host.left + (bw - w) / 2,
           y: r.top - host.top + (bh - h) / 2, w, h };
}

function fitToMedia(mediaEl, boxEl, natW, natH, hostEl) {
  const place = () => {
    const d = hostEl ? paintedBox(mediaEl, natW, natH, hostEl)
                     : drawnBox(mediaEl, natW, natH);
    if (!d) return;
    Object.assign(boxEl.style, {
      left: `${d.x}px`, top: `${d.y}px`,
      width: `${d.w}px`, height: `${d.h}px`,
    });
  };
  place();
  mediaEl.addEventListener("load", place);
  mediaEl.addEventListener("loadedmetadata", place);
  if (typeof ResizeObserver === "function") {
    // One observer per element, ever: render() runs often and an observer
    // left behind on each pass piles up until the browser stalls.
    if (mediaEl._mmlFitRO) mediaEl._mmlFitRO.disconnect();
    const ro = new ResizeObserver(place);
    mediaEl._mmlFitRO = ro;
    ro.observe(mediaEl);
    return () => { ro.disconnect(); if (mediaEl._mmlFitRO === ro) mediaEl._mmlFitRO = null; };
  }
  return () => {};
}

/** Size actually sent after a crop, for badges and tooltips. */
function outSize(item) {
  let w = item.width, h = item.height;
  if (!w || !h) return [w, h];
  const turn = ((parseInt(item.rotate, 10) || 0) % 360 + 360) % 360;
  if (turn === 90 || turn === 270) { const t = w; w = h; h = t; }
  const c = item.crop;
  if (c) {
    w = Math.max(16, Math.round(w * (c.w ?? 1)));
    h = Math.max(16, Math.round(h * (c.h ?? 1)));
  }
  const cap = parseInt(item.resize, 10) || 0;
  if (cap > 0 && Math.max(w, h) > cap) {
    const k = cap / Math.max(w, h);
    w = Math.max(16, Math.round(w * k));
    h = Math.max(16, Math.round(h * k));
  }
  return [w, h];
}

/** Nearest standard ratio to w:h, with how far off it is. */
function nearestAspect(w, h) {
  const target = w / h;
  let best = ASPECTS[0], bestErr = Infinity;
  for (const a of ASPECTS) {
    const err = Math.abs(a[0] / a[1] - target) / target;
    if (err < bestErr) { bestErr = err; best = a; }
  }
  return { a: best[0], b: best[1], name: best[2], err: bestErr };
}

/** Ratio as a decimal, normalised to 1 on the short side: "2.35:1", "1:1.85". */
function decimalRatio(w, h) {
  return w >= h ? `${(w / h).toFixed(2)}:1` : `1:${(h / w).toFixed(2)}`;
}

/** "16:9", "\u224816:9" when close, or a plain decimal when no standard
 *  ratio is near enough to name honestly. */
function ratioLabel(w, h) {
  if (!w || !h) return "";
  const n = nearestAspect(w, h);
  if (n.err > 0.10) return decimalRatio(w, h);
  return `${n.err <= 0.005 ? "" : "\u2248"}${n.a}:${n.b}`;
}

/** "1290\u00d7720 \u00b7 16:9". */
function dimsLabel(w, h) {
  return w && h ? `${w}\u00d7${h} \u00b7 ${ratioLabel(w, h)}` : "";
}

/** Longer form for tooltips: names the preset and the exact ratio. */
function dimsTitle(name, w, h) {
  if (!w || !h) return name;
  const n = nearestAspect(w, h);
  if (n.err <= 0.005)
    return `${name}\n${w}\u00d7${h} \u2014 ${n.a}:${n.b} (${n.name})`;
  return `${name}\n${w}\u00d7${h} \u2014 ${decimalRatio(w, h)}, ` +
    `closest preset ${n.a}:${n.b} (${n.name}, ${(n.err * 100).toFixed(1)}% off)`;
}

/* --------------------------------------------------------- audio player */

function miniPlayer(url) {
  const fill = el("i");
  const bar = el("div", { class: "mml-bar" }, fill);
  const time = el("span", { class: "mml-time" }, "0:00");
  const btn = el("button", { class: "mml-play", title: "Play" }, "\u25b6");
  let audio = null;

  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const ensure = () => {
    if (audio) return audio;
    audio = new Audio(url);
    audio.addEventListener("timeupdate", () => {
      if (audio.duration) {
        fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
        time.textContent = fmt(audio.currentTime);
      }
    });
    audio.addEventListener("ended", () => { btn.textContent = "\u25b6"; });
    return audio;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const a = ensure();
    if (a.paused) { a.play().catch(() => {}); btn.textContent = "\u23f8"; }
    else { a.pause(); btn.textContent = "\u25b6"; }
  });
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    const a = ensure();
    const r = bar.getBoundingClientRect();
    if (a.duration) a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
  });
  return { btn, bar, time, stop: () => { if (audio) { audio.pause(); } } };
}

/* ------------------------------------------------------------- uploading */

let capsPromise = null;
function capabilities() {
  if (!capsPromise) {
    capsPromise = api.fetchApi("/minimax_h3/capabilities")
      .then((r) => r.json())
      .catch(() => ({ video: true, av: false }));
  }
  return capsPromise;
}

/* Every state-changing route wants the session token the server minted at
   startup, sent as a header. Fetch it once from the same origin and reuse
   it; a page on another origin cannot read that GET, which is the whole
   defence. If the server restarts while this page stays open the token
   goes stale and the first POST comes back 403 — refetch and retry once. */
const TOKEN_HEADER = "X-MiniMaxH3-Token";
let tokenPromise = null;
function sessionToken(fresh = false) {
  if (fresh || !tokenPromise) {
    tokenPromise = api.fetchApi("/minimax_h3/token")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`token ${r.status}`))))
      .then((j) => j.token || Promise.reject(new Error("no token in response")))
      .catch((err) => { tokenPromise = null; throw err; });
  }
  return tokenPromise;
}

/** POST to one of this pack's routes with the session token attached.
 *  `init` is the usual fetch init minus `method`. */
export async function postApi(path, init = {}) {
  const send = async (token) => api.fetchApi(path, {
    ...init, method: "POST",
    headers: { ...(init.headers || {}), [TOKEN_HEADER]: token },
  });
  let resp = await send(await sessionToken());
  if (resp.status === 403) {
    const data = await resp.clone().json().catch(() => ({}));
    if (data.token_required) resp = await send(await sessionToken(true));
  }
  if (resp.status === 403) {
    // Refused again with a token fetched a moment ago: the header isn't getting
    // through, or the request reached another server. Say what to look at
    // instead of "missing or stale session token", which reads like a step
    // the user skipped. The ComfyUI console has a line saying which it was.
    const data = await resp.clone().json().catch(() => ({}));
    if (data.token_required) {
      console.warn(`[Fantastic H3] ${path} refused the session token twice; see the ComfyUI console ` +
        `for whether the ${TOKEN_HEADER} header arrived.`);
      return new Response(JSON.stringify({ ...data, error: TOKEN_REFUSED }),
        { status: 403, headers: { "Content-Type": "application/json" } });
    }
  }
  return resp;
}
const TOKEN_REFUSED = "ComfyUI refused this pack's session token even after fetching a fresh one. " +
  "If you are using ComfyUI inside another front-end (SwarmUI's Comfy tab, for one), behind a proxy, " +
  `tunnel or login page, or another custom node changes requests, the ${TOKEN_HEADER} header may be ` +
  "removed on the way — open ComfyUI's own page directly and try again. The ComfyUI console says which.";

async function presetApi(path, body) {
  const resp = body
    ? await postApi("/minimax_h3/presets" + path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" } })
    : await api.fetchApi("/minimax_h3/presets" + path);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `request failed (${resp.status})`);
  return data;
}

async function uploadFile(file) {
  const body = new FormData();
  body.append("file", file, file.name);
  const resp = await postApi("/minimax_h3/upload", { body });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `upload failed (${resp.status})`);
  return data;
}

/** Give an item a stable id.
 *
 *  Items are re-parsed from JSON whenever a panel syncs, which creates fresh
 *  objects. Anything that identified an item by object identity — a tile's
 *  click handler, say — then silently stopped matching, so Remove appeared to
 *  do nothing or hit the wrong tile. An id survives the round trip. */
let uidSeq = 0;
function withUid(item) {
  if (item && !item.uid) item.uid = `m${Date.now().toString(36)}${uidSeq++}`;
  return item;
}

/* --------------------------------------------------------------- panel */

class LoaderPanel {
  /** @param opts.store - { read(), write(items) }. Given one, the panel
   *  reads and writes THAT instead of the node's media_state widget, and
   *  stays out of the node's panel registry so Live commits never reach it
   *  and its own commits never reach Live. The panel itself stays
   *  single-buffered — only its target moves. */
  constructor(node, opts = {}) {
    this.node = node;
    this.store = opts.store || null;
    this.storeLabel = opts.storeLabel || "";
    if (!this.store) (node._mmlPanels = node._mmlPanels || []).push(this);
    this.items = this.read();
    this.busy = 0;
    this.presets = [];
    this.presetName = "";
    this.presetPrompt = null;   // "save" | "delete" while confirming inline
    this.unloadPrompt = false;  // confirming "unload all media"
    this.trimOpen = null;       // item whose trim editor is expanded
    this.msg = "";
    this.msgErr = false;
    this.players = [];
    injectCSS();

    this.root = el("div", { class: "mml-panel" });
    this.root.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".mml-scalewrap")) this.closeScaleMenu();
      if (!e.target.closest(".mml-prefwrap")) this.closePrefMenu();
      if (!e.target.closest(".mml-presetwrap")) this.closePresetMenu();
    });
    // Dragging a slider must not be treated as a click elsewhere.
    this.root.addEventListener("click", (e) => {
      if (e.target.closest(".mml-scalemenu")) e.stopPropagation();
    });
    this.picker = el("input", {
      type: "file", multiple: true, style: { display: "none" },
      accept: "image/*,video/*,audio/*",
      onchange: (e) => { this.add([...e.target.files]); e.target.value = ""; },
    });
    this.root.append(this.picker);

    this.root.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      this.root.classList.add("drop");
    });
    this.root.addEventListener("dragleave", (e) => {
      if (e.target === this.root) this.root.classList.remove("drop");
    });
    this.root.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); e.stopPropagation();
      this.root.classList.remove("drop");
      this.add([...e.dataTransfer.files]);
    });

    this.render();
    this.refreshPresets();
    if (!this.store) setTimeout(() => this.maskCheck(), 4000);   // once the workflow has loaded
  }

  /** presetName survives every edit short of Unload, so it will happily
   *  claim "beach set" for media that stopped matching it an hour ago.
   *  Ask the server what the media actually is and mark it if it drifted. */
  async checkPresetMatch() {
    if (this.store) return;              // draft sets aren't named presets
    try {
      const res = await presetApi("/match", { items: this.items });
      const drifted = !!this.presetName && res.name !== this.presetName;
      if (drifted !== this.presetDrifted) {
        this.presetDrifted = drifted;
        this.render();
      }
    } catch (e) { /* labelling is cosmetic; never break the panel for it */ }
  }

  async refreshPresets() {
    try {
      const data = await presetApi("");
      // The route used to return bare strings; it now returns objects with
      // a category. Normalise both so a stale cached client can't blank the
      // picker.
      this.presets = (data.presets || []).map((p) =>
        typeof p === "string" ? { name: p, category: "" } : p);
      this.presetCats = data.categories || [];
      this.render();
    } catch (e) { /* routes unavailable; the row stays empty */ }
  }

  presetNames() { return this.presets.map((p) => p.name); }

  async savePreset(name, category) {
    if (!this.items.length) {
      this.say("Nothing loaded to save.", true); this.render(); return;
    }
    if (!name) { this.say("Give the preset a name.", true); this.render(); return; }
    try {
      const body = { name, items: this.items };
      // Undefined means "leave whatever it had"; "" means uncategorised.
      if (category !== undefined) body.category = category;
      const res = await presetApi("/save", body);
      this.presetName = res.name;
      this.presetDrifted = false;
      this.presetPrompt = null;
      this.say(`Saved "${res.name}" (${res.count} item${res.count === 1 ? "" : "s"}).`);
      await this.refreshPresets();
    } catch (err) {
      this.say(`Save failed: ${err.message}`, true);
      this.render();
    }
  }

  async loadPreset(name) {
    if (!name) return;
    try {
      const res = await presetApi("/load", { name });
      this.items = res.items || [];
      this.presetName = res.name;
      this.presetDrifted = false;
      if (res.missing?.length) {
        this.say(`Loaded "${res.name}" — ${res.missing.length} file(s) no longer ` +
          `on disk and were skipped: ${res.missing.join(", ")}`, true);
      } else {
        this.say(`Loaded "${res.name}".`);
      }
      this.commit();
    } catch (err) {
      this.say(`Load failed: ${err.message}`, true);
      this.render();
    }
  }

  async deletePreset() {
    try {
      const res = await presetApi("/delete", { name: this.presetName });
      this.say(`Deleted "${res.deleted}".`);
      this.presetName = "";
      this.presetPrompt = null;
      await this.refreshPresets();
    } catch (err) {
      this.say(`Delete failed: ${err.message}`, true);
      this.render();
    }
  }

  widget() { return this.node.widgets?.find((w) => w.name === "media_state"); }

  read() {
    return this.readOrNull() || [];
  }

  /** Parse the widget, or null when it can't be trusted.
   *
   *  The difference matters: an absent widget (workflow still loading, node
   *  detached while switching tabs) is NOT an empty library. Treating it as
   *  one wiped whatever was loaded and left the panel dead until the node was
   *  recreated. */
  readOrNull() {
    if (this.store) {
      const v = this.store.read();
      return Array.isArray(v) ? v.map(withUid) : null;
    }
    const w = this.widget();
    if (!w || typeof w.value !== "string") return null;
    // An empty value is "not deserialised yet", not "no media": the widget
    // exists before the workflow's saved value lands on it.
    const raw = w.value.trim();
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map(withUid) : null;
    } catch (e) {
      return null;
    }
  }

  commit() {
    // Re-entrancy guard: render() builds tiles whose handlers can call back
    // into commit() (an <img> learning its size, say). Without this the pair
    // can bounce indefinitely and lock the browser up.
    if (this._committing) { this._commitAgain = true; return; }
    this._committing = true;
    try {
      this.items.forEach(withUid);
      if (this.store) {
        // No fanout: this panel isn't in the node's registry, and the node's
        // own media must not move because a draft was edited.
        this.store.write(this.items);
        this.render();
        return;
      }
      clearTimeout(this._matchTimer);
      this._matchTimer = setTimeout(() => this.checkPresetMatch(), 400);
      const w = this.widget();
      if (!w) {
        // Nothing to write through yet. Keep what's in memory and just draw.
        this.render();
        return;
      }
      w.value = JSON.stringify(this.items);
      window.dispatchEvent(new Event("mml-media-changed"));     // RefMod stacks number after these media
      try { this.node.setDirtyCanvas?.(true, true); }
      catch (e) { /* Vue redraws itself */ }

      // Re-read into every panel so they all hold the same generation of
      // objects — but only when the read actually succeeded.
      const panels = (this.node._mmlPanels || []).includes(this)
        ? this.node._mmlPanels
        : [...(this.node._mmlPanels || []), this];
      panels.forEach((p) => {
        const fresh = p.readOrNull();
        if (fresh) p.items = fresh;
        p.render();
      });
    } finally {
      this._committing = false;
    }
    // One deferred pass only. If a handler keeps asking, stop rather than
    // trading commits with it forever.
    if (this._commitAgain) {
      this._commitAgain = false;
      if (!this._commitDeferred) {
        this._commitDeferred = true;
        try { this.commit(); } finally { this._commitDeferred = false; }
      }
    }
  }

  count(kind) { return this.items.filter((i) => i.kind === kind).length; }

  /** Node and text scale. Dragging does NOT apply: resizing the node moves
   *  this popover with it, which pulls the slider out from under the cursor.
   *  Set both, then Apply. */
  scaleControl() {
    const prefs = this.scalePrefs || (this.scalePrefs = loadScalePrefs());
    const pending = { node: prefs.node, text: prefs.text };
    const pct = (v) => `${Math.round(v * 100)}%`;
    const inputs = {};
    const outs = {};

    const dirty = () => applyBtn.classList.toggle("primary",
      pending.node !== prefs.node || pending.text !== prefs.text);

    const maxFor = (key) => key === "text" ? TEXT_SCALE_MAX : SCALE_MAX;

    const slider = (key, label) => {
      // The number is typeable: a slider alone can't hit an exact value.
      const out = el("input", { type: "number", class: "mml-scaleval",
        min: String(Math.round(SCALE_MIN * 100)),
        max: String(Math.round(maxFor(key) * 100)), step: "5",
        value: String(Math.round(pending[key] * 100)),
        onchange: (e) => {
          pending[key] = clampScale(Number(e.target.value) / 100, maxFor(key));
          const shown = Math.round(pending[key] * 100);
          e.target.value = String(shown);      // snap back if out of range
          input.value = String(shown);
          dirty();
        },
        onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); } });
      const input = el("input", { type: "range", class: "mml-scalerange",
        min: String(Math.round(SCALE_MIN * 100)),
        max: String(Math.round(maxFor(key) * 100)), step: "5",
        value: String(Math.round(pending[key] * 100)),
        oninput: (e) => {
          pending[key] = clampScale(Number(e.target.value) / 100, maxFor(key));
          out.value = String(Math.round(pending[key] * 100));
          dirty();
        } });
      inputs[key] = input;
      outs[key] = out;
      return el("label", { class: "mml-scalerow" },
        el("span", { class: "mml-scalelabel" }, label), input, out,
        el("span", { class: "mml-scalepct" }, "%"));
    };

    const commit = (n, t) => {
      prefs.node = n; prefs.text = t;
      pending.node = n; pending.text = t;
      inputs.node.value = String(Math.round(n * 100));
      inputs.text.value = String(Math.round(t * 100));
      outs.node.value = String(Math.round(n * 100));
      outs.text.value = String(Math.round(t * 100));
      saveScalePrefs(prefs);
      applyTextScale(this, t);
      applyNodeSize(this.node, n);       // last: this moves the popover
      applyBtn.classList.remove("primary");
    };

    const applyBtn = el("button", { class: "mml-btn mml-sm",
      onclick: (e) => { e.stopPropagation(); commit(pending.node, pending.text); } },
      "Apply");

    const menu = el("div", { class: "mml-scalemenu" },
      slider("node", "Node size"),
      slider("text", "Text size"),
      el("div", { class: "mml-scalefoot" },
        el("span", {}, "Remembered for new nodes"),
        el("button", { class: "mml-btn mml-sm",
          onclick: (e) => { e.stopPropagation(); commit(1, 1); } }, "Reset"),
        applyBtn));

    const btn = el("button", { class: "mml-btn mml-sm",
      title: "Node and text size",
      onclick: (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle("on");
        btn.classList.toggle("on", open);
      } }, "\u2921 Size");
    this._scaleMenu = menu;
    this._scaleBtn = btn;
    return el("span", { class: "mml-scalewrap" }, btn, menu);
  }

  /** The loader's ⚙ settings: the clean-up reminder's size. */
  prefsControl() {
    const now = el("span", {});
    const input = el("input", { type: "number", class: "mml-scaleval", min: "0", step: "50",
      value: String(cleanupMB()),
      onchange: (e) => {
        const v = Math.max(0, Math.round(+e.target.value || 0));
        e.target.value = String(v);
        try { localStorage.setItem(CLEANUP_KEY, String(v)); } catch (err) { /* this session only */ }
      },
      onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); } });
    const menu = el("div", { class: "mml-scalemenu", onmousedown: (e) => e.stopPropagation() },
      el("label", { class: "mml-scalerow",
        title: "Prompt a Clean up once mask files nothing uses take this much space. 0 turns the reminder off." },
        el("span", { class: "mml-scalelabel mml-preflabel" }, "Clean-up reminder"), input,
        el("span", { class: "mml-scalepct" }, "MB")),
      el("div", { class: "mml-scalefoot" }, now));
    const btn = el("button", { class: "mml-btn mml-sm", title: "Media Loader settings",
      onclick: async (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle("on");
        btn.classList.toggle("on", open);
        if (!open) return;
        now.textContent = "Counting unused mask files\u2026";
        const pick = await this.unusedFiles();
        now.textContent = pick ? `Unused mask files now: ${fmtMB(pick.filter((f) => f.kind === "mask")
          .reduce((t, f) => t + f.size, 0))}. 0 turns the reminder off.` : "Couldn't list the mask files.";
      } }, "\u2699");
    this._prefMenu = menu;
    this._prefBtn = btn;
    return el("span", { class: "mml-prefwrap" }, btn, menu);
  }

  closePrefMenu() {
    this._prefMenu?.classList.remove("on");
    this._prefBtn?.classList.remove("on");
  }

  closeScaleMenu() {
    this._scaleMenu?.classList.remove("on");
    this._scaleBtn?.classList.remove("on");
  }

  /** Preset picker the pack owns. This was a native <select>, and it was the
   *  only one in the pack living inside the canvas DOM widget — the frontend
   *  repositions that element on every canvas draw, and any touch collapses
   *  an open native picker, which read as "the dropdown flashes and closes".
   *  A popover we own can only be closed by us. */
  presetPicker() {
    const list = el("div", { class: "mml-presetlist" });
    // Same bar the prompt library uses: a text search, a category select,
    // and a pencil to rename or clear the selected category. Mirroring it
    // rather than inventing a second idiom for the same job.
    const filter = el("input", { type: "text", class: "mml-presetfilter",
      placeholder: "Search presets",
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => e.stopPropagation(),
      onkeydown: (e) => {
        if (e.key === "Escape") { this.closePresetMenu(); e.stopPropagation(); }
        e.stopPropagation();      // typing must not reach the modal's keys
      },
      oninput: () => paint() });

    const catSel = el("select", { class: "mml-presetcatfilter",
      title: "Show one category",
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => e.stopPropagation(),
      onchange: () => { this._catFilter = catSel.value; this._catRename = false;
        paint(); } });

    const catBtn = el("button", { class: "mml-btn mml-sm mml-presetcatedit",
      title: "Rename or clear the selected category",
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => {
        e.stopPropagation();
        if (!this._catFilter) { this.say("Pick a category to manage first.", true); return; }
        this._catRename = !this._catRename;
        paint();
      } }, "\u270e");

    const bar = el("div", { class: "mml-presetbar" }, filter, catSel, catBtn);
    const renameRow = el("div", { class: "mml-presetrenamerow" });

    const paintCats = () => {
      const cats = this.presetCats || [];
      catSel.replaceChildren(
        el("option", { value: "" }, "All categories"),
        ...cats.map((c) => el("option", { value: c }, c)),
        el("option", { value: "\u0000none" }, "Uncategorised"));
      catSel.value = this._catFilter || "";
      catBtn.classList.toggle("on", !!this._catRename);
    };

    const paintRename = () => {
      if (!this._catRename || !this._catFilter
          || this._catFilter === "\u0000none") {
        renameRow.replaceChildren();
        return;
      }
      const input = el("input", { type: "text", class: "mml-presetcatnew",
        value: this._catFilter,
        onmousedown: (e) => e.stopPropagation(),
        onclick: (e) => e.stopPropagation(),
        onkeydown: (e) => {
          e.stopPropagation();
          if (e.key === "Enter") go("");
          if (e.key === "Escape") { this._catRename = false; paint(); }
        } });
      const go = async (to) => {
        const from = this._catFilter;
        const target = to === "" ? input.value.trim() : to;
        if (to === "" && !target) return;
        try {
          await presetApi("/category", { from, to: target });
          this._catFilter = to === null ? "" : target;
          this._catRename = false;
          await this.refreshPresets();
          this._presetMenu?.classList.add("on");
          this._presetBtn?.classList.add("on");
        } catch (err) { this.say(`Couldn't update: ${err.message}`, true); }
      };
      renameRow.replaceChildren(input,
        el("button", { class: "mml-btn mml-sm",
          onmousedown: (e) => e.stopPropagation(),
          onclick: (e) => { e.stopPropagation(); go(""); } }, "Rename"),
        el("button", { class: "mml-btn mml-sm mml-danger",
          title: "Remove this category from its presets; the presets stay",
          onmousedown: (e) => e.stopPropagation(),
          onclick: (e) => { e.stopPropagation();
            this._catFilter = ""; go(null); } }, "Clear"));
    };

    const paint = () => {
      // Normalise here too, not just in refreshPresets: anything that sets
      // this.presets directly would otherwise render nameless rows.
      this.presets = (this.presets || []).map((p) =>
        typeof p === "string" ? { name: p, category: "" } : p);
      paintCats();
      paintRename();
      const q = filter.value.trim().toLowerCase();
      const cf = this._catFilter || "";
      const hits = this.presets.filter((p) => {
        const cat = p.category || "";
        if (cf === "\u0000none" && cat) return false;
        if (cf && cf !== "\u0000none" && cat !== cf) return false;
        return !q || p.name.toLowerCase().includes(q)
                  || cat.toLowerCase().includes(q);
      });
      if (!hits.length) {
        list.replaceChildren(el("div", { class: "mml-presetempty" },
          this.presets.length ? "Nothing matches that."
                              : "No presets saved \u2014 use Save."));
        return;
      }
      const groups = new Map();
      for (const p of hits) {
        const k = p.category || "";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      // Named categories first, alphabetically; uncategorised last, since
      // it's a leftover rather than a heading anyone chose.
      const keys = [...groups.keys()].filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      if (groups.has("")) keys.push("");
      const out = [];
      for (const k of keys) {
        // Headed even when it's the only group: hiding it meant the
        // grouping stayed invisible until after you'd filed something.
        out.push(el("div", { class: "mml-presethead" }, k || "Uncategorised"));
        for (const p of groups.get(k)) {
          if (this._catEdit === p.name) { out.push(this.catEditor(p, paint)); continue; }
          out.push(el("div", {
            class: "mml-presetitem" + (p.name === this.presetName ? " on" : ""),
            onmousedown: (e) => e.stopPropagation(),
            onclick: (e) => { e.stopPropagation(); this.loadPreset(p.name); } },
            el("span", { class: "mml-presetitemname" }, p.name),
            p.counts ? el("span", { class: "mml-presetitemn" },
              String((p.counts.picture || 0) + (p.counts.video || 0) +
                     (p.counts.audio || 0))) : null,
            // File an existing preset without loading and re-saving it.
            el("button", { class: "mml-presetcatbtn",
              title: "Change this preset's category",
              onmousedown: (e) => e.stopPropagation(),
              onclick: (e) => {
                e.stopPropagation();
                this._catEdit = p.name;
                paint();
              } }, "\u270e")));
        }
      }
      list.replaceChildren(...out);
    };
    paint();

    const menu = el("div", { class: "mml-presetmenu" }, bar, renameRow, list);
    const btn = el("button", { class: "mml-presetbtn",
      title: "Load a saved reference set",
      onkeydown: (e) => {
        if (e.key === "Escape" && menu.classList.contains("on")) {
          this.closePresetMenu();
          e.stopPropagation();     // closing the menu must not close the modal
        }
      },
      onclick: (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle("on");
        btn.classList.toggle("on", open);
      } },
      this.presetName
        ? this.presetName + (this.presetDrifted ? " (edited)" : "")
        : (this.presets.length ? "load preset\u2026" : "no presets saved"));
    this._presetMenu = menu;
    this._presetBtn = btn;
    return el("div", { class: "mml-presetwrap" }, btn, menu);
  }

  /** Inline category editor for one preset row. Inline rather than a
   *  dialog, same as everywhere else in this pack. */
  catEditor(p, paint) {
    const known = [...(this.presetCats || [])];
    if (p.category && !known.includes(p.category)) known.unshift(p.category);
    const fresh = el("input", { type: "text", class: "mml-presetcatnew",
      placeholder: "new category", style: { display: "none" },
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => e.stopPropagation(),
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { this._catEdit = null; paint(); }
      } });
    const sel = el("select", { class: "mml-presetcat",
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => e.stopPropagation(),
      onchange: () => {
        const isNew = sel.value === "\u0000new";
        fresh.style.display = isNew ? "" : "none";
        if (isNew) fresh.focus();
      } },
      el("option", { value: "" }, "no category"),
      known.map((c) => el("option", { value: c,
        selected: c === (p.category || "") }, c)),
      el("option", { value: "\u0000new" }, "(new category\u2026)"));
    sel.value = p.category || "";
    const commit = async () => {
      const value = sel.value === "\u0000new" ? fresh.value.trim() : sel.value;
      try {
        await presetApi("/meta", { name: p.name, category: value });
        this._catEdit = null;
        await this.refreshPresets();
        // refreshPresets re-renders the whole panel, which rebuilds the
        // picker closed — reopen it so filing several in a row is one flow.
        this._presetMenu?.classList.add("on");
        this._presetBtn?.classList.add("on");
      } catch (err) {
        this.say(`Couldn't set category: ${err.message}`, true);
        this._catEdit = null;
        paint();
      }
    };
    return el("div", { class: "mml-presetitem editing",
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => e.stopPropagation() },
      el("span", { class: "mml-presetitemname" }, p.name),
      sel, fresh,
      el("button", { class: "mml-btn mml-sm", onclick: commit }, "Set"),
      el("button", { class: "mml-btn mml-sm",
        onclick: () => { this._catEdit = null; paint(); } }, "\u2715"));
  }

  closePresetMenu() {
    this._catEdit = null;
    this._presetMenu?.classList.remove("on");
    this._presetBtn?.classList.remove("on");
  }


  say(text, isError, action = null) {
    this.msg = text || "";
    this.msgErr = !!isError;
    this.msgAction = action;
  }

  async add(files) {
    if (!files.length) return;
    this.say("");
    const caps = await capabilities();
    for (const file of files) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const guess = /^(png|jpe?g|webp|bmp|gif|tiff?)$/.test(ext) ? "picture"
        : /^(mp4|mov|mkv|webm|avi|m4v|mpe?g)$/.test(ext) ? "video"
        : /^(wav|mp3|flac|ogg|m4a|aac|opus)$/.test(ext) ? "audio" : null;
      if (!guess) { this.say(`${file.name}: unsupported file type.`, true); continue; }
      if (this.count(guess) >= MAX[guess]) {
        this.say(`All ${MAX[guess]} ${guess} slots are full — ${file.name} skipped.`, true);
        continue;
      }
      if (guess === "audio" && audioCount(this.items) >= MAX.audio) {
        this.say(`H3 takes ${MAX.audio} audio clips in total, and split video ` +
          `soundtracks count too — ${file.name} skipped.`, true);
        continue;
      }
      if (guess === "video" && !caps.video) {
        this.say("Videos need PyAV on the server.", true);
        continue;
      }
      this.busy += 1; this.render();
      try {
        const info = await uploadFile(file);
        // Don't spend an audio clip the budget can't cover — the soundtrack
        // stays available, just switched off until room is made.
        const budgetFull = audioCount(this.items) >= MAX.audio;
        const pairable = info.kind === "video" && info.has_audio;
        this.items.push({
          kind: info.kind,
          file: info.file,
          name: info.original || info.name,
          duration: info.duration ?? null,
          width: info.width ?? null,
          height: info.height ?? null,
          has_audio: !!info.has_audio,
          audio_mode: pairable && !budgetFull ? "paired" : "off",
        });
        if (pairable && budgetFull)
          this.say(`${info.original || info.name} loaded with its audio off — ` +
            `already using ${MAX.audio} audio clips.`, true);
      } catch (err) {
        this.say(`${file.name}: ${err.message}`, true);
      } finally {
        this.busy -= 1;
      }
    }
    this.commit();
  }

  trimBtn(item) {
    const still = item.kind === "picture";
    if (!still && !item.duration) return null;
    const trimmed = !!(item.trim && (item.trim.start || item.trim.end));
    const active = trimmed || item.crop || item.mirror || item.rotate;
    const what = [];
    if (item.crop) what.push("cropped");
    if (item.rotate) what.push(`${item.rotate}\u00b0`);
    if (item.resize) what.push(`max ${item.resize}px`);
    if (item.mirror) what.push("mirrored");
    if (trimmed) what.push(`${fmtSpan(item)} (${fmtDur(effDuration(item))} kept)`);
    return el("span", {
      class: "mml-trimbtn" + (active ? " on" : ""),
      title: active ? `${what.join(", ")} \u2014 click to edit`
        : (still ? "Crop or mirror this picture"
                 : "Use only part of this clip"),
      onclick: (e) => {
        e.stopPropagation();
        new TrimModal(this, item);
      },
    }, still ? "\u25a3" : "\u2702",
    // how long the clip is as it's sent: the kept span, or all of it
    still ? null : el("span", { class: "mml-trimlen" }, fmtDur(effDuration(item))));
  }


  /** Mask files (and their overlay sprites) that no Media Loader in this
   *  workflow, saved media set or Prompt Builder draft points at (a clip's
   *  Auto Mask layers each have one too), plus saved edit/reference latents. */
  async findCleanup() {
    const pick = await this.unusedFiles();
    this.cleanupNudge = null;
    if (!pick) { this.say("Couldn't list the mask files.", true); this.render(); return; }
    this.cleanup = { files: pick, bytes: pick.reduce((t, f) => t + f.size, 0),
      masks: pick.filter((f) => f.kind === "mask").length, cache: pick.filter((f) => f.kind === "cache").length };
    this.render();
  }

  /** What Clean up would delete, or null when the files can't be listed. */
  async unusedFiles() {
    let files = [];
    try { files = (await (await api.fetchApi("/minimax_h3/edit_files", { cache: "no-store" })).json()).files || []; }
    catch (e) { return null; }
    const used = new Set();
    for (const n of app.graph?._nodes || []) {
      if (n.type !== LOADER_NAME) continue;
      let items = [];
      try { items = JSON.parse(n.widgets?.find((w) => w.name === "media_state")?.value || "[]"); } catch (e) {}
      for (const it of items) {
        const layers = (it?.mask_layers || []).flatMap((l) => [l.result, l.result_info?.sprite?.file]);
        for (const f of [it?.mask, it?.mask_info?.sprite?.file, ...layers]) {
          if (f) used.add(String(f).split(" [")[0].split("/").pop());
        }
      }
    }
    return files.filter((f) => f.kind === "cache" || (!used.has(f.name) && !f.saved));
  }

  /** Prompt a Clean up once unused mask files pass the ⚙ reminder size. */
  async maskCheck() {
    const limit = cleanupMB() * 1048576;
    if (!limit || this.store || nudgeChecking) return;
    nudgeChecking = true;
    try {
      const pick = await this.unusedFiles();
      const bytes = (pick || []).filter((f) => f.kind === "mask").reduce((t, f) => t + f.size, 0);
      if (bytes >= Math.max(limit, nudgeAt) && !this.cleanup) {
        nudgeAt = bytes + limit;
        this.cleanupNudge = bytes;
        this.render();
      }
    } finally { nudgeChecking = false; }
  }

  async runCleanup() {
    const files = (this.cleanup?.files || []).map((f) => ({ kind: f.kind, name: f.name }));
    this.cleanup = null;
    try {
      const r = await postApi("/minimax_h3/edit_files/delete", { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      this.say(`Deleted ${d.removed.length} file(s).`);
      nudgeAt = 0;
    } catch (e) { this.say(`Clean up failed: ${e.message}`, true); }
    this.render();
  }

  unloadAll() {
    const n = this.items.length;
    this.items = [];
    this.unloadPrompt = false;
    this.presetName = "";          // no longer showing a saved set
    this.say(`Unloaded ${n} item(s). Files remain in ComfyUI's input folder.`);
    this.commit();
  }

  toggle(item) {
    const it = this.live(item);
    it.enabled = it.enabled === false;
    this.commit();
  }

  powerBtn(item) {
    const on = isOn(item);
    return el("span", {
      class: "mml-power" + (on ? " on" : ""),
      title: on ? "Switch off — kept here but not sent to the model"
        : "Switch on",
      onclick: (e) => { e.stopPropagation(); this.toggle(item); },
    }, on ? "\u25c9" : "\u25cb");
  }

  remove(item) {
    const uid = item?.uid;
    this.items = uid
      ? this.items.filter((i) => i.uid !== uid)
      : this.items.filter((i) => i !== item);
    this.commit();
  }

  /** Current object for an item, whichever generation the caller holds. */
  live(item) {
    if (!item) return null;
    return (item.uid && this.items.find((i) => i.uid === item.uid)) || item;
  }

  move(from, to) {
    if (to < 0 || to >= this.items.length || from === to) return;
    const [it] = this.items.splice(from, 1);
    this.items.splice(to, 0, it);
    this.commit();
  }

  reorderable(node, item) {
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(this.items.indexOf(item)));
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => node.classList.remove("dragging"));
    node.addEventListener("dragover", (e) => {
      if (e.dataTransfer.types.includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      node.classList.add("over");
    });
    node.addEventListener("dragleave", () => node.classList.remove("over"));
    node.addEventListener("drop", (e) => {
      if (e.dataTransfer.types.includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      node.classList.remove("over");
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (!isNaN(from)) this.move(from, this.items.indexOf(item));
    });
    return node;
  }

  /** An always-present empty slot: click to browse, drop to fill. */
  emptySlot(kind, index) {
    const slot = el("div", { class: "mml-slot",
      title: `Empty ${kind} slot ${index} \u2014 click to browse or drop a file`,
      onclick: () => this.picker.click() },
      el("span", {}, `${kind} ${index}`));
    slot.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      slot.classList.add("hot");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("hot"));
    slot.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); e.stopPropagation();
      slot.classList.remove("hot");
      this.root.classList.remove("drop");
      this.add([...e.dataTransfer.files]);
    });
    return slot;
  }

  render() {
    try {
      this.drawPanel();
    } catch (err) {
      // A partial redraw looks like "the buttons stopped working", because
      // the old tiles stay on screen holding stale handlers.
      console.error("[Fantastic H3 Media Loader] render failed:", err);
    }
  }

  drawPanel() {
    this.closeScaleMenu?.();
    this.closePresetMenu?.();
    this.players.forEach((p) => p.stop());
    this.players = [];
    (this.overlays || []).forEach((o) => o.detach());
    this.overlays = [];

    const { tags, extra } = computeTags(this.items);
    const total = fileCount(this.items);
    const pics = this.items.filter((i) => i.kind === "picture");
    const vids = this.items.filter((i) => i.kind === "video");
    const auds = this.items.filter((i) => i.kind === "audio");
    const kids = [this.picker];

    kids.push(el("div", { class: "mml-top" },
      el("button", { class: "mml-btn", onclick: () => this.picker.click() },
        "Load files\u2026"),
      el("span", { style: { fontSize: "10px", color: "#6b7484" } },
        this.busy ? `uploading ${this.busy}\u2026` : "or drop files on any slot"),
      el("span", { class: "mml-topspace" }),
      this.scaleControl(),

      this.items.length
        ? el("button", { class: "mml-btn mml-sm",
            title: "Remove every loaded reference from this node",
            onclick: () => { this.unloadPrompt = true; this.render(); } },
            "Unload media")
        : null,
      el("button", { class: "mml-btn mml-sm",
        title: "Delete mask files no Media Loader here uses, and saved edit latents (rebuilt when needed)",
        onclick: () => this.findCleanup() }, "Clean up\u2026"),
      this.prefsControl(),
      el("span", { class: "mml-count" + (total > MAX.total ? " over" : "") },
        `${total} / ${MAX.total}`),
      el("span", { class: "mml-count" + (audioCount(this.items) > MAX.audio ? " over" : ""),
        style: { marginLeft: "6px" },
        title: "Audio clips in play, including split video soundtracks" },
        `\u266a ${audioCount(this.items)}/${MAX.audio}`)));

    const select = this.presetPicker();
    if (this.cleanup) {
      const c = this.cleanup;
      kids.push(el("div", { class: "mml-presetrow" },
        el("span", { class: "mml-presetwarn" }, c.files.length
          ? `${c.masks} unused mask file(s) and ${c.cache} saved latent(s), ${fmtMB(c.bytes)}. Masks used by a ` +
            "Media Loader in this workflow, a saved media set or a Prompt Builder draft are kept; saved latents " +
            "are rebuilt when needed. Masks used only in other workflows would be lost."
          : "Nothing to clean up: every mask file is in use and there are no saved latents."),
        c.files.length ? el("button", { class: "mml-btn mml-sm mml-danger", onclick: () => this.runCleanup() },
          "Delete") : null,
        el("button", { class: "mml-btn mml-sm", onclick: () => { this.cleanup = null; this.render(); } },
          c.files.length ? "Cancel" : "OK")));
    } else if (this.cleanupNudge) {
      kids.push(el("div", { class: "mml-presetrow" },
        el("span", { class: "mml-presetwarn" }, `Old mask files nothing uses take ${fmtMB(this.cleanupNudge)}, ` +
          `past the ${cleanupMB()} MB reminder set in \u2699.`),
        el("button", { class: "mml-btn mml-sm", onclick: () => this.findCleanup() }, "Clean up\u2026"),
        el("button", { class: "mml-btn mml-sm", onclick: () => { this.cleanupNudge = null; this.render(); } },
          "Not now")));
    }
    if (this.unloadPrompt) {
      kids.push(el("div", { class: "mml-presetrow" },
        el("span", { class: "mml-presetwarn" },
          `Remove all ${this.items.length} item(s) from this node? ` +
          "The files stay in your ComfyUI input folder."),
        el("button", { class: "mml-btn mml-sm mml-danger",
          onclick: () => this.unloadAll() }, "Unload"),
        el("button", { class: "mml-btn mml-sm",
          onclick: () => { this.unloadPrompt = false; this.render(); } },
          "Cancel")));
    }

    if (this.presetPrompt === "save") {
      const input = el("input", { type: "text", class: "mml-presetname",
        placeholder: "Preset name",
        value: this.presetName ||
          `refs ${new Date().toISOString().slice(0, 10)}` });
      // Category: existing ones as a pick, so filing into one is a choice
      // rather than retyping it exactly; the same shape the prompt library
      // uses. A blank value leaves the preset uncategorised.
      const known = [...(this.presetCats || [])];
      const current = (this.presets.find((p) => p.name === this.presetName)
        || {}).category || "";
      if (current && !known.includes(current)) known.unshift(current);
      const catNew = el("input", { type: "text", class: "mml-presetcatnew",
        placeholder: "new category", style: { display: "none" } });
      const cat = el("select", { class: "mml-presetcat",
        onchange: () => {
          const isNew = cat.value === "\u0000new";
          catNew.style.display = isNew ? "" : "none";
          if (isNew) catNew.focus();
        } },
        el("option", { value: "" }, "no category"),
        known.map((c) => el("option", { value: c, selected: c === current }, c)),
        el("option", { value: "\u0000new" }, "(new category\u2026)"));
      cat.value = current;
      const categoryValue = () =>
        cat.value === "\u0000new" ? catNew.value.trim() : cat.value;
      const go = () => this.savePreset(input.value.trim(), categoryValue());
      const keys = (e) => {
        if (e.key === "Enter") go();
        if (e.key === "Escape") { this.presetPrompt = null; this.render(); }
      };
      input.addEventListener("keydown", keys);
      catNew.addEventListener("keydown", keys);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      kids.push(el("div", { class: "mml-presetrow" },
        el("span", { class: "mml-presetlbl" }, "save as"), input, cat, catNew,
        el("button", { class: "mml-btn mml-sm", onclick: go }, "Save"),
        el("button", { class: "mml-btn mml-sm",
          onclick: () => { this.presetPrompt = null; this.render(); } }, "Cancel")));
    } else if (this.presetPrompt === "delete") {
      kids.push(el("div", { class: "mml-presetrow" },
        el("span", { class: "mml-presetwarn" },
          `Delete "${this.presetName}"? Your media files are not removed.`),
        el("button", { class: "mml-btn mml-sm mml-danger",
          onclick: () => this.deletePreset() }, "Delete"),
        el("button", { class: "mml-btn mml-sm",
          onclick: () => { this.presetPrompt = null; this.render(); } }, "Cancel")));
    } else {
      kids.push(el("div", { class: "mml-presetrow" },
        el("span", { class: "mml-presetlbl" }, "preset"),
        select,
        el("button", { class: "mml-btn mml-sm", title: "Save the current set",
          onclick: () => { this.presetPrompt = "save"; this.render(); } }, "Save"),
        el("button", { class: "mml-btn mml-sm", title: "Delete the selected preset",
          onclick: () => {
            if (!this.presetName) { this.say("Pick a preset first.", true); }
            else this.presetPrompt = "delete";
            this.render();
          } }, "Delete")));
    }

    const audio = audioCount(this.items);
    const dur = durations(this.items);
    const problems = [];
    if (total > MAX.total)
      problems.push(`Over the ${MAX.total}-file limit — remove ${total - MAX.total}.`);
    if (audio > MAX.audio)
      problems.push(`${audio} audio clips in play (limit ${MAX.audio}); split ` +
        "soundtracks count. Switch one to off.");
    if (dur.video > CLIP.totalPerType)
      problems.push(`Reference video totals ${dur.video.toFixed(1)}s ` +
        `(limit ${CLIP.totalPerType}s).`);
    if (dur.audio > CLIP.totalPerType)
      problems.push(`Reference audio totals ${dur.audio.toFixed(1)}s ` +
        `(limit ${CLIP.totalPerType}s).`);
    const short = this.items.filter((i) => isOn(i) && i.kind !== "picture" &&
      i.duration && effDuration(i) < CLIP.min);
    if (short.length)
      problems.push(`${short.map((i) => i.name).join(", ")}: shorter than ` +
        `${CLIP.min}s. The model was trained on ${CLIP.min}\u2013${CLIP.max}s ` +
        "reference clips, so very short ones may be weakly followed or " +
        "ignored \u2014 pad with silence or use a longer take.");
    if (!this.items.some((i) => isOn(i) && (i.kind === "picture" ||
        i.kind === "video")) && audio)
      problems.push("Audio can't be sent alone — add an image or video.");

    const act = !problems.length && this.msg && this.msgAction;
    kids.push(el("div", { class: "mml-msg" + (this.msgErr || problems.length ? " err" : "") },
      problems.length ? problems[0] : this.msg,
      act ? el("button", { class: "mml-msgact", onclick: (e) => { e.stopPropagation(); act.fn(); } }, act.label) : null));

    const left = el("div", { class: "mml-col" });
    const right = el("div", { class: "mml-col" });
    kids.push(el("div", { class: "mml-cols" }, left, right));

    left.append(el("div", { class: "mml-sec" }, "pictures",
      el("span", {}, `${pics.length}/${MAX.picture}`)));
    const picCells = [];
    pics.forEach((it) => {
      const tag = (tags.get(it) || "").slice(1, -1);
      picCells.push(this.reorderable(el("div",
        { class: "mml-slot filled pic" + (isOn(it) ? "" : " off") },
        (() => {
          // Badge and img are SIBLINGS in the slot: .mml-pic is absolutely
          // positioned against the slot, so wrapping it breaks its sizing.
          //
          // Declaration order matters here: everything the crop overlay needs
          // (turn, quarter, img) must exist BEFORE the overlay is built. They
          // used to be declared after it, which threw a temporal-dead-zone
          // ReferenceError for any cropped picture and aborted the whole
          // render — leaving stale tiles whose buttons no longer worked.
          const [ow, oh] = outSize(it);
          const turn = ((parseInt(it.rotate, 10) || 0) % 360 + 360) % 360;
          const quarter = turn === 90 || turn === 270;
          const flip = (it.mirror || turn)
            ? { transform: `${it.mirror ? "scaleX(-1) " : ""}rotate(${turn}deg)` }
            : {};

          const badge = el("span", { class: "mml-dims" + (it.crop ? " cut" : "") },
            dimsLabel(ow, oh));

          const img = el("img", { class: "mml-pic" + (quarter ? " turned" : ""),
            src: viewURL(it.file),
            style: flip,
            title: dimsTitle(it.name, it.width, it.height)
              + (turn ? `\nrotated ${turn}\u00b0` : "")
              + (it.crop ? `\ncropped to ${ow}\u00d7${oh}` : "")
              + (it.mirror ? "\nmirrored" : ""),
            onload: () => {
              // Items from before dimensions were stored learn them here.
              if (!it.width && img.naturalWidth) {
                // Write to the item's LIVE incarnation: commits re-parse the
                // state, so `it` may be a dead object from a replaced render.
                const target = this.live(it);
                if (!target.width) {
                  target.width = img.naturalWidth;
                  target.height = img.naturalHeight;
                }
                const [nw, nh] = outSize(target);
                badge.textContent = dimsLabel(nw, nh);
                img.title = dimsTitle(target.name, target.width, target.height);
                // One commit per batch of loads, not one per image: a preset
                // full of dimension-less pictures used to fire a commit →
                // re-render → fresh onloads → commit… burst that collapsed
                // any open popover and churned the panel.
                if (this.items.includes(target)) {
                  clearTimeout(this._dimsCommit);
                  this._dimsCommit = setTimeout(() => this.commit(), 120);
                }
              }
            },
            onclick: () => lightbox(it, tags.get(it) || "") });

          // The file is untouched, so the thumbnail shows the whole picture
          // with everything outside the crop dimmed — you can see what was
          // dropped, not just what's left.
          let marquee = null;
          if (it.crop) {
            const box = el("div", { class: "mml-cropbox" },
              el("div", { class: "mml-cropmark", style: {
                left: `${(it.crop.x ?? 0) * 100}%`,
                top: `${(it.crop.y ?? 0) * 100}%`,
                width: `${(it.crop.w ?? 1) * 100}%`,
                height: `${(it.crop.h ?? 1) * 100}%`,
              } }));
            marquee = el("div", { class: "mml-cropfit", style: flip }, box);
            // Fit against the post-rotation shape: a quarter turn swaps the
            // sides the drawn image occupies.
            requestAnimationFrame(() => fitToMedia(
              img, box,
              quarter ? it.height : it.width,
              quarter ? it.width : it.height));
          }
          if (quarter) requestAnimationFrame(() => fitTurned(img));

          return [img, marquee, badge];
        })(),
        el("div", { class: "mml-picbar" },
          this.powerBtn(it),
          el("span", { class: "mml-tag pic" }, isOn(it) ? tag : "off"),
          this.trimBtn(it),
          el("span", { class: "mml-drag", title: "Drag to reorder" }, "\u2630"),
          el("span", { class: "mml-x", title: "Remove",
            onclick: () => this.remove(it) }, "\u2715"))), it));
    });
    for (let i = pics.length; i < MAX.picture; i++)
      picCells.push(this.emptySlot("picture", i + 1));
    left.append(el("div", { class: "mml-pics" }, picCells));

    right.append(el("div", { class: "mml-sec" }, "videos",
      el("button", { class: "mml-helpbtn",
        title: "What do off / paired / alone do?",
        onclick: (e) => { e.stopPropagation(); splitHelp(e.currentTarget); } }, "?"),
      el("span", {}, `${vids.length}/${MAX.video}`)));
    const vidCells = [];
    vids.forEach((it) => {
      const mode = it.audio_mode || "off";
      const splitTag = extra.get(it);
      const editing = !!it.edit;
      let thumb = null;
      const row = el("div", { class: "mml-row" },
        editing
          ? el("span", { class: "mml-editbadge", title: "This clip is being edited \u2014 click to change the mask",
              onclick: (e) => { e.stopPropagation(); new TrimModal(this, it, { mask: true }); } }, "\u25d0")
          : this.powerBtn(it),
        thumb = el("video", { class: "mml-vthumb",
          style: it.mirror ? { transform: "scaleX(-1)" } : {},
          onloadedmetadata: (e) => {
            const t = it.trim;
            if (t && t.start) try { e.target.currentTime = t.start; } catch (_) {}
            // Same healing as pictures: old presets stored videos without
            // dimensions or duration. Learn them from the element, once,
            // against the live item, with one debounced commit per batch.
            const v = e.target;
            const target = this.live(it);
            if ((!target.width && v.videoWidth) ||
                (!target.duration && v.duration)) {
              if (!target.width && v.videoWidth) {
                target.width = v.videoWidth;
                target.height = v.videoHeight;
              }
              if (!target.duration && Number.isFinite(v.duration))
                target.duration = Math.round(v.duration * 100) / 100;
              if (this.items.includes(target)) {
                clearTimeout(this._dimsCommit);
                this._dimsCommit = setTimeout(() => this.commit(), 120);
              }
            }
          }, src: viewURL(it.file), muted: true,
          preload: "metadata",
          onmouseenter: (e) => e.target.play().catch(() => {}),
          onmouseleave: (e) => e.target.pause(),
          onclick: () => lightbox(it, tags.get(it) || "") }),
        el("div", { class: "mml-meta" },
          el("div", { class: "mml-tag vid" + (editing ? " edit" : "") },
            isOn(it) ? (tags.get(it) || "").slice(1, -1) + (editing ? " \u00b7 editing" : "") : "off"),
          el("div", { class: "mml-name", title: it.name }, it.name)));
      const sprite = editing && it.mask && overlayOn() ? it.mask_info?.sprite : null;
      // What is sent: the crop and size cap applied, like a picture's badge.
      const [ow, oh] = outSize(it);
      thumb.title = dimsTitle(it.name, it.width, it.height) + (it.crop || it.resize ? `\nsent as ${ow}\u00d7${oh}` : "") +
        (it.mirror ? "\nmirrored" : "") + (sprite ? `\n${OVERLAY_NOTE} Right-click the clip to hide it.` : "");
      const wrap = el("span", { class: "mml-vthumbwrap" });
      thumb.replaceWith(wrap);
      wrap.append(thumb, el("span", { class: "mml-dims vid" + (it.crop ? " cut" : "") }, ratioLabel(ow, oh)));
      if (sprite) {
        const o = maskOverlay(thumb, wrap, sprite, "contain", { append: true, look: itemLook(it), onMissing: () => wrap.append(
          el("span", { class: "mml-maskmissing", title: "This clip's mask files are missing: mask it again, " +
            "or clear its mask. The next run stops with an error until you do." }, "\u26a0")) });
        o.mirror(!!it.mirror);
        this.overlays.push(o);
      }
      if (it.has_audio && isOn(it)) {
        row.append(el("div", { class: "mml-segstack" },
          el("span", { class: "mml-tag aud mml-segtag" },
            mode === "off" ? "\u2014" : (splitTag || "").slice(1, -1)),
          el("span", { class: "mml-seg" },
            ["off", "paired", "alone"].map((label) => {
              const m = label === "alone" ? "standalone" : label;
              const turningOn = m !== "off" && mode === "off";
              return el("button", { class: m === mode ? "on" : "",
                title: m === "paired"
                  ? "Soundtrack pairs with this video, labelled just before it"
                  : m === "standalone"
                    ? "Soundtrack becomes a separate reference, numbered after the videos"
                    : "Ignore this video's audio",
                onclick: () => {
                  if (turningOn && audioCount(this.items) >= MAX.audio) {
                    this.say(`Already using ${MAX.audio} audio clips \u2014 ` +
                      "switch another off first.", true);
                    this.render();
                    return;
                  }
                  it.audio_mode = m;
                  this.commit();
                } }, label);
            }))));
      }
      row.append(
        this.trimBtn(it),
        el("span", { class: "mml-drag", title: "Drag to reorder" }, "\u2630"),
        el("span", { class: "mml-x", title: "Remove",
          onclick: () => this.remove(it) }, "\u2715"));
      const vcell = el("div", { class: "mml-slot filled vid" + (isOn(it) || editing ? "" : " off"),
        title: "Right-click to mask part of this clip for editing",
        oncontextmenu: (e) => videoMenu(this, it, e) },
        row);
      vidCells.push(this.reorderable(vcell, it));
    });
    for (let i = vids.length; i < MAX.video; i++)
      vidCells.push(this.emptySlot("video", i + 1));
    right.append(el("div", { class: "mml-vids" }, vidCells));

    right.append(el("div", { class: "mml-sec" }, "standalone audio",
      el("span", {}, `${auds.length}/${MAX.audio}`)));
    const audCells = [];
    auds.forEach((it) => {
      const player = miniPlayer(viewURL(it.file));
      this.players.push(player);
      const arow = el("div", { class: "mml-row" },
          this.powerBtn(it),
          player.btn,
          el("div", { class: "mml-meta", style: { flex: "0 0 auto", maxWidth: "38%" } },
            el("div", { class: "mml-tag aud" },
              isOn(it) ? (tags.get(it) || "").slice(1, -1) : "off"),
            el("div", { class: "mml-name", title: it.name }, it.name)),
          player.bar, player.time,
          this.trimBtn(it),
          el("span", { class: "mml-drag", title: "Drag to reorder" }, "\u2630"),
          el("span", { class: "mml-x", title: "Remove",
            onclick: () => this.remove(it) }, "\u2715"));
      const acell = el("div",
        { class: "mml-slot filled aud" + (isOn(it) ? "" : " off") },
        arow);
      audCells.push(this.reorderable(acell, it));
    });
    for (let i = auds.length; i < MAX.audio; i++)
      audCells.push(this.emptySlot("audio", i + 1));
    right.append(el("div", { class: "mml-auds" }, audCells),
      el("div", { class: "mml-spacer" }));

    const order = [];
    pics.filter(isOn).forEach((i) => order.push((tags.get(i) || "").slice(1, -1)));
    vids.filter(isOn).forEach((i) => {
      if (extra.has(i) && i.audio_mode === "paired")
        order.push(`[${(extra.get(i) || "").slice(1, -1)}]`);
      order.push((tags.get(i) || "").slice(1, -1));
    });
    this.items.filter(isOn).forEach((i) => {
      if (i.kind === "audio") order.push((tags.get(i) || "").slice(1, -1));
      else if (i.kind === "video" && i.audio_mode === "standalone" && extra.has(i))
        order.push(`[${(extra.get(i) || "").slice(1, -1)}]`);
    });
    const edited = this.items.find((i) => i.edit && i.enabled !== false);
    kids.push(el("div", { class: "mml-order" },
      el("b", {}, "tag order sent to the model"),
      el("div", {}, order.length ? order.join(" \u00b7 ") : "nothing loaded yet"),
      edited ? el("div", {}, `editing ${edited.name} \u2014 also cited as ${tags.get(edited) || "a reference"}`) : null));

    this.root.replaceChildren(...kids.filter(Boolean));
  }
}

/* --------------------------------------------------------- help popover */

const SPLIT_HELP = [
  ["off", "The video's audio is ignored — nothing is extracted and no tag is " +
    "created. Worth doing when the sound is irrelevant, since it also frees " +
    "one of your twelve reference slots."],
  ["paired", "Use paired when the sound genuinely belongs to that footage: " +
    "on-screen dialogue where lip sync matters, diegetic action sounds that " +
    "need to land on the same frames, or video-editing tasks where you're " +
    "keeping the original soundtrack. The temporal binding is the whole point."],
  ["alone", "Use alone when you want the audio as a reference rather than as " +
    "that clip's soundtrack \u2014 borrowing a speaker's voice timbre for a " +
    "different character, referencing a music style, or lifting ambience. Also " +
    "the right choice when you're not reusing the video's visuals in sync, " +
    "since a binding you don't want can pull the generation toward reproducing " +
    "that clip's timing."],
];

const SPLIT_WIRING = [
  ["paired", "video_audio_N", "ref_video_audio_0", "<Audio 1> then <Video 1>"],
  ["alone", "audio_N", "ref_audio_0", "<Video 1> first, audio numbered after all videos"],
];

function splitHelp(anchor) {
  const rows = SPLIT_HELP.map(([mode, body]) =>
    el("div", { class: "mml-helprow" },
      el("span", { class: `mml-helpmode ${mode}` }, mode),
      el("p", {}, body)));

  const wiring = SPLIT_WIRING.map(([mode, out, native, tags]) =>
    el("div", { class: "mml-wirerow" },
      el("span", { class: `mml-helpmode ${mode}` }, mode),
      el("code", {}, out), el("span", { class: "mml-arrow" }, "\u2192"),
      el("code", {}, native),
      el("span", { class: "mml-tags" }, tags)));

  const box = el("div", { class: "mml-help" },
    el("div", { class: "mml-helphead" }, "split audio",
      el("button", { title: "Close", onclick: () => close() }, "\u2715")),
    el("div", { class: "mml-helpbody" },
      rows,
      el("div", { class: "mml-helpsub" }, "where the track comes out"),
      wiring,
      el("p", { class: "mml-helpnote" },
        "The extracted track always gets its own AUDIO output \u2014 ComfyUI has " +
        "no combined video-with-sound type, so the split is a wiring " +
        "requirement. The mode decides which group it joins, which sets the " +
        "native slot, the tag number, and whether the model binds it to that " +
        "video's frames. Either way it occupies a reference slot, so a video " +
        "with audio counts as two of your twelve.")));

  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left - 40, window.innerWidth - 380))}px`;
  box.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 380)}px`;

  const away = (e) => { if (!box.contains(e.target) && e.target !== anchor) close(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  function close() {
    box.remove();
    document.removeEventListener("mousedown", away, true);
    window.removeEventListener("keydown", esc);
  }
  document.addEventListener("mousedown", away, true);
  window.addEventListener("keydown", esc);
  document.body.append(box);
}

function flash(text) {
  const t = el("div", { class: "mml-toast" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

/** Spawn a Reference Splitter and wire this loader's bundle into it.
 *  The bundle output takes many links, so this coexists with the Prompt
 *  Builder connection. */
export function addSplitter(node) {
  const existing = outputTargets(node, 0).find((n) => n.type === SPLITTER_NAME);
  if (existing) {
    safeCanvasFocus(existing);
    flash("Splitter is already connected");
    return existing;
  }
  let sp = null;
  try {
    sp = LiteGraph.createNode(SPLITTER_NAME);
  } catch (e) { sp = null; }
  if (!sp) {
    flash("Reference Splitter not found \u2014 restart ComfyUI");
    return null;
  }
  app.graph.add(sp);
  try {
    sp.pos = [node.pos[0] + ((node.size?.[0] || NODE_W) + 60), node.pos[1]];
  } catch (e) { /* let the renderer place it */ }
  linkNodes(node, 0, sp, 0);
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* Vue redraws */ }
  flash("Splitter added \u2014 wire its slots to MiniMaxH3ReferenceToVideo");
  return sp;
}

/** @param onClose - run after the modal closes, so a caller that renders
 *  from this node's media (the prompt builder) can pick up the changes. */
export function openLoaderModal(node, opts = {}) {
  injectCSS();
  const { onClose, store, storeLabel, draft = false, note = "" } = opts;
  const panel = new LoaderPanel(node, { store, storeLabel });
  const close = () => {
    node._mmlPanels = (node._mmlPanels || []).filter((p) => p !== panel);
    panel.players.forEach((p) => p.stop());
    overlay.remove();
    window.removeEventListener("keydown", esc);
    node._mmlPanel?.render();
    try { onClose?.(); } catch (e) {
      console.error("[Fantastic H3 Media Loader] close callback failed:", e);
    }
  };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const overlay = el("div", { class: "mml-overlay",
    onmousedown: (e) => { if (e.target === overlay) close(); } },
    el("div", { class: "mml-modal" + (draft ? " draft" : "") },
      el("div", { class: "mml-modalhead" },
        draft ? el("span", { class: "mml-draftbadge" }, "DRAFT") : null,
        storeLabel || "Fantastic H3 Media Loader",
        el("button", { title: "Close", onclick: close }, "\u2715")),
      note ? el("div", { class: "mml-draftnote" }, note) : null,
      el("div", { class: "mml-modalbody" }, panel.root)));
  window.addEventListener("keydown", esc);
  document.body.append(overlay);
  scaleOverlay(node, [[overlay.querySelector(".mml-modal"), 1140, 780]]);
  return panel;
}

/* ------------------------------------------------------------ extension */

app.registerExtension({
  name: "MiniMaxH3.MediaLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== LOADER_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      try {
        const r = onNodeCreated?.apply(this, arguments);
        injectCSS();
        const w = this.widgets?.find((w) => w.name === "media_state");
        if (w) {
          w.hidden = true;
          w.type = "hidden";
          w.computeSize = () => [0, -4];
        }
        // Built-in widgets go first: in Nodes 2.0 a widget added after a DOM
        // widget anchors to the node's bottom and leaves a gap on resize.
        this.addWidget("button", "Open loader\u2026", null, () => openLoaderModal(this));
        this.addWidget("button", "+ Native-output splitter", null,
          () => addSplitter(this));

        this._mmlPanel = new LoaderPanel(this);
        const widget = this.addDOMWidget("mml_panel", "div", this._mmlPanel.root,
          { serialize: false });
        this._mmlWidget = widget;
        // A fresh node starts at the size you actually work at.
        applyStoredScale(this, { force: true });
        return r;
      } catch (err) {
        // Without this the node still registers but none of the UI
        // appears, which looks like "the node did not load".
        console.error("[Fantastic H3 Media Loader] setup failed for this node:", err);
        try { this.addWidget("button", "\u26a0 UI failed \u2014 click", null, () => {
          alert("Fantastic H3 Media Loader could not build its interface.\n\n" + err +
            "\n\nOpen the browser console for the full trace.");
        }); } catch (e2) { /* nothing more we can do */ }
        return undefined;
      }

    };

    // Canvas-only: Vue owns sizing there, so failure here must be harmless.
    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      try {
        const min = this.computeSize();
        size[0] = Math.max(NODE_W, size[0]);
        size[1] = Math.max(min[1], size[1]);
      } catch (e) { /* leave the size alone */ }
      return onResize?.apply(this, arguments);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => {
        if (this._mmlPanel) {
          this._mmlPanel.items = this._mmlPanel.read();
          this._mmlPanel.render();
        }
        // Re-apply the saved scale: the panel was just rebuilt from base
        // dimensions, so without this the workspace comes back at 100%
        // inside a correctly-sized node.
        applyStoredScale(this);
      }, 0);
      return r;
    };
  },
});
