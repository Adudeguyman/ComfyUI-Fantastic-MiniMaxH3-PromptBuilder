from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Registers the upload / probe / capabilities routes when running inside
# ComfyUI. Import failures here must never take the nodes down with them.
try:
    from . import web_api  # noqa: F401
except Exception as exc:  # pragma: no cover
    print(f"[MiniMaxH3] media loader routes unavailable: {exc}")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
