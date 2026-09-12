from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# The RefMod Stack is optional on top of the core nodes: a failure here
# should cost that one node, not the builder and loader.
try:
    from . import refmods, refmod_nodes, refmod_create, refmod_inspect, refmod_edit
    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **refmods.NODE_CLASS_MAPPINGS,
                           **refmod_nodes.NODE_CLASS_MAPPINGS,
                           **refmod_create.NODE_CLASS_MAPPINGS,
                           **refmod_inspect.NODE_CLASS_MAPPINGS,
                           **refmod_edit.NODE_CLASS_MAPPINGS}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS,
                                  **refmods.NODE_DISPLAY_NAME_MAPPINGS,
                                  **refmod_nodes.NODE_DISPLAY_NAME_MAPPINGS,
                                  **refmod_create.NODE_DISPLAY_NAME_MAPPINGS,
                                  **refmod_inspect.NODE_DISPLAY_NAME_MAPPINGS,
                                  **refmod_edit.NODE_DISPLAY_NAME_MAPPINGS}
except Exception as exc:  # pragma: no cover
    print(f"[MiniMaxH3] RefMod Stack unavailable: {exc}")

# Registers the upload / probe / capabilities routes when running inside
# ComfyUI. Import failures here must never take the nodes down with them.
try:
    from . import web_api  # noqa: F401
except Exception as exc:  # pragma: no cover
    print(f"[MiniMaxH3] media loader routes unavailable: {exc}")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
