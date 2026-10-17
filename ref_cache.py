"""Experimental: reuse the reference rows of H3's packed sequence between
sampling steps.

Each step H3 runs one sequence, [prompt | references | audio | video], with
full attention, and reads only the audio and video rows at the end. The rest
are there to be attended to. On a refresh step every block runs as usual and
its input for the cached rows is copied to RAM. On the steps between, each
block runs on the other rows alone: the cached rows' keys and values are
rebuilt from that copy, so they skip their attention queries, output
projection and MLP. Between refreshes the cached rows don't see the video
change, which is the approximation this node exists to test.
"""

import torch

import comfy.ldm.minimax.model
import comfy.model_management as mm
import comfy.patcher_extension
import comfy.quant_ops
from comfy.ldm.minimax.model import _mod_scale_shift
from comfy.ldm.modules.attention import AttentionTensorContainer, optimized_attention

from .refmod_nodes import CATEGORY

# segment kinds of H3's packed layout that each choice caches
ROWS = {"references": ("cond", "cond_audio", "ref_img", "ref_audio"),
        "references and prompt": ("text", "cond", "cond_audio", "ref_img", "ref_audio")}
FP8 = torch.float8_e4m3fn
FP8_MAX = torch.finfo(FP8).max


def cached_span(layout, kinds):
    """The contiguous [start, stop) of the layout's rows of `kinds`, or None
    when there are none or they aren't contiguous."""
    inside = [(a, b) for a, b, kind in layout.segments if kind in kinds]
    if not inside:
        return None
    c0, c1 = inside[0][0], inside[-1][1]
    if any(kind not in kinds for a, b, kind in layout.segments if a < c1 and b > c0):
        return None
    return c0, c1


def split_segments(segments, c0, c1):
    """mod_segments for the rows outside [c0, c1) closed up, and for the rows inside it."""
    n = c1 - c0
    outside = [(a, b, row) if b <= c0 else (a - n, b - n, row) for a, b, row in segments if b <= c0 or a >= c1]
    inside = [(a - c0, b - c0, row) for a, b, row in segments if a >= c0 and b <= c1]
    return outside, inside


def qkv(attn, x, rope):
    """H3's attention projection, q/k norm and rope for rows `x`, as Attention.forward does it."""
    s = x.shape[0]
    q, k, v = attn.qkv_proj(x).split(attn.heads * attn.head_dim, dim=-1)
    q = q.view(1, s, attn.heads, attn.head_dim)
    k = k.view(1, s, attn.heads, attn.head_dim)
    qw = mm.cast_to(attn.q_norm.weight, device=x.device)
    kw = mm.cast_to(attn.k_norm.weight, device=x.device)
    comfy.quant_ops.ck.rms_rope_split_half_(q, k, rope, qw, kw, epsilon=attn.q_norm.eps, rot_dim=rope.shape[-3] * 2)
    return q[0], k[0], v.view(s, attn.heads, attn.head_dim)


class CachedRowsAttention:
    """Stands in for a block's attention: its rows attend to themselves and
    to the cached rows, which arrive normed and modulated. Both go through one
    projection, so the keys and values come out of a single buffer as in a
    normal block, and nothing else holds them once the backend takes them."""

    def __init__(self, attn, cached, rope):
        self.attn, self.cached, self.rope = attn, cached, rope

    def __call__(self, x, rope_freqs=None, transformer_options={}):
        attn = self.attn
        s = x.shape[0]
        x = torch.cat([x, self.cached])
        self.cached = None
        q, k, v = qkv(attn, x, torch.cat([rope_freqs, self.rope], dim=1))
        del x
        q = AttentionTensorContainer(q[:s].transpose(0, 1).unsqueeze(0))
        k = AttentionTensorContainer(k.transpose(0, 1).unsqueeze(0))
        v = AttentionTensorContainer(v.transpose(0, 1).unsqueeze(0))
        out = optimized_attention(q, k, v, attn.heads, preferred_attention=attn.comfy_attention, mask=None,
                                  skip_reshape=True, transformer_options=transformer_options)
        return attn.out_proj(out.squeeze(0))


def keep(src, buf, fp8):
    """`src` copied into CPU buffers: as is, or as 8-bit floats with a scale
    per row. The rows are pinned when ComfyUI's budget has room without
    evicting the model's own pinned weights; the small scales aren't, as CUDA
    can't register two buffers sharing a page."""
    if fp8:
        scale = (src.abs().amax(dim=-1, keepdim=True).float().clamp(min=1e-12) / FP8_MAX).to(src.dtype)
        parts = ((src / scale).clamp_(-FP8_MAX, FP8_MAX).to(FP8), scale)
    else:
        parts = (src,)
    if buf is None or [(b.shape, b.dtype) for b in buf] != [(p.shape, p.dtype) for p in parts]:
        release(buf)
        buf = tuple(torch.empty(p.shape, dtype=p.dtype, device="cpu") for p in parts)
        mm.pin_memory(buf[0], evict_active=False)
    for b, p in zip(buf, parts):
        b.copy_(p, non_blocking=b.is_pinned())
    return buf


