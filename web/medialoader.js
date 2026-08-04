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

/* ---------------------------------------------------------------- utils */

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in e) e[k] = v;
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
.mml-count{margin-left:auto;font-size:10px;color:#8a93a3;font-family:ui-monospace,monospace;}
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

.mml-pic{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
  display:block;cursor:zoom-in;background:#0d1015;}
.mml-picbar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;
  gap:4px;padding:1px 4px;background:rgba(10,12,16,.82);min-width:0;overflow:hidden;}
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

function lightbox(item, tag) {
  const url = viewURL(item.file);
  const media = item.kind === "video"
    ? el("video", { src: url, controls: true, autoplay: true, loop: true })
    : el("img", { src: url });
  const overlay = el("div", { class: "mml-light",
    onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    el("div", { class: "mml-lightbox" }, media,
      el("div", { class: "mml-lightcap" },
        el("span", { class: `mml-tag ${tag.startsWith("<Video") ? "vid" : "pic"}` }, tag),
        el("span", {}, item.name),
        el("button", { class: "mml-btn", style: { marginLeft: "auto" },
          onclick: () => overlay.remove() }, "Close"))));
  const esc = (e) => {
    if (e.key === "Escape") { overlay.remove(); window.removeEventListener("keydown", esc); }
  };
  window.addEventListener("keydown", esc);
  document.body.append(overlay);
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
      if (guess === "video" && !caps.video) {
        this.say("Videos need PyAV or ffmpeg on the server.", true);
        continue;
      }
      this.busy += 1; this.render();
      try {
        const info = await uploadFile(file);
        this.items.push({
          kind: info.kind,
          file: info.file,
          name: info.original || info.name,
          duration: info.duration ?? null,
          has_audio: !!info.has_audio,
          audio_mode: info.kind === "video" && info.has_audio ? "paired" : "off",
        });
      } catch (err) {
        this.say(`${file.name}: ${err.message}`, true);
      } finally {
        this.busy -= 1;
      }
    }
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
      el("span", { class: "mml-count" + (total > MAX.total ? " over" : "") },
        `${total} / ${MAX.total}`)));

    const select = el("select", { class: "mml-preset",
      title: "Load a saved reference set",
      onchange: (e) => { const v = e.target.value; if (v) this.loadPreset(v); } },
      el("option", { value: "" }, this.presets.length
        ? "load preset\u2026" : "no presets saved"),
      this.presets.map((n) =>
        el("option", { value: n, selected: n === this.presetName }, n)));
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

    kids.push(el("div", { class: "mml-msg" + (this.msgErr ? " err" : "") },
      total > MAX.total
        ? `Over the ${MAX.total}-file limit — remove ${total - MAX.total}.`
        : this.msg));

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
        el("img", { class: "mml-pic", src: viewURL(it.file), title: it.name,
          onclick: () => lightbox(it, tags.get(it) || "") }),
        el("div", { class: "mml-picbar" },
          this.powerBtn(it),
          el("span", { class: "mml-tag pic" }, isOn(it) ? tag : "off"),
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
        el("video", { class: "mml-vthumb", src: viewURL(it.file), muted: true,
          preload: "metadata",
          onmouseenter: (e) => e.target.play().catch(() => {}),
          onmouseleave: (e) => e.target.pause(),
          onclick: () => lightbox(it, tags.get(it) || "") }),
        el("div", { class: "mml-meta" },
          el("div", { class: "mml-tag vid" },
            isOn(it) ? (tags.get(it) || "").slice(1, -1) : "off"),
          el("div", { class: "mml-name", title: it.name }, it.name)));
      if (it.has_audio && isOn(it)) {
        row.append(
          el("span", { class: "mml-seg" },
            ["off", "paired", "alone"].map((label) => {
              const m = label === "alone" ? "standalone" : label;
              return el("button", { class: m === mode ? "on" : "",
                title: m === "paired"
                  ? "Soundtrack pairs with this video, labelled just before it"
                  : m === "standalone"
                    ? "Soundtrack becomes a separate reference, numbered after the videos"
                    : "Ignore this video's audio",
                onclick: () => { it.audio_mode = m; this.commit(); } }, label);
            })),
          el("span", { class: "mml-tag aud" },
            mode === "off" ? "\u2014" : (splitTag || "").slice(1, -1)));
      }
      row.append(
        el("span", { class: "mml-drag", title: "Drag to reorder" }, "\u2630"),
        el("span", { class: "mml-x", title: "Remove",
          onclick: () => this.remove(it) }, "\u2715"));
      vidCells.push(this.reorderable(
        el("div", { class: "mml-slot filled vid" + (isOn(it) ? "" : " off") },
          row), it));
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
      audCells.push(this.reorderable(el("div",
        { class: "mml-slot filled aud" + (isOn(it) ? "" : " off") },
        el("div", { class: "mml-row" },
          this.powerBtn(it),
          player.btn,
          el("div", { class: "mml-meta", style: { flex: "0 0 auto", maxWidth: "38%" } },
            el("div", { class: "mml-tag aud" },
              isOn(it) ? (tags.get(it) || "").slice(1, -1) : "off"),
            el("div", { class: "mml-name", title: it.name }, it.name)),
          player.bar, player.time,
          el("span", { class: "mml-drag", title: "Drag to reorder" }, "\u2630"),
          el("span", { class: "mml-x", title: "Remove",
            onclick: () => this.remove(it) }, "\u2715"))), it));
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
