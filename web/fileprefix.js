import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* Folder browser for MiniMax H3 Filename Prefix. Navigates the ComfyUI output
   directory server-side; the node itself only ever holds a relative path. */

const CSS = `
.mmfp-over{position:fixed;inset:0;background:rgba(8,10,14,.72);z-index:10060;
  display:flex;align-items:center;justify-content:center;}
.mmfp-modal{width:min(460px,92vw);max-height:80vh;background:#191c22;
  border:1px solid #303642;border-radius:10px;display:flex;flex-direction:column;
  overflow:hidden;font-family:system-ui,sans-serif;color:#d7dbe2;
  box-shadow:0 24px 64px rgba(0,0,0,.55);}
.mmfp-head{display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-bottom:1px solid #2a2f3a;background:#1b1f27;font-size:12px;}
.mmfp-crumb{flex:1;min-width:0;font-family:ui-monospace,monospace;font-size:11px;
  color:#7ea7d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mmfp-list{flex:1;overflow:auto;padding:4px 0;min-height:120px;}
.mmfp-row{display:flex;align-items:center;gap:8px;padding:6px 14px;
  font-size:12px;cursor:pointer;}
.mmfp-row:hover{background:#1d222b;}
.mmfp-row .i{color:#e0a94c;}
.mmfp-empty{padding:22px 14px;text-align:center;color:#6b7484;font-size:12px;}
.mmfp-foot{display:flex;align-items:center;gap:6px;padding:9px 12px;
  border-top:1px solid #2a2f3a;background:#1b1f27;flex-wrap:wrap;}
.mmfp-btn{background:#232833;color:#c9cfda;border:1px solid #333a45;
  border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;}
.mmfp-btn:hover{background:#2c3340;}
.mmfp-btn.primary{background:#1f4f7d;border-color:#3d7fbf;color:#dbeafe;}
.mmfp-space{flex:1;}
.mmfp-new{background:#12151b;color:#dde2ea;border:1px solid #2e3440;
  border-radius:6px;padding:4px 8px;font-size:11px;width:130px;}
.mmfp-new:focus{outline:none;border-color:#4a5568;}
.mmfp-err{padding:0 12px 8px;color:#f07070;font-size:11px;}
.mmfp-err:empty{display:none;}
`;

let cssDone = false;
function injectCSS() {
  if (cssDone) return;
  cssDone = true;
  const el = document.createElement("style");
  el.textContent = CSS;
  document.head.append(el);
}

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else {
      try { node[k] = v; } catch (e) { node.setAttribute(k, v); }
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

async function listDirs(path) {
  const resp = await api.fetchApi(
    `/minimax_h3/browse?path=${encodeURIComponent(path || "")}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `browse failed (${resp.status})`);
  return data;
}

function openBrowser(startPath, onPick) {
  injectCSS();
  let path = startPath || "";

  const crumb = el("div", { class: "mmfp-crumb" });
  const list = el("div", { class: "mmfp-list" });
  const err = el("div", { class: "mmfp-err" });
  const newName = el("input", { class: "mmfp-new", type: "text",
    placeholder: "New folder" });

  const close = () => {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey);

  async function show(next) {
    try {
      const data = await listDirs(next);
      path = data.path || "";
      err.textContent = "";
      crumb.textContent = "output/" + (path ? path + "/" : "");
      const rows = [];
      if (path) {
        rows.push(el("div", { class: "mmfp-row",
          onclick: () => show(path.split("/").slice(0, -1).join("/")) },
          el("span", { class: "i" }, "\u21b0"), ".."));
      }
      for (const d of data.dirs) {
        rows.push(el("div", { class: "mmfp-row",
          onclick: () => show(path ? `${path}/${d}` : d) },
          el("span", { class: "i" }, "\u{1F4C1}"), d));
      }
      list.replaceChildren(...(rows.length ? rows
        : [el("div", { class: "mmfp-empty" }, "No subfolders here.")]));
    } catch (e) {
      err.textContent = e.message;
      list.replaceChildren(el("div", { class: "mmfp-empty" },
        "Couldn't read that folder."));
    }
  }

  const create = async () => {
    const name = newName.value.trim();
    if (!name) { newName.focus(); return; }
    try {
      const resp = await api.fetchApi("/minimax_h3/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, name }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "could not create");
      newName.value = "";
      show(path ? `${path}/${data.created}` : data.created);
    } catch (e) { err.textContent = e.message; }
  };
  newName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.stopPropagation(); create(); }
    if (e.key === "Escape") { e.stopPropagation(); newName.value = ""; }
  });

  const overlay = el("div", { class: "mmfp-over",
    onmousedown: (e) => { if (e.target === overlay) close(); } },
    el("div", { class: "mmfp-modal" },
      el("div", { class: "mmfp-head" },
        el("span", {}, "\u{1F4C1} Output folder"), crumb,
        el("button", { class: "mmfp-btn", onclick: close }, "\u2715")),
      list, err,
      el("div", { class: "mmfp-foot" },
        newName,
        el("button", { class: "mmfp-btn", onclick: create }, "Create"),
        el("span", { class: "mmfp-space" }),
        el("button", { class: "mmfp-btn primary",
          onclick: () => { onPick(path); close(); } }, "Use this folder"),
        el("button", { class: "mmfp-btn", onclick: close }, "Cancel"))));

  document.body.append(overlay);
  show(path);
}

app.registerExtension({
  name: "MiniMaxH3.FilenamePrefix",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "MiniMaxH3FilenamePrefix") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      const folder = this.widgets?.find((w) => w.name === "folder");
      this.addWidget("button", "\u{1F4C1} Browse\u2026", null, () => {
        openBrowser(folder?.value || "", (picked) => {
          if (folder) {
            folder.value = picked;
            folder.callback?.(picked);
            this.setDirtyCanvas(true, true);
          }
        });
      });
      return r;
    };
  },
});
