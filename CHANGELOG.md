# Changelog

Every release of **ComfyUI Fantastic H3 Prompt Builder**, newest first. The
[README](README.md) keeps the recent ones; everything older lives here.

## 1.8.1

- **Custom size.** The trim and crop editor's size menu has **custom…**: type
  any long edge, applied with Apply like the presets.
- **stack_pictures: up to N.** "up to 8" is now **up to N**, and the new
  **stack_pictures_n** under it sets N (8 by default). A workflow saved with
  "up to 8" needs it picked again.
- **Edit bundles as copies.** RefMod bundles from ComfyUI-MiniMaxH3Mod 0.2.6+
  open in **Edit frames & voice**. The result is saved as a copy in standalone
  files and the bundle is left as it is, so saving a copy with no changes
  splits a bundle into standalone files.
- **Library size.** The RefMod library has its own **⤡ Size** for its window
  and text size.
- **Stack labels without the builder.** The RefMod Stack's cards number
  RefMods after the Media Loader's media, as the Text Encode will, with or
  without the Prompt Builder in between.
- **Mask preview fixes.** The overlay redraws when you change the size or the
  crop, and no longer draws grow and the regenerated cells too large on a
  cropped clip. The edit itself was always right.

## 1.8.0

- **Masked video editing.** Mark part of a clip and only that area is
  regenerated; the rest stays as filmed. Right-click a video on the Media
  Loader and choose **◐ Mask for editing…**. The mask is built from layers,
  new ones on top, each adding to or cutting from those below: **Auto Mask**
  (SAM 3.1, from dots and a name), keyframed **ellipses, rectangles and
  polygons**, and **brush** strokes. Grow, feather, invert and crop to mask
  shape it. The RefMod Text Encode builds the edit, and the new **Fantastic
  H3 Edit Composite** pastes exactly the regenerated area back into your
  original frames. It needs the SAM 3.1 checkpoint; see
  [Editing a clip with a mask](README.md#editing-a-clip-with-a-mask).
- **A faster RefMod Text Encode.** RefMods now keep the pictures the text
  encoder is shown inside their file, so it no longer decodes them on every
  run. Older ones are decoded once and cached, and the library's **Store
  encoder frames** adds them to old files for good.
- **stack_pictures** (experimental) on the Text Encode sets how many of a
  RefMod's pictures the encoder sees: every 4th (the default, about what it
  saw before), up to 8, or all. More may help identity and bleeding between
  RefMods, but costs memory and generation time.
- **Trim editor.** Zoom the timeline (−/+, the slider, the - and = keys, or
  scroll), see how far the playhead is past the first kept frame, and stop
  losing work to a stray click or Esc: with unsaved changes it asks first.
  Ctrl+Z inside it no longer undoes the graph. Loader rows show each clip's
  length beside ✂, and video cards show their aspect ratio as sent.
- **Right-click selected text** in any builder field for Copy, Cut, Paste
  and Remove, alongside Save selection as phrase.
- **Clean up…** in the Media Loader deletes mask files nothing uses and
  saved latents, keeps masks used by saved media sets and drafts, and
  offers itself once unused masks pass 500 MB (set the size in its ⚙ menu).
- **voice_description_at_label** on the Text Encode also writes each voice
  RefMod's saved description right after its `<Audio n>:` label.
- New RefMods default to a **768 px** short edge (was 1024).
- The 📖 Guide adds **Part E** on masked editing.

## 1.7.4

- **Compressed RefMods no longer squash faces.** A photo of a different
  shape from the first one was squeezed to fit in Compressed mode; it is now
  trimmed to the first one's shape, as Full always was, and the Create tab's
  previews show the trim. If Compressed seemed to lose likeness on
  characters, try it again.
- **The RefMod library keeps unfinished work.** Close it mid-way (Close,
  Escape or a click outside) and the Create tab's sources, names,
  descriptions and any edit in progress are kept. Browse library…, Create…
  or an empty slot brings you back where you left off; Start fresh clears it.
- **Retained attributes.** A new RefMod field for the small details the
  model should keep — a tattoo, a scar. Set it on the Create tab, in edit
  mode or in the details panel; Draft from RefMods adds it to the end of the
  subject's retention_analysis note.
- **Stack cards.** Click a card's thumbnail or name to open the library on
  that RefMod's details. Drag to reorder works again, from the handle,
  thumbnail or name, and can drop onto an empty slot to go last. Create tab
  source rows are numbered, like Image 3/7.
