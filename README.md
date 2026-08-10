# ComfyUI Fantastic MiniMax H3 Prompt Builder

Guided prompt writing and reference-media handling for the open-weight
**MiniMax H3** video model in ComfyUI.

H3 doesn't want a casual sentence — it wants a structured prompt with named
sections, shot timings, speaker IDs, and tags pointing at your reference media.
MiniMax publishes a written guide for that format, and normally a separate
rewriting model (`H3-Context-IR`) turns your idea into it. That rewriter wasn't
open-sourced. This node pack is the hand-driven replacement: fillable templates
for every mode, live checking against the guide's rules, and a media loader that
keeps your reference tags straight.

![Reference mode workflow](docs/1.png)

*Media Loader → Prompt Builder → MiniMax H3 Reference to Video*

![Keyframe workflow](docs/2.png)

*Media Loader → Prompt Builder → MiniMax H3 Image to Video*

![Splitter workflow](docs/3.png)

*Media Loader → Reference Splitter → processor. For use without the Prompt
Builder, managing reference media only.*

![Media previews in the editor](docs/6.png)

*Media is displayed while you work. Hover over for previews. Clicking media
automatically adds the tag (like `<Picture 1>`) into the active text field for
you.*

Picture thumbnails in the Media Loader carry their pixel size and aspect ratio
in the corner, repeated in the larger preview when you click one. The ratio is
named from the same list the resolution selectors use (16:9, 4:3, 9:16, 21:9
and so on), with `≈` when a reference only comes close — so you can see at a
glance which preset matches it. Hover the thumbnail for the exact figures.

![Trim and crop editor](docs/7.png)

*Trim and crop clips on the fly without touching the original files, and pull
any frame straight out of a video into your picture references.*

