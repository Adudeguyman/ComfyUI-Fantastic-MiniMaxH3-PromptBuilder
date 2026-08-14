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
    if (it.kind === "video" && it.has_audio &&
        (it.audio_mode || "off") !== "off") return n + 1;
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
      (i.kind === "video" && i.has_audio && (i.audio_mode || "off") !== "off"))),
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
export function outputTargets(node, slot) {
  try {
    const direct = node.getOutputNodes?.(slot);
    if (Array.isArray(direct) && direct.length) return direct;
  } catch (e) { /* fall through to the link table */ }
  const out = [];
  try {
    for (const id of node.outputs?.[slot]?.links || []) {
      const link = app.graph.links?.[id];
      const target = link && app.graph.getNodeById?.(link.target_id);
      if (target) out.push(target);
    }
  } catch (e) { /* nothing wired */ }
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

const CSS = `
.mml-panel{font-family:system-ui,sans-serif;color:#d7dbe2;font-size:12px;
  background:#191c22;border:1px solid #2a2f3a;border-radius:8px;padding:8px;
  display:flex;flex-direction:column;gap:6px;box-sizing:border-box;
  width:100%;height:476px;min-height:476px;overflow:hidden;}
.mml-cols{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:9px;}
.mml-col{display:flex;flex-direction:column;gap:5px;min-width:0;}
.mml-modal .mml-panel{border:0;height:100%;min-height:0;}
.mml-overlay{position:fixed;inset:0;z-index:10040;background:rgba(8,10,14,.62);
  display:flex;align-items:center;justify-content:center;}
.mml-modal{width:min(760px,94vw);height:min(520px,92vh);background:#191c22;
  border:1px solid #303642;border-radius:10px;display:flex;flex-direction:column;
  overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.55);}
.mml-modalhead{display:flex;align-items:center;gap:10px;padding:9px 13px;
  background:#1e222a;border-bottom:1px solid #2a2f3a;font-size:13px;
  font-weight:500;color:#d7dbe2;font-family:system-ui,sans-serif;}
.mml-modalhead button{margin-left:auto;background:none;border:0;color:#8a93a3;
  font-size:17px;cursor:pointer;}
.mml-modalhead button:hover{color:#fff;}
.mml-modalbody{flex:1;min-height:0;padding:8px;overflow:auto;}
.mml-panel.drop{border-color:#6f86b8;background:#1d2330;}
.mml-top{display:flex;align-items:center;gap:8px;flex:0 0 auto;}
.mml-btn{background:#2b3140;border:1px solid #3a4252;color:#d7dbe2;border-radius:6px;
  padding:4px 10px;font-size:11px;cursor:pointer;}
.mml-btn:hover{background:#333b4d;}
.mml-presetrow{flex:0 0 auto;display:flex;align-items:center;gap:5px;}
.mml-presetlbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  color:#6b7484;}
.mml-preset{flex:1;min-width:0;background:#12151b;color:#c9cfda;
  border:1px solid #2e3440;border-radius:6px;padding:3px 6px;font-size:11px;
  font-family:system-ui,sans-serif;}
.mml-preset:focus{outline:none;border-color:#4a5568;}
.mml-btn.mml-sm{padding:3px 9px;font-size:10px;}
.mml-btn.mml-danger{border-color:#7a3a3a;color:#f0a0a0;}
.mml-btn.mml-danger:hover{background:#3a2020;}
.mml-presetname{flex:1;min-width:0;background:#12151b;color:#dde2ea;
  border:1px solid #4a5568;border-radius:6px;padding:3px 7px;font-size:11px;
  font-family:system-ui,sans-serif;}
.mml-presetname:focus{outline:none;border-color:#6f86b8;}
.mml-presetwarn{flex:1;min-width:0;font-size:10px;color:#e0a94c;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mml-topspace{flex:1;}
.mml-detail{background:#12151b;color:#a9b2c2;border:1px solid #2e3440;
  border-radius:6px;padding:2px 4px;font-size:10px;margin-right:2px;}
.mml-count{font-size:10px;color:#8a93a3;font-family:ui-monospace,monospace;}
.mml-count.over{color:#f07070;}
.mml-msg{flex:0 0 auto;font-size:10px;min-height:12px;color:#e0a94c;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mml-msg.err{color:#f07070;}
.mml-sec{flex:0 0 auto;display:flex;align-items:center;font-size:10px;
  text-transform:uppercase;letter-spacing:.07em;color:#6b7484;}
.mml-sec span{margin-left:auto;text-transform:none;letter-spacing:0;color:#5c6472;
  font-family:ui-monospace,monospace;}

.mml-pics{flex:1;min-height:0;display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  grid-template-rows:repeat(3,minmax(0,1fr));gap:5px;}
.mml-vids{flex:0 0 auto;display:grid;grid-template-rows:repeat(3,46px);gap:5px;
  grid-template-columns:minmax(0,1fr);}
.mml-spacer{flex:1;min-height:0;}
.mml-auds{flex:0 0 auto;display:grid;grid-template-rows:repeat(3,38px);gap:5px;
  grid-template-columns:minmax(0,1fr);}

.mml-slot{border:1px dashed #2b313d;border-radius:6px;background:#141820;
  display:flex;align-items:center;justify-content:center;gap:5px;color:#4d5563;
  font-size:10px;cursor:pointer;overflow:hidden;min-width:0;min-height:0;}
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
  background:rgba(8,10,14,.85);color:#dfe4ec;font-size:8px;line-height:1.2;
  font-family:ui-monospace,monospace;pointer-events:none;letter-spacing:0;
  text-shadow:0 1px 2px rgba(0,0,0,.9);z-index:2;}
.mml-dims:empty{display:none;}
.mml-lightdims{font-size:10px;color:#8a93a3;font-family:ui-monospace,monospace;}
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
.mml-picbar .mml-trimbtn{font-size:12px;}
.mml-tag{font-family:ui-monospace,monospace;font-size:9px;white-space:nowrap;}
.mml-tag.pic{color:#e0a94c;} .mml-tag.vid{color:#4cc3e0;} .mml-tag.aud{color:#b48ce8;}
.mml-x{cursor:pointer;color:#7a8393;font-size:11px;line-height:1;}
.mml-x:hover{color:#e05a5a;}

.mml-row{display:flex;align-items:center;gap:6px;padding:0 6px;height:100%;
  box-sizing:border-box;min-width:0;overflow:hidden;}
.mml-vthumb{width:60px;height:34px;min-width:60px;max-width:60px;border-radius:4px;
  object-fit:contain;background:#0d1015;flex-shrink:0;cursor:zoom-in;}
.mml-meta{min-width:0;flex:1;}
.mml-name{font-size:9px;color:#6b7484;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;}
.mml-play{width:20px;height:20px;border-radius:50%;border:1px solid #3a4252;background:#20242d;
  color:#c9cfda;font-size:9px;line-height:1;cursor:pointer;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;padding:0;}
.mml-play:hover{border-color:#59637a;}
.mml-bar{flex:1;height:3px;background:#2a2f3a;border-radius:2px;min-width:16px;
  cursor:pointer;position:relative;}
.mml-bar i{position:absolute;left:0;top:0;bottom:0;background:#7d63b8;border-radius:2px;
  display:block;width:0;}
.mml-time{font-size:9px;color:#6b7484;font-family:ui-monospace,monospace;flex-shrink:0;}
.mml-seg{display:inline-flex;border:1px solid #2e3440;border-radius:4px;overflow:hidden;
  flex-shrink:0;}
.mml-seg button{background:none;border:0;color:#6b7484;font-size:9px;padding:1px 5px;
  cursor:pointer;}
.mml-seg button.on{background:#3a2f56;color:#e2d6f8;}
.mml-power{cursor:pointer;color:#4d5563;font-size:11px;line-height:1;flex-shrink:0;
  user-select:none;}
.mml-power.on{color:#7ec87e;}
.mml-power:hover{color:#a8e6a8;}
.mml-slot.filled.off{opacity:.42;border-style:dashed;}
.mml-slot.filled.off .mml-power{opacity:1;color:#6b7484;}
.mml-slot.filled.off:hover{opacity:.7;}
.mml-segstack{display:flex;flex-direction:column;align-items:center;gap:2px;
  flex-shrink:0;}
.mml-segtag{font-size:9px;}
.mml-trimok{border-color:#3e5240;color:#7ec87e;}
.mml-trimbtn{cursor:pointer;color:#e0a94c;opacity:.65;font-size:15px;line-height:1;
  flex-shrink:0;user-select:none;}
.mml-trimbtn:hover{opacity:1;}
.mml-trimbtn.on{opacity:1;text-shadow:0 0 6px rgba(224,169,76,.55);}
.mml-tmover{position:fixed;inset:0;background:rgba(8,10,14,.72);z-index:10050;
  display:flex;align-items:center;justify-content:center;}
.mml-tmmodal{width:min(640px,92vw);background:#191c22;border:1px solid #303642;
  border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.55);display:flex;
  flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif;}
.mml-tmhead{display:flex;align-items:center;gap:8px;padding:8px 12px;
  border-bottom:1px solid #2a2f3a;background:#1b1f27;}
.mml-tmtitle{flex:1;min-width:0;font-size:12px;color:#dde2ea;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mml-tmstage{position:relative;background:#000;line-height:0;}
.mml-tmvideo{width:100%;max-height:340px;object-fit:contain;display:block;}
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
.mml-tmcropinfo{font-size:10px;color:#4cc3e0;font-family:ui-monospace,monospace;}
.mml-tmaspect{background:#12151b;color:#c9cfda;border:1px solid #2e3440;
  border-radius:6px;padding:2px 5px;font-size:11px;}
.mml-btn.on{background:#173642;border-color:#4cc3e0;color:#9fe3f5;}
.mml-tmtimeline{position:relative;padding:8px 14px 4px;}
.mml-tmwave{display:block;width:100%;height:46px;margin-bottom:2px;}
.mml-tmruler{position:relative;height:16px;}
.mml-tmtick{position:absolute;transform:translateX(-50%);font-size:9px;
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
  font-size:9px;color:#8a6a33;text-transform:uppercase;letter-spacing:.06em;}
.mml-tmplaytime{color:#ffb84d;font-family:ui-monospace,monospace;
  text-transform:none;letter-spacing:0;font-size:10px;}
.mml-tmfoot{display:flex;align-items:center;gap:5px;padding:8px 12px 0;
  flex-wrap:wrap;}
.mml-tmfoot.act{padding:8px 12px 4px;border-top:1px solid #23272f;margin-top:8px;}
.mml-tmgap{width:8px;}
.mml-tmspace{flex:1;}
.mml-tmnum{width:52px;background:#12151b;color:#dde2ea;border:1px solid #2e3440;
  border-radius:6px;padding:3px 6px;font-size:11px;text-align:right;
  font-family:ui-monospace,monospace;}
.mml-tmnum:focus{outline:none;border-color:#4cc3e0;}
.mml-tmdash{color:#5c6472;font-size:11px;}
.mml-tmoutside{font-size:10px;color:#f07070;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;text-transform:none;letter-spacing:0;}
.mml-tmplayhead.out{background:#f07070;
  box-shadow:0 0 0 1px rgba(0,0,0,.65), 0 0 7px rgba(240,112,112,.85);}
.mml-tmplayhead.out::before{border-top-color:#f07070;}
.mml-tmnote{padding:2px 12px 6px;font-size:10px;color:#8a93a3;line-height:1.4;}
.mml-tmnote.bad{color:#f07070;}
.mml-tmnote:empty{display:none;}
.mml-tmkeys{padding:0 12px 10px;font-size:10px;color:#5c6472;}
.mml-tmreadout{font-size:11px;color:#8a93a3;font-family:ui-monospace,monospace;}
.mml-tmreadout.bad{color:#f07070;}
.mml-btn.primary{background:#1f4f7d;border-color:#3d7fbf;color:#dbeafe;}
.mml-trimrow{display:flex;align-items:center;flex-wrap:nowrap;gap:3px;
  padding:0 5px;height:100%;overflow:hidden;}
.mml-trimlbl{font-size:9px;text-transform:uppercase;letter-spacing:.07em;
  color:#6b7484;}
.mml-triminput{width:38px;background:#12151b;color:#dde2ea;
  border:1px solid #2e3440;border-radius:5px;padding:2px 6px;font-size:11px;}
.mml-triminput:focus{outline:none;border-color:#4a5568;}
.mml-trimdash{color:#6b7484;}
.mml-trimof{font-size:10px;color:#6b7484;}
.mml-trimerr{flex-basis:100%;font-size:10px;color:#f07070;}
.mml-trimerr:empty{display:none;}
.mml-drag{cursor:grab;color:#4d5563;font-size:10px;user-select:none;flex-shrink:0;}

.mml-order{flex:0 0 auto;background:#1a2230;border:1px solid #2b3a52;border-radius:6px;
  padding:4px 7px;height:42px;box-sizing:border-box;overflow:hidden;}
.mml-order b{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.07em;
  color:#6f86b8;font-weight:500;margin-bottom:1px;}
.mml-order div{font-family:ui-monospace,monospace;font-size:9px;color:#9db4dc;
  line-height:1.35;overflow:hidden;}

.mml-light{position:fixed;inset:0;z-index:10050;background:rgba(8,10,14,.75);
  display:flex;align-items:center;justify-content:center;}
.mml-lightbox{max-width:80vw;max-height:80vh;background:#1e222a;border:1px solid #3a4252;
  border-radius:10px;overflow:hidden;padding:8px;}
.mml-lightbox img,.mml-lightbox video{max-width:76vw;max-height:68vh;display:block;}
.mml-lightcap{display:flex;align-items:center;gap:8px;padding-top:6px;font-size:11px;
  color:#8a93a3;}
.mml-helpbtn{margin-left:5px;width:13px;height:13px;line-height:1;padding:0;
  border-radius:50%;border:1px solid #3a4252;background:#20242d;color:#8a93a3;
  font-size:9px;cursor:pointer;font-family:system-ui,sans-serif;}
.mml-helpbtn:hover{border-color:#6f86b8;color:#c9cfda;}
.mml-help{position:fixed;z-index:10055;width:370px;max-height:min(560px,88vh);
  background:#1e222a;border:1px solid #3a4252;border-radius:9px;overflow:hidden;
  display:flex;flex-direction:column;box-shadow:0 14px 36px rgba(0,0,0,.55);
  font-family:system-ui,sans-serif;}
.mml-helphead{display:flex;align-items:center;padding:7px 10px;background:#232833;
  border-bottom:1px solid #2a2f3a;font-size:11px;text-transform:uppercase;
  letter-spacing:.07em;color:#8a93a3;}
.mml-helphead button{margin-left:auto;background:none;border:0;color:#6b7484;
  font-size:13px;cursor:pointer;line-height:1;}
.mml-helphead button:hover{color:#fff;}
.mml-helpbody{overflow:auto;padding:9px 10px;}
.mml-helpbody p{margin:0;font-size:11px;line-height:1.55;color:#aab2c0;}
.mml-helprow{display:flex;gap:8px;margin-bottom:9px;}
.mml-helpmode{flex:0 0 auto;font-family:ui-monospace,monospace;font-size:10px;
  border-radius:9px;padding:1px 7px;height:16px;line-height:14px;
  border:1px solid #363d4a;background:#20242d;color:#8a93a3;}
.mml-helpmode.paired{border-color:#7d63b8;background:#3a2f56;color:#e2d6f8;}
.mml-helpmode.alone{border-color:#2c6f81;background:#1d3a44;color:#a5e2f0;}
.mml-helpsub{font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  color:#6b7484;margin:12px 0 6px;padding-top:8px;border-top:1px solid #2a2f3a;}
.mml-wirerow{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:6px;}
.mml-wirerow code{font-family:ui-monospace,monospace;font-size:10px;color:#9db4dc;
  background:#181c24;border-radius:4px;padding:1px 5px;}
.mml-arrow{color:#5c6472;font-size:10px;}
.mml-tags{font-family:ui-monospace,monospace;font-size:9px;color:#6b7484;
  flex-basis:100%;padding-left:2px;}
.mml-helpnote{margin-top:10px !important;padding-top:9px;
  border-top:1px solid #2a2f3a;color:#8a93a3 !important;}
.mml-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10060;
  background:#2b3140;color:#fff;border:1px solid #4a5568;border-radius:8px;
  padding:8px 16px;font-size:13px;font-family:system-ui,sans-serif;}
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

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** Popout editor for a clip's trim range and (for video) a crop rect.
 *  Writes item.trim {start,end} and item.crop {x,y,w,h} on Apply only. */
class TrimModal {
  constructor(panel, item) {
    this.panel = panel;
    this.item = item;
    this.dur = item.duration || 0;
    this.start = item.trim?.start || 0;
    this.end = item.trim?.end ?? this.dur;
    this.crop = item.crop ? { ...item.crop } : null;
    this.mirror = !!item.mirror;
    this.rotate = ((parseInt(item.rotate, 10) || 0) % 360 + 360) % 360;
    this.resize = parseInt(item.resize, 10) || 0;
    this.cropMode = false;
    this.aspect = "free";
    this.drag = null;
    injectCSS();
    this.build();
    document.body.append(this.overlay);
    window.addEventListener("keydown", this.onKey = (e) => this.key(e));
  }

  /** Keyboard control. Typing in a field always wins. */
  key(e) {
    if (this.isStill) {
      if (e.key === "Escape" && !(e.target && /^(INPUT|TEXTAREA|SELECT)$/
          .test(e.target.tagName))) this.close();
      return;
    }
    const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === "Escape") {
      if (!typing) this.close();
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
        if (this.item.kind === "audio" || this.item.has_audio) {
          e.preventDefault(); this.useAudio();
        }
        break;
      case "m": case "M":
        e.preventDefault(); this.toggleMute(); break;
      case "c": case "C":
        if (this.item.kind === "video") { e.preventDefault(); this.captureFrame(); }
        break;
      default: break;
    }
  }

  close() {
    if (this.stopFit) this.stopFit();
    if (this.raf) cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKey);
    try { this.media?.pause?.(); } catch (e) {}
    this.overlay.remove();
  }

  apply() {
    const it = this.item;
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
    if (this.crop && visual) it.crop = this.crop;
    else delete it.crop;
    if (this.mirror && visual) it.mirror = true;
    else delete it.mirror;
    if (this.rotate && visual) it.rotate = this.rotate;
    else delete it.rotate;
    if (this.resize && it.kind === "picture") it.resize = this.resize;
    else delete it.resize;
    this.close();
    this.panel.commit();
  }

  /* ---- media preview ---------------------------------------------- */

  get isStill() { return this.item.kind === "picture"; }

  buildMedia() {
    const url = viewURL(this.item.file);
    if (this.isStill) {
      this.media = el("img", { class: "mml-tmvideo", src: url });
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
    this.media.addEventListener("loadedmetadata", () => this.updatePlayhead());
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
    this.updatePlayhead();
  }

  /* ---- audio waveform --------------------------------------------- */

  async drawWave(canvas) {
    try {
      const resp = await fetch(viewURL(this.item.file));
      const buf = await resp.arrayBuffer();
      const ctx2 = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await ctx2.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const g = canvas.getContext("2d");
      const W = canvas.width, H = canvas.height, N = 240;
      const per = Math.floor(data.length / N);
      g.clearRect(0, 0, W, H);
      g.fillStyle = "#7d63b8";
      for (let i = 0; i < N; i++) {
        let peak = 0;
        for (let j = i * per; j < (i + 1) * per; j += 16)
          peak = Math.max(peak, Math.abs(data[j]));
        const h = Math.max(1, peak * H * 0.92);
        g.fillRect(i * (W / N), (H - h) / 2, W / N - 1, h);
      }
      ctx2.close();
    } catch (e) { /* waveform is decoration; the ruler still works */ }
  }

  /* ---- timeline ---------------------------------------------------- */

  buildTimeline() {
    this.ruler = el("div", { class: "mml-tmruler" });
    const ticks = 8;
    for (let i = 0; i <= ticks; i++) {
      this.ruler.append(el("span", { class: "mml-tmtick",
        style: { left: `${(i / ticks) * 100}%` } },
        fmt(this.dur * (i / ticks))));
    }
    this.selEl = el("div", { class: "mml-tmsel" });
    this.hStart = el("div", { class: "mml-tmhandle s",
      title: "Drag to move the start of the kept range",
      onmousedown: (e) => this.handleDown(e, "s") });
    this.hEnd = el("div", { class: "mml-tmhandle e",
      title: "Drag to move the end of the kept range",
      onmousedown: (e) => this.handleDown(e, "e") });
    this.playhead = el("div", { class: "mml-tmplayhead" });
    this.playTime = el("span", { class: "mml-tmplaytime" });
    this.outside = el("span", { class: "mml-tmoutside" });
    this.note = el("div", { class: "mml-tmnote" });
    this.bar = el("div", { class: "mml-tmbar",
      onmousedown: (e) => this.barDown(e) },
      this.selEl, this.hStart, this.hEnd, this.playhead);
    if (this.item.kind === "audio") {
      this.wave = el("canvas", { class: "mml-tmwave", width: 560, height: 46 });
      this.drawWave(this.wave);
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
    this.layoutTimeline();
    return el("div", { class: "mml-tmtimeline" },
      this.wave || null, this.ruler, this.bar,
      el("div", { class: "mml-tmnow" },
        this.outside,
        el("span", { class: "mml-tmspace" }),
        el("span", {}, "playhead"), this.playTime));
  }

  /** Time under the pointer, clamped to the clip. */
  timeAt(e) {
    const r = this.bar.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * this.dur;
    return Math.min(Math.max(t, 0), this.dur);
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
    const p = (t) => `${(this.dur ? t / this.dur : 0) * 100}%`;
    this.selEl.style.left = p(this.start);
    this.selEl.style.width = p(this.end - this.start);
    this.hStart.style.left = p(this.start);
    this.hEnd.style.left = p(this.end);
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
    const t = this.media?.currentTime || 0;
    // Clamp a little inside the bar: at exactly 0% or 100% the centred
    // marker is half outside and reads as missing.
    const pct = Math.min(Math.max((t / this.dur) * 100, 0.4), 99.6);
    this.playhead.style.left = `${pct}%`;
    this.playTime.textContent = fmt(t);
    this.checkOutside(t);
  }

  /** Warn when the previewed frame falls outside what will be sent. */
  checkOutside(t) {
    if (this.isStill || !this.outside) return;
    const at = t === undefined ? (this.media?.currentTime || 0) : t;
    const out = at < this.start - 0.001 || at > this.end + 0.001;
    this.outside.textContent = out
      ? `\u26a0 Frame at ${fmt(at)} is outside the kept range`
      : "";
    this.playhead.classList.toggle("out", out);
  }

  /** Keep the marker moving during playback; timeupdate alone is too coarse. */
  tick() {
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
                                this.item.width, this.item.height);
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
      [["free", "freeform"], ["1", "1:1"],
       [String(16 / 9), "16:9"], [String(9 / 16), "9:16"],
       [String(4 / 3), "4:3"], [String(3 / 4), "3:4"],
       [String(3 / 2), "3:2"], [String(2 / 3), "2:3"],
       [String(21 / 9), "21:9"], [String(9 / 21), "9:21"],
      ].map(([v, l]) => el("option", { value: v }, l)));
    // Pictures get a size cap: a 4K reference is decoded and rescaled on
    // every run, and the model downsizes it to the generation area anyway.
    this.sizeEl = this.isStill
      ? el("select", { class: "mml-tmaspect",
          title: "Cap the long edge of what's sent. The model rescales " +
                 "references anyway, so this mostly saves decode time and RAM " +
                 "\u2014 but keep a keyframe at least as large as your " +
                 "generation.",
          onchange: (e) => {
            this.resize = parseInt(e.target.value, 10) || 0;
            this.syncCrop();
          } },
          [[0, "size: full"], [2048, "max 2048px"], [1600, "max 1600px"],
           [1280, "max 1280px"], [1024, "max 1024px"], [832, "max 832px"]]
            .map(([v, label]) => el("option",
              { value: String(v), selected: this.resize === v }, label)))
      : null;
    return el("span", { class: "mml-tmcropbar" },
      this.rotBtn, this.mirrorBtn, this.cropBtn, this.aspectEl,
      this.sizeEl, this.cropInfo);
  }

  /** Mirror only the picture: the crop overlay stays in screen space, so a
   *  rect drawn here means the same region the backend will cut. */
  /** Say something inside the modal. Panel messages sit behind the overlay,
   *  so a refusal printed there is invisible until the modal closes. */
  modalSay(text, bad = false) {
    if (!this.note) return;
    this.note.textContent = text || "";
    this.note.classList.toggle("bad", !!bad);
  }

  /** Turn the preview and re-fit the crop overlay to the new bounds. */
  syncRotate() {
    if (this.media) {
      this.media.style.transform =
        `${this.mirror ? "scaleX(-1) " : ""}rotate(${this.rotate}deg)`;
      // A quarter turn means the drawn box swaps its sides; re-measure.
      if (this.cropBox) {
        requestAnimationFrame(() => {
          const w = this.item.width, h = this.item.height;
          if (this.stopFit) this.stopFit();
          this.stopFit = fitToMedia(this.media, this.cropBox, w, h);
        });
      }
    }
    if (this.rotBtn) this.rotBtn.classList.toggle("on", !!this.rotate);
  }

  syncMirror() {
    if (this.media) {
      this.media.style.transform =
        `${this.mirror ? "scaleX(-1) " : ""}rotate(${this.rotate || 0}deg)`;
    }
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
    const show = this.cropMode || !!this.crop;
    this.cropWrap.style.display = show ? "" : "none";
    this.cropWrap.style.pointerEvents = this.cropMode ? "" : "none";
    this.cropRect.classList.toggle("locked", !this.cropMode);
    this.cropBtn.classList.toggle("on", !!this.crop);
    this.aspectEl.style.display = this.cropMode ? "" : "none";
    if (this.crop && this.cropRect) {
      const c = this.crop;
      Object.assign(this.cropRect.style, {
        left: `${c.x * 100}%`, top: `${c.y * 100}%`,
        width: `${c.w * 100}%`, height: `${c.h * 100}%`,
      });
      const vw = this.item.width, vh = this.item.height;
      if (vw) {
        const [ow, oh] = outSize({ ...this.item, crop: c, rotate: 0,
                                   resize: this.resize });
        this.cropInfo.textContent = `${ow} \u00d7 ${oh}`;
      } else this.cropInfo.textContent = "";
    } else if (this.isStill && this.item.width) {
      const [ow, oh] = outSize({ ...this.item, crop: null, rotate: 0,
                                 resize: this.resize });
      this.cropInfo.textContent = `${ow} \u00d7 ${oh}`;
    } else this.cropInfo.textContent = "";
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
      const resp = await api.fetchApi("/minimax_h3/extract_audio", {
        method: "POST",
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

    const chips = [2, 3].map((secs) =>
      this.dur > secs ? el("button", { class: "mml-btn mml-sm",
        title: `Use only the final ${secs} seconds`,
        onclick: () => { this.start = this.dur - secs; this.end = this.dur;
          this.seek(this.start); this.layoutTimeline(); } },
        `last ${secs}s`) : null);

    const still = this.isStill;
    this.overlay = el("div", { class: "mml-tmover",
      onmousedown: (e) => { if (e.target === this.overlay) this.close(); } },
      el("div", { class: "mml-tmmodal" + (isVid || still ? "" : " audio") },
        el("div", { class: "mml-tmhead" },
          el("span", { class: "mml-tmtitle" },
            `${still ? "\u25a3" : "\u2702"} ${this.item.name}`),
          (isVid || still) ? this.cropUI : null,
          el("button", { class: "mml-x", onclick: () => this.close() }, "\u2715")),
        stage,
        still ? null : this.buildTimeline(),
        still ? null : el("div", { class: "mml-tmfoot" },
          el("button", { class: "mml-btn mml-sm", title: "Previous frame (\u2190)",
            onclick: () => this.seek((this.media?.currentTime || 0) -
              1 / (this.item.fps || TRIM_FPS)) }, "\u25c0|"),
          this.playBtn,
          this.muteBtn,
          el("button", { class: "mml-btn mml-sm", title: "Next frame (\u2192)",
            onclick: () => this.seek((this.media?.currentTime || 0) +
              1 / (this.item.fps || TRIM_FPS)) }, "|\u25b6"),
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
            "Last \u23ed")),
        el("div", { class: "mml-tmfoot act" },
          ...(still ? [] : chips),
          (isVid && !still) ? el("button", { class: "mml-btn mml-sm",
            title: "Add the frame shown above as a picture reference  ( C )",
            onclick: () => this.captureFrame() }, "\u{1F4F7} Use frame") : null,
          (!still && (this.item.kind === "audio" || this.item.has_audio))
            ? el("button", { class: "mml-btn mml-sm",
                title: "Save the kept range as its own audio reference  ( A )",
                onclick: () => this.useAudio() }, "\u{1F3B5} Use audio")
            : null,
          el("span", { class: "mml-tmspace" }),
          (this.item.trim || this.item.crop)
            ? el("button", { class: "mml-btn mml-sm",
                title: "Whole clip, no crop",
                onclick: () => { this.start = 0; this.end = this.dur;
                  this.crop = null; this.cropMode = false; this.mirror = false;
                  this.rotate = 0; this.resize = 0;
                  if (this.sizeEl) this.sizeEl.value = "0";
                  this.syncCrop(); this.syncMirror(); this.syncRotate();
                  this.layoutTimeline(); } },
                "\u21ba Reset")
            : null,
          el("button", { class: "mml-btn mml-sm primary",
            onclick: () => this.apply() }, "Apply"),
          el("button", { class: "mml-btn mml-sm",
            onclick: () => this.close() }, "Cancel")),
        this.note,
        still ? el("div", { class: "mml-tmkeys" },
          "Drag a box to crop \u00b7 \u25a3 toggles editing \u00b7 esc closes")
        : el("div", { class: "mml-tmkeys" },
          "\u2190 \u2192 step a frame (shift = 10) \u00b7 space play \u00b7 " +
          "[ ] set start/end here \u00b7 home/end jump \u00b7 M mute \u00b7 A use audio" +
          (isVid ? " \u00b7 C capture frame" : ""))));
    if (still) {
      this.cropMode = true;
      if (!this.crop) this.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    }
    this.syncCrop();
    this.syncMirror();
    this.syncRotate();
    if (!still) this.seek(this.start, false);
  }
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
    const ro = new ResizeObserver(place);
    ro.observe(img.parentElement || img);
  }
}

/** Keep an overlay box glued to the drawn media, now and on every resize. */
function fitToMedia(mediaEl, boxEl, natW, natH) {
  const place = () => {
    const d = drawnBox(mediaEl, natW, natH);
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
    const ro = new ResizeObserver(place);
    ro.observe(mediaEl);
    return () => ro.disconnect();
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

/** "1290\u00d7720 \u00b7 16:9", "\u224816:9" when close, or a plain decimal
 *  when no standard ratio is near enough to name honestly. */
function dimsLabel(w, h) {
  if (!w || !h) return "";
  const n = nearestAspect(w, h);
  if (n.err > 0.10) return `${w}\u00d7${h} \u00b7 ${decimalRatio(w, h)}`;
  return `${w}\u00d7${h} \u00b7 ${n.err <= 0.005 ? "" : "\u2248"}${n.a}:${n.b}`;
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
      .catch(() => ({ video: true, av: false, ffmpeg: false }));
  }
  return capsPromise;
}

async function presetApi(path, body) {
  const opts = body
    ? { method: "POST", body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" } }
    : {};
  const resp = await api.fetchApi("/minimax_h3/presets" + path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `request failed (${resp.status})`);
  return data;
}

async function uploadFile(file) {
  const body = new FormData();
  body.append("file", file, file.name);
  const resp = await api.fetchApi("/minimax_h3/upload", { method: "POST", body });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `upload failed (${resp.status})`);
  return data;
}

/* --------------------------------------------------------------- panel */

class LoaderPanel {
  constructor(node) {
    this.node = node;
    (node._mmlPanels = node._mmlPanels || []).push(this);
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
  }

  async refreshPresets() {
    try {
      const data = await presetApi("");
      this.presets = data.presets || [];
      this.render();
    } catch (e) { /* routes unavailable; the row stays empty */ }
  }

  async savePreset(name) {
    if (!this.items.length) {
      this.say("Nothing loaded to save.", true); this.render(); return;
    }
    if (!name) { this.say("Give the preset a name.", true); this.render(); return; }
    try {
      const res = await presetApi("/save", { name, items: this.items });
      this.presetName = res.name;
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
    try {
      const v = JSON.parse(this.widget()?.value || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  commit() {
    const w = this.widget();
    if (w) w.value = JSON.stringify(this.items);
    try { this.node.setDirtyCanvas?.(true, true); } catch (e) { /* Vue redraws itself */ }
    this.render();
    // A modal and the on-node panel can be open at once; keep both current.
    (this.node._mmlPanels || []).forEach((p) => {
      if (p !== this) { p.items = p.read(); p.render(); }
    });
  }

  count(kind) { return this.items.filter((i) => i.kind === kind).length; }

  /** Video decode detail. Stored per item; the picker sets them together. */
  detail() {
    const v = this.items.find((i) => i.kind === "video" && i.detail);
    return v ? v.detail : "high";
  }

  setDetail(value) {
    for (const i of this.items) if (i.kind === "video") i.detail = value;
    const caps = { full: "source size", high: "1280px", standard: "960px",
                   low: "640px" };
    this.say(`Reference video decodes at ${caps[value] || value} on the long ` +
      "edge. Lower uses less RAM; the model rescales references anyway.");
    this.commit();
  }

  say(text, isError) {
    this.msg = text || "";
    this.msgErr = !!isError;
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
        this.say("Videos need PyAV or ffmpeg on the server.", true);
        continue;
      }
      this.busy += 1; this.render();
      try {
        const info = await uploadFile(file);
        // Don't spend an audio clip the budget can't cover — the soundtrack
        // stays available, just switched off until room is made.
        const budgetFull = audioCount(this.items) >= MAX.audio;
        const pairable = info.kind === "video" && info.has_audio;
        const detail = this.detail();
        this.items.push({
          ...(info.kind === "video" ? { detail } : {}),
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
    const active = (item.trim && (item.trim.start || item.trim.end))
      || item.crop || item.mirror || item.rotate;
    const what = [];
    if (item.crop) what.push("cropped");
    if (item.rotate) what.push(`${item.rotate}\u00b0`);
    if (item.resize) what.push(`max ${item.resize}px`);
    if (item.mirror) what.push("mirrored");
    if (item.trim && (item.trim.start || item.trim.end)) what.push(fmtSpan(item));
    return el("span", {
      class: "mml-trimbtn" + (active ? " on" : ""),
      title: active ? `${what.join(", ")} \u2014 click to edit`
        : (still ? "Crop or mirror this picture"
                 : "Use only part of this clip"),
      onclick: (e) => {
        e.stopPropagation();
        new TrimModal(this, item);
      },
    }, still ? "\u25a3" : "\u2702");
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
    item.enabled = item.enabled === false;
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
    this.items = this.items.filter((i) => i !== item);
    this.commit();
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
    this.players.forEach((p) => p.stop());
    this.players = [];

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
      (this.count("video") ? el("select", { class: "mml-detail",
        title: "How much detail to decode from reference video.\n" +
               "The model rescales references to your generation size anyway, " +
               "so lower settings mainly save RAM.",
        onchange: (e) => this.setDetail(e.target.value) },
        [["high", "detail: high"], ["standard", "detail: standard"],
         ["low", "detail: low"], ["full", "detail: full"]].map(([v, label]) =>
          el("option", { value: v, selected: this.detail() === v }, label)))
        : null),
      this.items.length
        ? el("button", { class: "mml-btn mml-sm",
            title: "Remove every loaded reference from this node",
            onclick: () => { this.unloadPrompt = true; this.render(); } },
            "Unload media")
        : null,
      el("span", { class: "mml-count" + (total > MAX.total ? " over" : "") },
        `${total} / ${MAX.total}`),
      el("span", { class: "mml-count" + (audioCount(this.items) > MAX.audio ? " over" : ""),
        style: { marginLeft: "6px" },
        title: "Audio clips in play, including split video soundtracks" },
        `\u266a ${audioCount(this.items)}/${MAX.audio}`)));

    const select = el("select", { class: "mml-preset",
      title: "Load a saved reference set",
      onchange: (e) => { const v = e.target.value; if (v) this.loadPreset(v); } },
      el("option", { value: "" }, this.presets.length
        ? "load preset\u2026" : "no presets saved"),
      this.presets.map((n) =>
        el("option", { value: n, selected: n === this.presetName }, n)));
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
      const go = () => this.savePreset(input.value.trim());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") go();
        if (e.key === "Escape") { this.presetPrompt = null; this.render(); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      kids.push(el("div", { class: "mml-presetrow" },
        el("span", { class: "mml-presetlbl" }, "save as"), input,
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

    kids.push(el("div", { class: "mml-msg" + (this.msgErr || problems.length ? " err" : "") },
      problems.length ? problems[0] : this.msg));

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
          const [ow, oh] = outSize(it);
          const badge = el("span", { class: "mml-dims" + (it.crop ? " cut" : "") },
            dimsLabel(ow, oh));
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
            marquee = el("div", { class: "mml-cropfit",
              style: (it.mirror || turn)
                ? { transform: `${it.mirror ? "scaleX(-1) " : ""}rotate(${turn}deg)` }
                : {} }, box);
            // Fit against the post-rotation shape: a quarter turn swaps the
            // sides the drawn image occupies.
            requestAnimationFrame(() => fitToMedia(
              img, box,
              quarter ? it.height : it.width,
              quarter ? it.width : it.height));
            if (quarter) requestAnimationFrame(() => fitTurned(img));
          }
          const turn = ((parseInt(it.rotate, 10) || 0) % 360 + 360) % 360;
          const quarter = turn === 90 || turn === 270;
          const img = el("img", { class: "mml-pic" + (quarter ? " turned" : ""),
            src: viewURL(it.file),
            style: (it.mirror || turn)
              ? { transform: `${it.mirror ? "scaleX(-1) " : ""}rotate(${turn}deg)` }
              : {},
            title: dimsTitle(it.name, it.width, it.height)
              + (turn ? `\nrotated ${turn}\u00b0` : "")
              + (it.crop ? `\ncropped to ${ow}\u00d7${oh}` : "")
              + (it.mirror ? "\nmirrored" : ""),
            onload: () => {
              // Items from before dimensions were stored learn them here.
              if (!it.width && img.naturalWidth) {
                it.width = img.naturalWidth;
                it.height = img.naturalHeight;
                const [nw, nh] = outSize(it);
                badge.textContent = dimsLabel(nw, nh);
                img.title = dimsTitle(it.name, it.width, it.height);
                this.commit();
              }
            },
            onclick: () => lightbox(it, tags.get(it) || "") });
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
      const row = el("div", { class: "mml-row" },
        this.powerBtn(it),
        el("video", { class: "mml-vthumb",
          style: it.mirror ? { transform: "scaleX(-1)" } : {},
          onloadedmetadata: (e) => {
            const t = it.trim;
            if (t && t.start) try { e.target.currentTime = t.start; } catch (_) {}
          }, src: viewURL(it.file), muted: true,
          preload: "metadata",
          onmouseenter: (e) => e.target.play().catch(() => {}),
          onmouseleave: (e) => e.target.pause(),
          onclick: () => lightbox(it, tags.get(it) || "") }),
        el("div", { class: "mml-meta" },
          el("div", { class: "mml-tag vid" },
            isOn(it) ? (tags.get(it) || "").slice(1, -1) : "off"),
          el("div", { class: "mml-name", title: it.name }, it.name)));
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
      const vcell = el("div", { class: "mml-slot filled vid" + (isOn(it) ? "" : " off") },
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
    kids.push(el("div", { class: "mml-order" },
      el("b", {}, "tag order sent to the model"),
      el("div", {}, order.length ? order.join(" \u00b7 ") : "nothing loaded yet")));

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
  node.connect(0, sp, 0);
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* Vue redraws */ }
  flash("Splitter added \u2014 wire its slots to MiniMaxH3ReferenceToVideo");
  return sp;
}

export function openLoaderModal(node) {
  injectCSS();
  const panel = new LoaderPanel(node);
  const close = () => {
    node._mmlPanels = (node._mmlPanels || []).filter((p) => p !== panel);
    panel.players.forEach((p) => p.stop());
    overlay.remove();
    window.removeEventListener("keydown", esc);
    node._mmlPanel?.render();
  };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const overlay = el("div", { class: "mml-overlay",
    onmousedown: (e) => { if (e.target === overlay) close(); } },
    el("div", { class: "mml-modal" },
      el("div", { class: "mml-modalhead" }, "MiniMax H3 Media Loader",
        el("button", { title: "Close", onclick: close }, "\u2715")),
      el("div", { class: "mml-modalbody" }, panel.root)));
  window.addEventListener("keydown", esc);
  document.body.append(overlay);
  return panel;
}

/* ------------------------------------------------------------ extension */

app.registerExtension({
  name: "MiniMaxH3.MediaLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== LOADER_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
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
      applyCanvasSizing(this, widget, NODE_W, PANEL_H);
      return r;
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
        applyCanvasSizing(this, this.widgets?.find((w) => w.name === "mml_panel"),
          NODE_W, PANEL_H);
      }, 0);
      return r;
    };
  },
});
