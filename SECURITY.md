# Security

How this pack keeps a ComfyUI install safe from the two things a custom
node can expose: HTTP routes on the shared PromptServer, and free-text
widgets that turn into paths. Written for a reviewer; every claim names the
function that enforces it. Re-read against the code before each release.

## Routes: who may fire a side effect

Every state-changing route (all POSTs) runs behind one decorator,
`_guard()` in `web_api.py`, which applies three checks in this order and
refuses before the handler runs:

| Check | Refusal | What it stops |
|---|---|---|
| Cross-site: `Sec-Fetch-Site` is authoritative when a browser sends it — only `same-origin` and `none` pass; otherwise `Origin` must name the same host and port as `Host` (`_same_authority`), and `Origin: null` is refused | `403` | CSRF from any other origin, including under `--enable-cors-header` |
| Session token: `X-MiniMaxH3-Token` must equal a token minted once per server process with `secrets.token_urlsafe` and compared with `hmac.compare_digest` | `403` with `token_required` | any caller that did not first read the token from this origin — every cross-site page, curl without the header, and a stale editor after a server restart (the frontend re-fetches and retries once) |
| Content type: JSON routes require `Content-Type: application/json` | `415` | "simple" cross-origin requests; the header forces a CORS preflight that these routes never approve |

The multipart routes (`/minimax_h3/upload`, `/minimax_h3/refmods/set_preview`)
use `_guard(json_only=False)`: `multipart/form-data` is CORS-simple and
cannot carry the content-type requirement, which is exactly why the other
two checks are there.

The token is handed out only by `GET /minimax_h3/token`, which applies the
same cross-site check and answers with `Cache-Control: no-store`. It appears
in exactly three places: minted, compared, and that GET. It is never logged
and never included in any other response.

Core's `create_origin_only_middleware` exists but is bypassed under
`--enable-cors-header` and does nothing without an `Origin` header, so the
checks above hold unconditionally rather than inheriting from it. The
Origin authority is parsed by hand (`_host_port`); anything that is not
`host[:port]` or `[ipv6]:port` parses as no host and is refused.

The frontend sends every POST through one helper, `postApi()` in
`web/medialoader.js`, which attaches the token. `grep -n 'method: "POST"' web/*.js`
shows that helper plus the calls that queue a workflow on core's own
`/prompt` route (RefMod Create, Edit and Inspect run through the queue like
any workflow; nothing in this pack encodes or writes from a request thread).

## GET has no side effect

Every GET only reads:

| Route | What it does |
|---|---|
| `/minimax_h3/token` | returns the token (same-origin only) |
| `/minimax_h3/browse` | lists folders under ComfyUI's output directory; the path is resolved with `os.path.realpath` and refused if it leaves that root (`_safe_dir`) |
| `/minimax_h3/capabilities` | reports which decoders are available |
| `/minimax_h3/refmods` | scans the RefMod folders' file headers (`refmods.scan_library`) |
| `/minimax_h3/refmods/preview` | serves the image beside a RefMod — only a name that `refmods.resolve_file` resolves inside a RefMod root, and only with a `.png/.jpg/.jpeg/.webp` extension |
| `/minimax_h3/presets`, `/prompts`, `/phrases`, `/drafts` | list or count saved JSON |

No GET creates a directory, writes, deletes or loads a model.

## Containment: where a write may land

Every path a request or a widget can influence is resolved with
`os.path.realpath` and tested with `os.path.commonpath` (or an equivalent
`root + os.sep` prefix test on the realpath) against its root. Path checks
raise or refuse rather than redirecting a request somewhere else; where a
name is first reduced to a safe character set (`sanitize_name`, `_slug`,
`_safe`), the reduced name is still checked against its root before use.

| Surface | Root | Enforced by |
|---|---|---|
| Uploaded media (`/minimax_h3/upload`) | `input/minimax_h3/` | basename only via `_safe()`, extension allow-list (`IMAGE_EXT`/`VIDEO_EXT`/`AUDIO_EXT`), unique name, written to a temp name then `os.replace` |
| Media file names carried in the Media Loader's `media_state` widget, preset files, and every route that reads media | ComfyUI's input, output and temp directories | `media_io.resolve()` — core's `get_annotated_filepath` plus an independent realpath prefix check; raises, no fallback join |
| Prompt library, presets, phrases, drafts | the pack's own folders under the user directory | `_slug()`/`_preset_path()` reduce names to one safe path component; `_contained()` re-checks the realpath beside each write and delete |
| Output folder picker (`/minimax_h3/mkdir`) | ComfyUI's output directory | realpath + prefix check, refused when outside |
| `filename_prefix` widget on the Filename Prefix node | ComfyUI's output directory | `_contain_prefix()` in `nodes.py`: `..` segments raise, drive letters and UNC prefixes are stripped, realpath + commonpath; core's save nodes check again |
| RefMod file names — the Stack's `stack_state` widget, the Inspect/Edit `file` widgets, the library routes | the registered `refmods` folders (`models/refmods` and `extra_model_paths.yaml` entries) | `refmods.resolve_file()`: relative names only, no `..` segment, realpath + commonpath per root, and only the requested extension |
| New RefMod names (`Create` `name`/`subfolder`, `Edit` `save_as`, `/refmods/rename`) | the first registered `refmods` folder | `sanitize_name()` + `valid_rel()` (no `..`, no absolute path, no hidden or reserved folder) and `_contained_target()` (realpath + commonpath); an existing file is never overwritten by a copy |
| RefMod curation (`/refmods/rename`, `/meta`, `/delete`, `/set_preview`) | the RefMod root that holds the named file | `item_files()` resolves every name through `resolve_file()`; moves go through `_contained_target()`; previews are written with an image extension only |
| Inspect's decoded previews | ComfyUI's temp directory, `minimax_h3_inspect/` | file names are generated (timestamp + hash), never taken from input |

RefMod files are `.safetensors` read with the safetensors library's loader,
which parses a fixed header format and never deserialises arbitrary
objects. Nothing in this pack uses PyTorch's general checkpoint loader or
any object-serialisation module.

## No programs started, no dynamic code

The pack starts no child process and never shells out. Video and audio are
decoded in-process through PyAV, which is a ComfyUI core dependency. No
runtime string is ever evaluated or compiled as code, modules are only
imported with ordinary import statements, and nothing patches ComfyUI or
other packs at runtime: the
optional lookup of ComfyUI-MiniMaxH3Mod (`refmods.origin_module`) reads a
class it registered with core's `NODE_CLASS_MAPPINGS` and only widens the
library scan to its folders.

## Model loading

No route loads a model. The RefMod Create, Edit and Inspect nodes take the
H3 VAEs as ordinary node inputs, so the executor owns every model load,
and the library dialog queues those nodes through core's `/prompt` route
like any workflow.

## Verification

Before each release:

- The tracked tree is swept for the registry scanner's patterns — URL and
  HTTP client libraries, child processes, dynamic imports, code evaluation,
  raw network calls, object deserialisation, foreign-function and
  bytecode modules — and must come back empty.
- Every route is listed with its method, guard and sink names; any POST
  without the guard, or any GET with a sink, is a defect.
- Every filesystem sink is listed with its enclosing function and traced to
  a guarded POST or a contained widget path.
- The origin parser is exercised with same-host, default-port, IPv6,
  userinfo, `null` and malformed authorities.

If you believe you have found a vulnerability, open an issue on the
repository or contact the maintainer through the GitHub profile.