---

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Writing a prompt](#writing-a-prompt)
- [Prompt library](#prompt-library)
- [Reference mode](#reference-mode)
- [FAQ: wiring reference media](#faq-wiring-reference-media)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## What you get

Three nodes, all under **conditioning → video_models**:

| Node | What it's for |
|---|---|
| **MiniMax H3 Prompt Builder** | The main one. An editor with fillable fields for every prompt mode, checks your work as you type, and outputs the finished prompt. |
| **MiniMax H3 Media Loader** | Drag-and-drop your reference images, videos, and audio. Shows exactly which tag each one will get. |
| **MiniMax H3 Reference Splitter** | Optional. Fans media out into individual slots when you want it to skip the Prompt Builder. |
| **MiniMax H3 Filename Prefix** | Optional. Builds a save prefix with the date already filled in, for dated output folders. |

Highlights:

- **Templates for all five modes** — text-to-video, first frame, first+last
  frame, last frame, and full reference mode.
- **Click-to-insert tags.** Your reference media appears as thumbnails; click
  one to drop `<Picture 2>` into your text. No typing tags by hand.
- **Live checking.** Shot numbering, cut times, dialogue formatting, references
  you connected but never mentioned — flagged while you write, not after a
  failed render.
- **The official guide is built in.** A 📖 button opens the full PDF.
- **Drag-and-drop media** with previews, playback, and reorderable slots.
- **Non-destructive trim and crop** — a popout editor sends just a slice of a
  clip (like its last 3 seconds), or just a region of the frame, without
  touching the file.
- **A prompt library** — save prompts with categories and favourites, then
  search and reload them.
- **Media presets** so you can reload a set of references in one click.
- **Unload media** clears the node in one go (after a confirmation) without
  deleting the underlying files, so presets pointing at them still work.
- **Detail control for reference video** — decode big clips at a smaller size
  so a long 4K reference doesn't eat gigabytes of RAM.

---

## Requirements

- **ComfyUI 0.30.0 or newer** — this is when H3 support landed.
- **The MiniMax H3 models.** Use the `fl2va` checkpoint for text and keyframe
  work, `ref2va` for reference mode. ComfyUI's own H3 templates will set you up.
- **PyAV or ffmpeg** — only needed for reference *videos*. Images and audio work
  without either. There's a good chance you already have this: many ComfyUI
  installs ship with ffmpeg, and PyAV comes along with several common custom
  node packs. Try dropping a video on the Media Loader first — if it's accepted,
  you're set. If not, `pip install av` into your ComfyUI environment is the easy
  route. Either way the node still loads and tells you why videos are
  unavailable, rather than failing when you hit queue.

---

## Install

**Via git**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder
```

**Via ComfyUI Manager** — search for "Fantastic MiniMax H3 Prompt Builder" and install.

**Manually** — download the ZIP and extract into `ComfyUI/custom_nodes/` so you
end up with `ComfyUI/custom_nodes/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder/`.

Then **restart ComfyUI completely** — not just a browser refresh. Nodes are only
registered at startup.

To confirm it worked, search the node menu for "MiniMax H3". All three nodes
above should be listed.

---

## Quick start

This is the same for every mode:

1. Add a **MiniMax H3 Prompt Builder**.
2. Click **Edit prompt…**, pick your mode along the top, and fill in the fields.
   The finished prompt builds live in the right-hand panel.
3. Click **Save to node**.
4. Connect the Prompt Builder's `prompt` output to the `prompt` input on
   whichever H3 node you're using:
   - **MiniMax H3 Image to Video** for T2VA, I2VA, FL2VA, and L2VA
   - **MiniMax H3 Reference to Video** for reference mode

   If `prompt` shows as a widget rather than an input, right-click it and choose
   *Convert widget to input*.
5. Set `width`, `height`, and `length` on that node. For first/last-frame modes
   the editor shows the exact frame count to use — H3 only accepts certain
   values, and the editor already rounds to a valid one.
6. Wire up whatever your mode needs:
   - **T2VA** — nothing else; the prompt is the whole input.
   - **I2VA / FL2VA / L2VA** — load your keyframe images with either ComfyUI's
     own **Load Image** nodes or this pack's **Media Loader**, then connect them
     to **Image to Video** like so:
     - **I2VA** — your image → `first_frame`
     - **FL2VA** — first image → `first_frame`, second image → `last_frame`
     - **L2VA** — your image → `last_frame`

     With **Load Image** nodes you have a choice: wire them straight into the
     H3 node, or route them through the Prompt Builder first — into its
     `picture_1` input and back out of the matching output. You can also do
     both, by splitting the connection so the same image reaches the H3 node and
     the builder. Routing through the builder is what gives you previews while
     you write.

     The **Media Loader** does the same job with less wiring: drop your images
     on it, run its single `references` output into the Prompt Builder, and take
     the frames from the builder's `picture_1` and `picture_2` outputs.
   - **Reference mode** — see [Reference mode](#reference-mode) below.
7. Queue it.

The rest of the workflow — loaders, samplers, VAE decode, save — is unchanged
from ComfyUI's built-in MiniMax H3 templates. This pack only replaces how the
prompt gets written.

---

## Writing a prompt

Click **Edit prompt…** to open the editor, then pick a mode along the top:

| Mode | You give it | Good for |
|---|---|---|
| **T2VA** | Just text | Building a scene from scratch |
| **I2VA** | A first frame | Animating forward from an image |
| **FL2VA** | First and last frames | Getting from A to B |
| **L2VA** | A last frame | Working backwards to a known ending |
| **Reference** | Any mix of images, video, audio | Locking a character, style, voice, or motion |

The editor fills in the fixed boilerplate — instruction lines, timing values,
section headers — so you write the actual description and it assembles a
correctly formatted prompt underneath. The right-hand panel shows the finished
prompt live as you type.

**Things the toolbar does for you:** inserts numbered shots with correctly
formatted cut times, writes camera moves as proper sentences, wraps dialogue
with the right language tags and speaker IDs, and drops in reference tags.

**Things it checks:** shots numbered in order, cut times increasing and inside
your video's length, `[Shot 1]` not carrying a timestamp, dialogue tags balanced
and labelled, references you connected but never mentioned, and — in reference
mode — every subject having a matching retention entry.

Amber warnings are advisory and the prompt saves regardless. Red errors are the
ones worth fixing before you render.

**Clear** in the header empties every field and starts a new prompt in the same
mode. It asks first, and the node keeps whatever prompt it already has until you
save — so clearing is only permanent once you press **Save to node**.

![I2VA editor layout](docs/4.png)

*I2VA layout — only the input Picture 1 can be used in I2VA mode. Other media is
disabled. You can rearrange which image is used as Picture 1 on the Media Loader
node: click and drag the ☰ icon. Alternatively, media can be disabled and
enabled by clicking the green dial, which automatically reorders the media
passed to the processing node. NOTE: changing order or disabling media changes
its label for the prompt — it does **not** automatically update your prompt.*

---

## Prompt library

Click **☰ Library** in the editor header to browse everything you've saved.

**Save current prompt** stores what's in the editor under a name, with an
optional category. Saved prompts keep the *editor state*, not just the finished
text — so loading one puts every field back exactly as you left it, ready to
edit. Nothing is re-parsed, so nothing can be misread on the way back in.

In the library you can:

- **Search** by name, category, mode, or the prompt text itself.
- **Filter by category** — type any category name when saving and it becomes
  available in the dropdown.
- **Manage categories** — pick one in the dropdown and click ✎ to rename it
  across every prompt in it, or clear it so those prompts become uncategorised.
  The prompts themselves are never deleted.
- **Recategorise a single prompt** — click its category chip (or `+ category` on
  one without) and set a new one.
- **Star favourites**, which sort to the top of the list.
- **Load** a prompt, replacing what's in the editor (it asks first if you'd be
  overwriting something).
- **Delete** entries you don't need.

Each row shows the mode it was written for, its category, how long ago it was
saved, and the opening of the prompt. Saving again under the same name updates
the entry; saving under a new name after loading one renames it.

Prompts live as individual JSON files in your ComfyUI user directory, so they
survive updates and are easy to back up or share.

---

## Reference mode

Reference mode is the one that takes media — images, video, and audio you want
the model to draw a character, style, voice, or motion from. It uses **MiniMax
H3 Reference to Video** and the `ref2va` checkpoint.

### The short version

1. On the Prompt Builder, click **+ Media loader**. A Media Loader appears,
   already connected.
2. Drop your reference files onto it, or click **Load files…**. Images, video,
   and audio can all go in at once — each lands in the right group.
3. Open **Edit prompt…** and switch to **Reference** mode. Your media now shows
   up as clickable thumbnails; click one to insert its tag into your text.
4. Fill in the six sections, then **Save to node**.
5. Connect the Prompt Builder's media outputs — `picture_1`, `video_1`, and so
   on — to the matching slots on **MiniMax H3 Reference to Video**, alongside
   the `prompt` connection you already made.

### What the media loader shows you

Every reference gets a tag like `<Picture 1>` or `<Audio 2>`, and your prompt
refers to media by those tags. The numbering isn't simply "which slot did I plug
this into" — see [How do tags get their
numbers?](#how-do-tags-get-their-numbers) — so the loader displays the exact tag
order along the bottom of the node, and the editor labels each thumbnail with
the tag it will actually get.

The ✂ button on any video or audio row trims what's sent to a start–end range
in seconds — the file itself is untouched, and the counters and 15-second
budgets track the trimmed span. `last 2s` / `last 3s` shortcuts grab a clip's
tail in one click, which is exactly what video continuation wants. Over-long
clips can be brought inside the budget the same way instead of re-exporting.

Videos that carry sound get an extra control for whether that soundtrack is
treated as part of the video or as a separate audio reference. The **?** button
by the videos heading explains the choice, and there's a
[summary in the FAQ](#what-do-off--paired--alone-do).

### Video detail and memory

Reference video is decoded to raw float frames, so memory is
`width x height x 3 x 4 bytes x frames` — a 15-second 1080p clip is about 9 GB,
and three of those will hurt.

The **detail** picker in the Media Loader's top row caps the long edge while
decoding, so full-size frames are never built:

| Setting | Long edge | 15s of 1080p |
|---|---|---|
| full | source size | ~9.0 GB |
| high *(default)* | 1280 px | ~4.0 GB |
| standard | 960 px | ~2.2 GB |
| low | 640 px | ~1.0 GB |

Lower settings cost less than you'd think, because the native H3 node rescales
every reference to your generation's pixel area regardless — feeding it 1080p
while generating at 832x480 spends the memory and then throws the detail away.
Clips already smaller than the cap are left alone.

The setting applies to every video in the node and is remembered for new ones;
individual clips keep their own value if you set one. Trimming helps too, and
multiplies with this: detail and duration are independent factors.

### Picture roles

Start a definition line with `<Picture N>` and role chips appear under it, the
same way audio lines work. Each one writes the definition, sets the matching
retention marker and context, and adds the right summary task type:

| Chip | Marker | Task type |
|---|---|---|
| First frame | `fully_preserved` | keyframe completion |
| Last frame | `fully_preserved` | keyframe completion |
| Composition | `weak_reference` | reference generation |
| Look / style | `weak_reference` | reference generation |
| Setting | `partially_preserved` | reference generation |
| Attribute → subject | `attribute_transfer` | reference generation |
| Storyboard | `weak_reference` | reference generation |

There's deliberately no "identity" chip: a picture that simply shows what a
character looks like belongs cited *inside* that subject's line
(`<Subject 1> is the woman in <Picture 1>, with ...`), not as a standalone
`<Picture N>` definition. Standalone picture lines are for pictures playing a
role in their own right.

Note that `attribute transfer` is a retention marker, not a task type — the
chip sets `attribute_transfer` on the retention row while the summary stays
`reference generation`.

### Switching lines off

Every line in `subject_definitions` and every row in `retention_analysis` has
its own ◉ switch. Click it and the line greys out and **drops out of the
generated prompt**, while staying exactly where it is in the editor.

That's for the in-between moments: you pull a reference out of the loader to
try something, and the lines describing it would now be pointing at media
that isn't there. Switch those two lines off, run the test, switch them back
on — no deleting and retyping.

The checks follow suit: a switched-off definition doesn't count as defined, so
you won't be told a subject is missing its retention entry when both of its
lines are off together.

Whole sections have the same switch on their heading — `subject_definitions`,
`retention_analysis`, `overall_soundscape` and `non_diegetic_music` — for when
you want the lot gone at once. `summary` and the description can't be switched
off; without them there's no prompt.

All of it saves with the workflow and with prompt presets.

### Trimming and cropping clips

The ✂ button on any video or audio row opens a popout editor. **The file on
disk is never modified** — everything is applied when the clip is decoded, so
the same file can be treated differently in another workflow, and Reset gives
you the whole clip back.

Video previews play with sound (🔊 mutes them), so you can trim on what you
hear as well as what you see. For both video and audio you get a timeline:
**click or drag anywhere on the bar to scrub** the preview, and drag the two blue handles to set what's kept —
clicking the bar never moves them. The preview follows whichever handle you're
dragging, so you can find a cut by eye. An amber playhead shows where the preview is, with its exact time
below the bar; if you scrub outside the kept range it turns red and says so, so
a frame you're looking at is never quietly excluded from the output. **◀| |▶** step a frame; **⇤ start** and **end ⇥** snap the range
to wherever the playhead sits — scrub to a cut, then click. **⏮ First** and
**Last ⏭** jump the playhead to the clip's own first or last frame, which pairs
with 📷 for grabbing a continuation frame. Or use the
keyboard:

| Key | Does |
|---|---|
| ← → | Step one frame (hold shift for ten) |
| space | Play / pause the selected span |
| `[` `]` | Set start / end to where the playhead is |
| home / end | Jump to the start / end of the selection |
| M | Mute / unmute the preview |
| A | Save the kept range as an audio reference |
| C | Capture the current frame (video only) |
| esc | Close without applying |

 Audio shows its waveform under the ruler. Play loops just the
selected span, and the readout warns when the kept span drops under the model's
2-second minimum.

Video also gets **📷 Use frame**, which grabs the frame currently shown in the
preview, saves it into ComfyUI's input folder, and adds it to the node as a
picture reference. That's the easy way to continue from a clip's ending: scrub
to the frame you want (the very last frame is often the blurriest, so pick a
good one a little earlier), capture it, and wire that picture to `first_frame`
on **MiniMax H3 Image to Video** in I2VA mode. If a crop is active the still is
cropped to match. Capture is refused, with a message, when the picture slots or
the 12-file limit are already full.

**🎵 Use audio** does the same for sound: it writes the kept range out as its
own WAV in ComfyUI's input folder and adds it as a standalone audio reference.
That's how you lift a voice sample out of a longer clip — trim to the sentence
you want, click, and it appears in the audio slots ready to define as
`<Audio N>`. It's offered for standalone audio too, so you can cut a long
recording down to a reference-sized piece without leaving ComfyUI. The
extraction runs server-side through the same decoder the loader uses, and is
refused if the audio slots are full or the range is under the 2-second
minimum.

![Capturing a frame in the trim editor](docs/7.png)

![The captured frame in the picture pool](docs/8.png)

*Capture the frame you're looking at, and it lands in the picture pool like any
other reference — tagged, taggable, and saved with presets.*

**Pictures get the same treatment.** The ▣ button on a picture tile opens the
editor with just the crop and mirror tools — no timeline, since there's nothing
to trim. Back on the tile, the kept region is outlined and everything outside
it is dimmed, so you can see what was dropped as well as what's left, and the
corner badge switches to the **cropped** pixel size and ratio. Mirrored
pictures show flipped. Crop a subject out of a wider shot, or flip a reference, without
touching the file: the rect is stored on the item and applied when the image is
decoded, and PIL crops before the float conversion, so a small crop of a huge
photo costs a fraction of the memory the whole frame would.

Video also gets **⇄ Mirror**, which flips the clip left-to-right before it's
sent. The preview flips with it, and so does the row thumbnail, so you always
see what the model will get. Worth knowing what mirroring does to a reference:
any text in frame becomes reversed, and asymmetric details swap sides — a
parting, a scar, which hand holds something, which way a subject faces. That
makes it useful for getting a pose or composition facing the other way, and a
poor idea for identity references you're keeping consistent across a chain,
where the flipped side-details will fight your unmirrored ones.

Video additionally gets **▣ Crop**: drag a rectangle (with rule-of-thirds
guides) to send only part of the frame freeform or locked to 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9 or 9:21, with the resulting pixel size shown live. Once set, the rectangle stays on
the preview with everything outside it dimmed, so the framing is always visible;
pressing ▣ again just puts the handles away. Handy for cutting a subject
out of wider footage instead of re-exporting.

Two things it's for:

- **Getting inside the budget.** A 40-second song or a long take doesn't need
  re-exporting; trim it to the seconds you want. The file counter, the ♪ audio
  counter, and the 2–15s and 15s-total checks all measure the *trimmed* span.
- **Continuing a video.** `2s⇥` and `3s⇥` set the trim to the clip's final
  seconds in one click, which is exactly what a continuation reference wants —
  the motion and audio leading into the new clip, without spending your whole
  budget on footage the model doesn't need.

The scissors glow amber when a trim is active, and the trim travels with media
presets and with saved workflows.

One wrinkle worth knowing: a trim applies to the *item*, so trimming a video
trims its frames and its paired soundtrack together. To keep the full video but
only a few seconds of its audio, set the video's audio to `off` and load the
audio separately, then trim that copy.

You can also skip the Media Loader entirely and wire your own loaders — the
[FAQ](#do-i-have-to-use-the-media-loader) covers every route.

![Reference mode editor layout](docs/5.png)

*Reference mode — all six sections, with every connected reference available to
cite.*

### Presets

The Media Loader can save your current set of references — which files, their
order, and each video's audio setting — under a name, and reload it later from
the dropdown.

Presets point at files you already uploaded rather than copying them, so saving
and loading is instant. If you later delete one of those files, loading the
preset skips it and tells you which one is missing. Deleting a preset never
deletes your media.

---

---

## FAQ: wiring reference media

This is the fiddly part, so here's the whole picture.

### Do I have to use the Media Loader?

No. There are three ways to get media in, and they all work:

1. **Media Loader → Prompt Builder.** One cable. Easiest, and previews plus tag
   numbering come free.
2. **Your own loaders → Prompt Builder.** Wire `LoadImage` and friends into the
   Prompt Builder's `picture_1`, `video_1`, `audio_1` inputs.
3. **Straight to the native node.** Skip this pack's media handling entirely and
   wire your loaders directly into **MiniMax H3 Reference to Video**. You still
   get a well-formed prompt; you just won't get thumbnails in the editor.

Options 1 and 2 mix freely. If a slot has its own input wired, that wins;
anything else falls back to the Media Loader's bundle.

### Which output goes where?

The Prompt Builder has a `prompt` output plus one output per media slot.

| From Prompt Builder | To MiniMax H3 Reference to Video |
|---|---|
| `prompt` | `prompt` |
| `picture_1` … `picture_9` | `ref_images` slots |
| `video_1` … `video_3` | `ref_videos` slots |
| `video_audio_1` … `video_audio_3` | `ref_video_audios` slots |
| `audio_1` … `audio_3` | `ref_audios` slots |

The native node's slots start at 0 while ours start at 1, so `picture_1` goes to
`ref_image_0`. Keep them in the same order.

### Then what's the Reference Splitter for?

Only for when you want media to reach the sampler *without* going through the
Prompt Builder — for instance if you keep the builder off to one side. Media
Loader → Splitter → native node. If you're already routing media through the
Prompt Builder, you don't need it. There's a button on the Media Loader that
adds one, wired up.

### How do tags get their numbers?

This is the one that trips people up, so it's worth reading.

H3 numbers references **by the order they arrive**, not by which slot they're
plugged into. Two consequences:

- **Gaps close up.** If you only fill `picture_2` and `picture_5`, they become
  `<Picture 1>` and `<Picture 2>`.
- **A video's soundtrack takes a low audio number.** It's presented right before
  its own video, so with one video (with sound) plus one standalone audio clip,
  the soundtrack is `<Audio 1>` and the standalone clip is `<Audio 2>` — even
  though the standalone one might feel like it should come first.

You don't have to work this out yourself. The Media Loader shows the exact tag
order along the bottom of the node, and the editor's thumbnails are labelled
with the tag each one will actually get. Trust those over intuition.

### Why is a video's audio a separate thing at all?

ComfyUI has no single "video with sound" type, so frames and audio travel on
separate wires. The Media Loader splits it for you automatically when you drop
in a video file. If you're wiring your own loaders, you'll need one that gives
you frames and audio separately.

The model treats them as one thing internally — the separation is just plumbing.

### What do off / paired / alone do?

That's the little control on a video row when the file has sound. There's a **?**
button next to the videos heading that explains it in the node, but in short:

- **paired** — the sound belongs to this footage. Use it for on-screen dialogue
  where lip sync matters, action sounds that need to land on the right frames,
  or when you're keeping a source video's original audio.
- **alone** — you want the audio as a *reference* rather than as this clip's
  soundtrack: borrowing a voice, a music style, some ambience. Also the right
  pick when you're not reusing the video's visuals in sync.
- **off** — ignore the audio entirely.

### Why does one video count as two files?

H3 takes at most 12 references in total, and a video's split-off soundtrack is
its own reference. So a video with `paired` or `alone` audio uses two of your
twelve. Set it to `off` and you get one back.

It also spends part of a second budget: H3 accepts **three audio clips**, and a
split soundtrack is one of them even though it travels in a different input
group on the native node. Three videos with their sound enabled therefore use
your whole audio allowance. The loader shows both counters — files and ♪ audio —
and warns when either is exceeded.

Reference clips should also run 2–15 seconds each, and — this is the one people
miss — **15 seconds is the total across all clips of a type, not a per-clip
allowance**. Three 15-second audio clips is 45 seconds and three times over
budget; three clips only fit if they average about five seconds each. A split
soundtrack spends from both totals at once: a 12-second video with its audio on
uses 12 of your 15 video seconds *and* 12 of your 15 audio seconds, leaving 3
seconds of audio for anything else.

Audio also can't be sent without at least one image or video alongside it.

The loader flags all of these, and the ✂ trim is usually the fix — see
[Trimming and cropping clips](#trimming-and-cropping-clips).

Go over twelve and you get a red warning. The node deliberately won't drop
anything for you — removing a reference renumbers every tag after it, which
would quietly invalidate tags already written into your prompt.

### Does switching mode change what gets sent?

Yes — the saved mode decides what the outputs carry, so cables can stay
plugged in permanently. Keep `picture_1` wired to `first_frame`, and a prompt
saved in T2VA mode sends nothing but the prompt; switch the editor to I2VA and
Save, and picture 1 flows again. What each mode sends is written right under
the mode buttons in the editor, unusable media is greyed out in the rail, and
the console prints exactly what was withheld on each run — so a gated
reference is visible three ways before a render finishes.

Mode and prompt are saved together by the editor's **Save**, so they can never
disagree with each other. If the node's state is missing or unreadable, the
gate fails open and passes everything rather than silently withholding.

For per-item control within a mode, the ◉ toggle on the Media Loader switches
one reference off without unplugging anything.

### One loader, two pipelines

An example workflow using this pattern ships with the pack — load
**MMH3PromptBuilder_AIO_Example** from ComfyUI's workflow browser (Workflows →
Browse Templates → this pack), or open
`example_workflows/MMH3PromptBuilder_AIO_Example.json` directly. It needs
[VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) for
the video output and
[KJNodes](https://github.com/kijai/ComfyUI-KJNodes) for the Set/Get nodes.

The example is set up for a 4-step turbo LoRA, with **Sigma Shift at 12 video /
6 audio**. That audio value is deliberate: the released base configuration is
12/3, but distilled turbo LoRAs compress the video trajectory, and since the
audio schedule is derived from the video one, 6 keeps audio aligned at low step
counts. Running the base FL2VA model without a turbo LoRA? Put it back to 3.


The builder also has a **references** output (last slot): the same bundle it
received, gated to the saved mode, ready for a **Reference Splitter**. That
makes a single Media Loader + Prompt Builder able to drive both an fl2va
pipeline and a ref2va pipeline — wire the builder's `references` through a
Set/Get pair into each pipeline's own splitter, keep one pipeline bypassed,
and the saved mode decides what media flows: switch to FL2VA and Save, and the
ref2va side's splitter receives only pictures 1–2; switch to REF and the full
set flows again. Gating lives in one place — the builder — no matter how many
pipelines fan out from it.

### Can I wire every output once and leave it?

Yes — that's the intended way to work. Connect all of the Prompt Builder's media
outputs to the matching slots on **MiniMax H3 Reference to Video** once, and
leave the workflow alone.

Slots with nothing in them pass through empty, and the H3 node skips them. The
tags close up around whatever is actually present, so three images in slots 1, 2
and 3 are `<Picture 1>`–`<Picture 3>` whether or not the other six are wired.

That pairs with the ◉ toggle on the Media Loader: rather than unplugging cables
between runs, switch an item off and it stops reaching the model — the tag
numbering adjusts, and the Prompt Builder's checks update to match.

### What if I connect an image but never mention it in the prompt?

Nothing errors, but it does affect the result. The image is still handed to the
model, labelled, and taken into account — you've just given it no instructions
about what to do with it. It can bleed into the output in ways you didn't ask
for, and it costs render time and VRAM on every step.

The editor flags this: a reference thumbnail showing an amber dash instead of a
count hasn't been mentioned yet. Either write it into your description or
disconnect it.

### Where do first and last frames go for the non-reference modes?

Keyframes work differently from references. In I2VA, FL2VA, and L2VA your images
are exact frames of the finished video, so they go to the `first_frame` and
`last_frame` inputs on **MiniMax H3 Image to Video** — not to the `ref_images`
slots, which exist only on the reference node and mean "here's something to draw
from", not "here's a frame".

Either loader works. Previews in the editor come from routing an image through
the Prompt Builder — which you can do with a **Load Image** node just as well as
with the Media Loader — so the Media Loader's advantage is convenience rather
than capability. See [Quick start](#quick-start) for the wiring.

These modes take one image each, except FL2VA which takes two. Wire in more and
the editor tells you exactly which ones will be ignored.

### My video length and the prompt disagree

For first/last-frame modes the prompt states when the last frame lands, so it
has to match the length you're actually generating. The editor shows the correct
frame count for your chosen end time — put that number into the native node's
`length`. H3 only accepts certain frame counts, and the editor already rounds to
a valid one.

---

## Dated output folders

Save nodes expand date tokens from their own widget, so a prefix like
`MiniMaxH3/%date:yyyy-MM-dd%/vid` only works when it's typed straight into the
save node. Route it through a string node, a switch, or anything else and the
token arrives verbatim — you get a folder literally named `%date:yyyy-MM-dd%`.
That's a known issue in VideoHelperSuite among others.

**MiniMax H3 Filename Prefix** builds the prefix from parts and resolves the
date itself, so what reaches the save node is a plain string that survives any
amount of wiring:

- **folder** — click **📁 Browse…** for a folder browser that walks your
  ComfyUI output directory: click a folder to enter it, `..` to go up, and
  **Create** to make a new one on the spot. Or just type a path.
- **subfolder** — optional extra levels, created if missing (`Ref2V`,
  `client/act2`).
- **date_folder** — off, or a dated folder in your preferred format
  (`YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY-MM-DD_HH-MM`, and so on).
- **filename** — the start of the file name; the save node still appends its
  own counter.

So folder `MiniMaxH3`, subfolder `Ref2V`, date `YYYY-MM-DD`, filename `vid`
gives `MiniMaxH3/Ref2V/2026-08-07/vid_00001.mp4`.

Date tokens still work inside **subfolder** and **filename** if you want them
there — `%date:hhmmss%` or strftime `%H%M%S` — so `vid_%date:hhmm%` becomes
`vid_1409`. The node re-evaluates every run, so the date can't get stuck on
whatever it was when the workflow was loaded.

---

## Troubleshooting

**The nodes don't appear.** ComfyUI needs a full restart, not a page refresh.
Check the startup console for errors mentioning MiniMaxH3.

**I updated but nothing changed.** ComfyUI caches extension files aggressively.
Open DevTools (F12), tick *Disable cache* in the Network tab, and reload with it
open. If a node's *outputs* look wrong specifically, that's a restart issue
rather than a browser one — and nodes already placed in a workflow keep their
old slots, so delete and re-add them after an update.

**Videos are rejected.** Neither PyAV nor ffmpeg was found. Many ComfyUI installs
already include ffmpeg, so this is worth a check before installing anything: if
ffmpeg isn't on your PATH, `pip install av` into your ComfyUI environment is the
simplest fix.

**A button does nothing.** Open the browser console (F12) and click it again —
any failure prints there. The Media Loader also has an **Open loader…** button
that works independently of the on-node panel.

**Something looks squashed or overlapping.** This pack works with both the
classic node renderer and Nodes 2.0. If a panel misbehaves in one of them, the
modal buttons (**Edit prompt…**, **Open loader…**) always work regardless.

---

## Credits

Prompt structure follows MiniMax's official *Video Prompt Writing Guide*, which
ships with this pack — click 📖 in the editor to read it.

Built against ComfyUI's native MiniMax H3 support.

## License

MIT