def restore(buf, device, dtype):
    if len(buf) == 1:
        return buf[0].to(device, non_blocking=True)
    q, scale = (b.to(device, non_blocking=True) for b in buf)
    return q.to(dtype) * scale


def release(buf):
    for b in buf or ():
        if b.is_pinned():
            mm.unpin_memory(b)


class MiniMaxH3FantasticReferenceCache:
    DESCRIPTION = ("EXPERIMENTAL. Speeds up H3 sampling with RefMods or reference media by reusing the reference "
                   "rows between steps instead of running them through every block each step. Between refreshes "
                   "the references don't see the video change, so results differ from a normal run. Bypass the "
                   "node to compare.")
    CATEGORY = CATEGORY
    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL", {"tooltip": "The H3 model, between its loader and the sampler."}),
            "cache": (list(ROWS), {"default": "references",
                "tooltip": "references: RefMods and reference media. references and prompt: also the prompt and "
                           "what the text encoder was shown, which can be as many tokens as the references; more "
                           "speed, more approximation."}),
            "refresh_every": ("INT", {"default": 2, "min": 2, "max": 16,
                "tooltip": "Run the cached rows in full on the first model call and every this many after it. "
                           "Higher is faster and drifts further from a normal run."}),
            "store_8bit": ("BOOLEAN", {"default": False,
                "tooltip": "Keep the cached rows as 8-bit floats with a scale per row: half the RAM and half the "
                           "copying, with values typically 2-3% off between refreshes. Any GPU ComfyUI can store "
                           "fp8 weights on; not Apple (MPS) or DirectML."}),
        }}

    def patch(self, model, cache, refresh_every, store_8bit):
        dit = model.get_model_object("diffusion_model")
        if not isinstance(dit, comfy.ldm.minimax.model.MiniMaxH3Model):
            raise ValueError("Connect a MiniMax H3 model.")
        if store_8bit and not mm.supports_cast(model.load_device, FP8):
            raise ValueError("This device can't store 8-bit floats: turn store_8bit off.")
        kinds = ROWS[cache]
        runs = {}           # per layout (one per conditioning) for the sampling run under way
        m = model.clone()
        earlier = m.model_options.get("transformer_options", {}).get("patches_replace", {}).get("dit", {})

        def block(args, extra):
            layout, opts = args["layout"], args["transformer_options"]
            i = opts["block_index"]
            if i == 0 and id(layout) not in runs:
                runs[id(layout)] = {"span": cached_span(layout, kinds), "calls": 0, "inputs": {}}
            run = runs[id(layout)]
            if i == 0:
                run["calls"] += 1
            span = run["span"]
            h = args["img"]
            stored = run["inputs"].get(i)
            if span is None or mm.in_training or stored is None or (run["calls"] - 1) % refresh_every == 0:
                if span is not None and not mm.in_training:
                    run["inputs"][i] = keep(h[span[0]:span[1]], stored, store_8bit)
                    if i == 0 and run["calls"] == 1:
                        size = len(dit.blocks) * sum(b.nbytes for b in run["inputs"][0]) / 2 ** 30
                        print(f"[Fantastic H3 Reference Cache] caching {span[1] - span[0]:,} of {h.shape[0]:,} rows "
                              f"({cache}, {8 if store_8bit else 16}-bit), refreshed every {refresh_every} calls: "
                              f"{size:.1f} GB of RAM" + ("" if run["inputs"][0][0].is_pinned() else ", not pinned (slower)"))
                prev = earlier.get(("double_block", i))
                return prev(args, extra) if prev else extra["original_block"](args)

            c0, c1 = span
            n = c1 - c0
            blk = dit.blocks[i]
            outside, inside = split_segments(args["mod_segments"], c0, c1)
            rope = args["rope_freqs"]
            shift, scale = blk.adaln_proj(args["t_emb"])[:2]
            cached = _mod_scale_shift(blk.norm1(restore(stored, h.device, h.dtype)), shift, scale, inside)
            # The rows that run must be one contiguous tensor. Rather than copy
            # them all, the prompt rows (when they run) move up against the
            # targets, over the cached rows' slot, and move back afterwards.
            if c0:
                h[n:c1] = h[:c0].clone()
            rows = h[n:]
            out = extra["original_block"]({**args, "img": rows, "mod_segments": outside,
                                           "rope_freqs": torch.cat([rope[:, :c0], rope[:, c1:]], dim=1),
                                           "attention": CachedRowsAttention(blk.attn, cached, rope[:, c0:c1])})["img"]
            del cached
            if out is not rows:
                rows.copy_(out)
            if c0:
                h[:c0] = h[n:c1].clone()
            return {"img": h}

        def sample(executor, *args, **kwargs):
            try:
                return executor(*args, **kwargs)
            finally:
                for run in runs.values():
                    for buf in run["inputs"].values():
                        release(buf)
                runs.clear()

        for i in range(len(dit.blocks)):
            m.set_model_patch_replace(block, "dit", "double_block", i)
        m.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.OUTER_SAMPLE, "mmh3_reference_cache", sample)
        return (m,)


NODE_CLASS_MAPPINGS = {"MiniMaxH3FantasticReferenceCache": MiniMaxH3FantasticReferenceCache}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3FantasticReferenceCache": "Fantastic H3 Reference Cache (experimental)"}