- **Clearer refusals.** A refused request prints one line to the ComfyUI
  console naming the failed check (never the token). "Missing or stale
  session token" after a fresh retry now explains that a proxy, tunnel or
  another extension may be removing the `X-MiniMaxH3-Token` header. The
  origin check also refuses same-site requests, as SECURITY.md described.
- Release notes have moved to [CHANGELOG.md](CHANGELOG.md); the README keeps
  the recent ones.

## 1.7.3

- **A new RefMod Stack node.** Twelve fixed slots that never resize the
  node, a slider per channel labelled with its tag, a position badge on
  each card, and ⤢ Size for node and text scale. Colours match the Media
  Loader.
- **RefMod presets.** Save a stack with its weights and load it into any
  stack node. A prompt in the library can be linked to one.
- **Chain stacks.** Wire stacks together and each one shows where it sits
  in the chain and which labels come from the stacks before it.
- **Right-click a tag** to swap in another picture, subject, name or
  speaker, swap two of them, or remove it — in one place, one field, or
  everywhere.
- **Tab to fill names.** Start typing `!cas` and press Tab for
  `!castle_with_moat`.

## 1.7.2

- **Name your subjects.** Each `<Subject N>` line has a name box, and
  `!Ann` works as shorthand anywhere in the prompt.
- **RefMods remember who they are.** Save a subject name, how they look and
  how they sound with a RefMod. Draft from RefMods writes all of it into
  your prompt.
- **Voices you can describe.** Voice lines get a voice box, and the speaker
  buttons can insert a line that names the voice, like "in the low, husky
  voice referenced from <Audio 1>".
- Draft from RefMods can start over or fill in missing names and voices
  when everything is already drafted.
- The built-in 📖 Guide adds parts on using the Prompt Builder and RefMods.
- The Quick start now builds the workflow before you write the prompt.

## 1.7.1

- RefMods made from a **video clip** now hold real motion. Create and Edit
  take the first frames of the clip (after your trim) on H3's own frame
  grid — 22 frames store 7, 39 store 12, 56 store 17 — instead of evenly
  spaced picks that stored only 2 frames. **Clip frames** defaults to 22
  and shows what you'll get as you change it.
- Deleting a RefMod now closes its details panel.
- Single-file RefMod bundles saved by ComfyUI-MiniMaxH3Mod 0.2.6 show up
  in the library and can be used and inspected (not edited) here.

## 1.7.0

**RefMods.** Save a character, a place, a look or a voice once and use it
in any prompt after that — no re-uploading, no re-cropping. A RefMod is a
small file in `models/refmods`; the model reads it the same way it reads a
reference picture or clip. New to them? See the
[RefMods how-to guide](REFMODS.md).

- **Fantastic H3 RefMod Stack** holds the RefMods a prompt uses. Click
  **Browse library…** to pick from what you've saved, set a weight per
  pick, and see the exact `<Picture 1>` / `<Video 1>` / `<Audio 1>` labels
  the prompt should cite.
- **The library** is where RefMods are made and looked after. Drop in
  pictures, clips or audio (or pull them from a Media Loader), choose Full
  or Compressed, and create. Several photos become one RefMod; a clip's
  soundtrack or an audio file becomes its voice. Later you can rename it,
  give it a description and a preview image, see what's actually stored
  inside it, drop or reorder its frames, add more, swap the voice, or save
  the result as a copy and keep the original.
- **Fantastic H3 RefMod Text Encode** takes the place of *MiniMax H3
  Reference to Video*. It sends the RefMods and the Media Loader's media to
  the model together, numbered in one sequence, and gives you the empty
  latent to sample from.
- **The Prompt Builder** gets a **+ RefMods** button that adds and wires a
  stack for you, shows RefMods as chips beside your media, warns when
  something isn't reaching the Text Encode, and keeps a draft's RefMods
  separate from Live — the same way it already handles media.
- Two ready-made workflows show the whole chain:
  `MMH3_RefMod_Vanilla_Stack_Example.json` (this pack and core nodes only)
  and `MMH3_RefMod_Fully_Fantastic_Example.json` (adds the Fantastic LoRA
  loader and seeds, from the `comfyui-fantastic-loras` pack). Use a
  **ref2va** checkpoint with them: that's the model that was
  trained on references. However, MiniMax has admitted there are faults
  with the open-weight ref2va model, so we strongly encourage using a
  fl2va/ref2va hybrid model that enables reference capabilities with fl2va
  quality. These are **direct drop-ins** for ref2va workflows, and do not
  require any special nodes or workflow modifications to use, just select
  a hybrid model instead of a ref2va model. Testing was done using the
  "20-49" model from this repo:
  <https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models>

**Also:**

- Delivery tags like `<whisper>` and `<pause>` now show in pink in the
  prompt, in the picker's preview and in the guide, so they stand out from
  the words being spoken. `<pants>` and `<smacks lips>` are gone — they
  didn't do anything.
- Weight sliders on a long stack no longer jump the list back to the top.
- Set/Get nodes between the builder and the Text Encode are followed, so
  labels and warnings stay right on tidy graphs.
- A draft with its own media or RefMods but no text yet is saved to disk
  like any other draft (it used to be lost on reload).
- Security: the pack has a `SECURITY.md`, and its code no longer contains
  anything the Comfy Registry's automated scan flags.

---

## 1.6.4

**Features:**

- A new **Delivery** row in the editor, directly under the dialogue row,
  inserts the community-found performance tags that shape how a line is
  spoken: pauses and breaths, emphasis and whispering, and non-verbal
  sounds such as laughs, sighs and gasps. Pick a group, pick a tag, and
  hover the picker to preview an example line before inserting it. These
  tags aren't in MiniMax's published guide, so results may vary.
- The tags that wrap text, like `<i>` and `<whisper>`, wrap whatever you
  have selected and leave it selected. With nothing selected, the caret
  lands between the opening and closing halves, ready to type.
- The bundled writing guide has a new **Community Discoveries** section
  listing the same tags with an example for each, clearly marked as
  community findings rather than official guidance.

## 1.6.3

**Fixes:**

- The crop frame now follows the picture when you rotate it. Turning a
  picture that had an active crop left the marquee stranded in the black
  area beside the image, wrongly shaped, and it could barely be dragged and
  never over the picture itself. The overlay is now placed where the image
  is actually painted rather than where its untransformed box would be.
- Two fixes from 1.6.1 that 1.6.2 had accidentally dropped are back: a
  rotated preview no longer paints over the editor's toolbar, and the
  dialogue row's speaker buttons keep up with the text again.

## 1.6.2

**Security release.** This version exists to address findings from the Comfy
Registry's security review of earlier versions. No features changed; if you
run any earlier version, update.

- **Path containment.** Every file path a request supplies is now resolved
  and verified (via `realpath`) to live inside ComfyUI's input, output or
  temp directory before it is read, and the fallback that could previously
  rewrite a rejected path into an unconfined one is gone. Symlink escapes
  are caught by the same check.
- **Cross-site request protection.** Every `POST` route now refuses requests
  that a browser marks as coming from another site (`Sec-Fetch-Site:
  cross-site`, or an `Origin` that doesn't match the host), independently of
  ComfyUI core's middleware — which matters on `--listen` installs, where
  core's Host/Origin comparison doesn't apply. A malicious web page you
  happen to visit can no longer call this pack's upload, delete or write
  endpoints.
- **JSON routes require `Content-Type: application/json`.** Cross-origin
  pages cannot send that content type without a CORS preflight, which is
  never approved, so the JSON endpoints stop being reachable as "simple
  requests". *If you script these endpoints yourself, add the header* — a
  `text/plain` body now gets a 415.
- **Deletion is double-checked.** The prompt/preset delete and rename paths
  re-verify, immediately beside the `os.remove`, that the target file lives
  inside its own library directory.
- **`POST /minimax_h3/probe` removed.** Nothing in the pack called it, and
  an uncalled endpoint that accepts an arbitrary path is pure attack
  surface. Media metadata comes from the upload and extract responses and
  from `presets/load`, as before.
- **No more shelling out to ffmpeg.** All video and audio decoding now goes
  through PyAV in-process (ComfyUI core requires PyAV, so every working
  install has it). The ffmpeg/ffprobe fallback paths are gone: they were the
  cause of the registry scanner's command-injection flags (list-argument
  calls that were never actually injectable, but the cleanest answer is no
  external processes at all), and they were also the pack's only dependency
  on a binary being on PATH. If you previously relied on ffmpeg because PyAV
  was broken in your environment, see Troubleshooting — a broken PyAV also
  breaks ComfyUI itself, so it's worth fixing either way.

## 1.6.1

**Prompts can be linked to a media preset.** A prompt is written for a
particular set of references, so saving one can remember which. If your
current media already matches a saved preset it offers to link it; if it
doesn't, it offers to save it as a preset and link it in the same action.
Which case applies is decided by comparing the media itself, not by the label
on the preset picker — that label survives every edit short of *Unload*, so it
can name a preset your media stopped matching an hour ago. Loading a linked
prompt never swaps your media silently: a strip names the preset, its
reference count and how many it would replace, and warns you if the preset has
been edited since it was linked, because reference numbers are positional and
`<Picture 3>` may no longer mean the picture you wrote it for. Linked prompts
carry a badge in the library showing what the preset holds, with a hover
preview of its contents. In draft mode the media goes to the draft's own set,
never to the node. See
[Linking a prompt to its media](#linking-a-prompt-to-its-media).

**Media presets can be categorised.** The picker now has the same bar the
prompt library does — a search box, a category dropdown and a ✎ to rename or
clear a category — above a list grouped by category with uncategorised sets
last. File a preset when you save it, or from the ✎ on its row in the picker,
which changes only the label and never touches the media. Preset names stay
unique across every category, because a prompt links to a preset by name.

**Closing can save instead of asking.** A new ⚙ setting, *Save to node when
closing*, makes ✕, Escape and clicking outside give the node your changes.
Cancel still discards, and a draft is never written to the node by closing.
While it's on, the unsaved-changes warning greys out, since it has nothing
left to warn about.

**The bundled guide is now HTML rather than a PDF** — it opens in a tab,
searches with Ctrl+F, has a contents sidebar and deep links, and reads
properly on a phone.

**Fixes:**

- Rotating a picture or clip in the crop editor no longer paints outside the
  window. A quarter turn used to spill over the toolbar and cover the rotate
  button itself, so the turn couldn't be undone.
- The dialogue row's speaker buttons now keep up with your text. Inserting a
  line for (S1) offers (S2) next, as it always should have — the row was only
  rebuilt when something else redrew the editor.
- Escape now respects your preferences. It used to close the editor directly,
  discarding unsaved edits even with *Warn about unsaved changes* switched
  on — which is the opposite of what that setting says.
- A draft no longer loses its edits when you switch back to Live and then
  close the editor.
- A draft that never had media of its own no longer reverts your Media Loader
  when it's committed. Media a draft merely displays is now kept separate from
  media it owns, so only a set you deliberately edited is applied.
- A draft started while the Media Loader was empty now follows the node's
  media instead of showing none for ever, and committing it can't clear your
  loader.
- Media stored in a draft is checked when it loads; anything unusable is
  discarded and the banner says how many, rather than a broken reference
  reaching a generation.
- The preset picker no longer reports a freshly loaded preset as edited. It
  compares effective values now, so a preset whose stored form predates a
  field still matches itself after loading.
- A preset containing a switched-off item can be recognised again; the
  comparison was ignoring disabled items on one side only.
- The draft banner stays pinned above the editor body instead of scrolling
  away, and survives a failure elsewhere in the form — it's the one thing that
  tells you the node isn't holding what you're looking at.
- The ⚙ menu can discard every saved draft, and shows how many there are.

---

## 1.6.0

**Draft mode.** Queue a batch, then start writing the next prompt on a
scratchpad the node can't execute. Drafts autosave to disk, survive a browser
crash, reopen where you left off, and can carry their own reference set.
**⇣ Pull from Live** copies the current prompt across — cast and setup only,
or everything — so a follow-up shot doesn't mean re-typing your subjects.
See [Draft mode](#draft-mode).

**The media loader opens inside the editor.** A **▣ Media** button in the
editor header brings up the loader's own panel over the top, so adding a
reference mid-sentence doesn't mean finding the node on the canvas.

**Fixes:**

- Saving a prompt under a new name no longer deletes the one you loaded.
  Renaming is now its own clearly-labelled action, and a name collision asks
  before overwriting instead of replacing silently.
- The library's category filter no longer sticks to a category that no longer
  exists, which made a full library look empty.
- The Media Loader's preset dropdown stayed open reliably; it was a native
  `<select>` inside the node, which the ComfyUI frontend closes on every
  canvas redraw.
- Presets saved before dimensions were stored now come back with their aspect
  data, and no longer cause a burst of redraws that made the browser sluggish.
- The node and text size you set are re-applied when a workflow loads, instead
  of the panel reverting to 100% inside a correctly-sized node.
- Fixed caret drift in the highlighted text fields: the `[Shot N]` marker was
  drawn bold, and the extra glyph width pushed the caret out of step with the
  text underneath.
- All prompt and preset writes are atomic, so a crash mid-save can't corrupt
  an entry.
