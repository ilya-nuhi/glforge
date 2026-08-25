# GlForge

Rename the nodes, meshes and materials inside `.glb` / `.gltf` files, move them
about, and wire textures into material slots — entirely in your browser, with a
3D preview that shows you which name belongs to which object. Files are processed
locally and never leave your device.

**Live site:** https://ilya-nuhi.github.io/glforge/

## How it works

glTF stores names and material bindings in its JSON, so the app edits the JSON
directly and never touches geometry or re-encodes an image:

- `.glb` → the binary chunk is copied byte-for-byte; output is `.glb`, with any
  image you added folded into that chunk so the file stays self-contained
- `.gltf` → loads **alone**, no `.bin` / texture files needed to rename; external
  file references are kept as-is, so the exported `.gltf` drops right back into
  your project
- Compressed files (Draco, meshopt, KTX2) and any vendor extensions pass through
  untouched, since the renamer never decodes or re-encodes anything

## Layout

The UI follows the [three.js editor](https://threejs.org/editor/): a menubar
across the top (File / Edit / View / Help), the viewport filling the window, and
a resizable 350px sidebar on the right — drag the divider, double-click it to
reset. The sidebar has three tabs:

- **Scene** — scene picker, name filter, the outliner, and a properties panel
- **Files** — the folder the model was opened from, and what is missing from it
- **Tools** — find & replace, file info, download / reset / close (names, or
  everything)

The viewport's bottom-left read-out counts nodes, meshes, materials and how many
names have been changed.

Picking a row and renaming it are separate, the way they are in a file browser:
a click selects, and a second click on the name opens it for editing — so a
double-click does both. Keyboard: `↑`/`↓` walk the rows, `←`/`→` close and open
them (or step out to the parent / in to the first child), `Enter`, `F2` or just
typing opens the name, `Enter` or `Esc` closes it again. While a name is open
`←`/`→` belong to the caret, so they never interrupt typing. `F` frames the
selection (or everything), `W`/`E`/`R` switch the gizmo between move, rotate and
scale, `Esc` clears the selection, `Ctrl`+`S` downloads, `Ctrl`+`Z` undoes a
replace.

## Features

- Drag & drop a `.glb`, a `.gltf`, or **the whole model folder** anywhere on the
  page — subfolders and all. **File → Open folder…** does the same from a dialog
- Sidecars are matched by path, so a `textures/wood.png` in the glTF finds the
  file that sat there, however deep the folder was nested
- The **Files** tab shows that folder back to you, file by file, previews any
  image in it on a click, names the references nothing supplied covers, and lets
  you drop a file back out with `Delete`
- Move, rotate and scale nodes — by dragging a gizmo in the viewport, or by
  typing exact numbers into the properties panel
- Edit any name inline — click to pick a row, click its name again to rename —
  with per-name revert and one-click reset
- **Reset all** puts the whole file back the way it was opened — names,
  transforms and texture bindings together — and **Reset names** does the names
  alone. Both are in **File** and on the **Tools** tab
- Filter names, and find & replace across all of them (plain text or regex),
  with one-level undo
- The open file and every change to it survive a reload, the way the three.js
  editor's scene does

### Outliner

The **Scene** tab shows an outliner rooted at the file it came from: the model,
then its objects — nested under their parents, one row per object. There is no
row for the scene itself: which scene is on show is the toolbar's scene picker,
and repeating it as a row would only say the same thing twice. Its name is on the
**Names** tab with the other scenes.

An object is not split from what it draws. Right after its own name comes the
symbol for the mesh data it draws — the symbol alone, since a mesh almost always
carries the object's name over again and printing it twice says nothing; its name
is in the tooltip. Then come that mesh's materials by name, the way the three.js
editor's outliner prints an object's material after its name. One material is a
chip; a mesh with several gets a dropdown saying how many. Picking any of them
selects it and fills the properties panel with it, hovering one outlines it in
the viewport, and a rename anywhere repaints it here. Mesh data no object in the
file draws still gets a row of its own, under the leftovers below.

Every type has its own icon and colour — empty/transform object, mesh object,
camera, light, joint/bone, mesh data (distinguishing meshes that carry a material
from those that don't), material, texture, image, animation, skin, material
variant. The model row is the file on disk rather than anything in the document,
so it is a heading: it collapses the whole tree, and it is the one row with no
name to edit.

Rows collapse and expand, and anything the current scene doesn't reach is listed
below a "Not used in this scene" heading so it stays renameable. The same mesh or
material can appear in several places; editing one row updates them all, and
find & replace applies once per entry rather than once per row. The filter
searches what a row names as well as the row itself, so a material still turns up
its meshes.

**Material names stay unique.** Downstream of the file a material is usually
looked up by name, so a name another material already answers to is refused: the
field turns red, the document keeps the name it had, and leaving the field puts
it back with a note saying why. Find & replace obeys the same rule — the renames
that would collide are left alone and counted in the message. Names are compared
exactly, since two names differing in case are two names.

**What the outliner covers is objects, their mesh data and their materials** —
including anything the current scene does not use, which is why the leftovers are
listed rather than dropped. Everything else a glTF can name (scenes, skins,
textures, images, animations, cameras, lights, material variants) is on the
**Names** tab, which is a row like any other: renameable, filtered, and reached
by find & replace. **Reset all** puts every one of them back, since it re-reads
the original file rather than walking rows.

### Files

The **Files** tab is the folder the model came from, as a tree: the `.glb` /
`.gltf` itself and every file dropped alongside it, in the subfolders they sat
in. Folders collapse, and each row carries its size — a folder carries its whole
subtree's.

What each file is *for* is the point of the list. Its glyph and tooltip say
whether the document reaches for it as geometry data or as a texture image, and
which URI it is standing in for. Files nothing refers to are marked **unused**
rather than hidden — a texture the exporter left behind, or a `.bin` for the
variant next to the one you opened. Images you brought in through **Add image…**
are marked **added**, since they are not part of the file until you download it.

Click a `.png`, `.jpg`, `.webp`, `.gif`, `.bmp` or `.avif` and it opens under
the tree at something like full size, on a checkerboard so alpha reads as alpha,
with its pixel dimensions beside its byte size. It is drawn straight from the
bytes on your disk, so an image nothing is bound to yet previews just as well as
one in use — which is the quickest way to find out which of five near-identical
`normal` maps is the one you want. Clicking it again puts it away. Compressed
containers (`.ktx2`, `.basis`, `.dds`) are listed but say plainly that a browser
will not decode them.

`Delete` removes the row the keyboard is on, and every row has an **×** on hover
that does the same. On a folder it removes everything below it, and the count
says how many. This only makes the app forget the file — **nothing on your disk
is touched** — so a URI it was covering moves straight to **Not supplied**, and
dropping the file back in undoes it completely. The `.glb` / `.gltf` itself is
not removable, since that is what **File → Close** is for. `↑`/`↓` walk the rows
and `←`/`→` close and open folders, as they do in the outliner.

Below the tree, **Not supplied** lists the references that found no file: the
`.bin` in red, because the preview cannot draw anything without it, and textures
in grey, because those only cost you a placeholder. **Add files… / Add folder…**
supply them without leaving the tab, and the list shortens as they arrive.

A `.glb` carries its data and textures inside it, so it normally shows up alone —
which is itself worth seeing.

### Properties

Selecting something fills the properties panel under the outliner, and the panel
describes exactly what was picked: a node is a node, so its tab is the only one —
the mesh it draws is named beside it in the outliner, and a **Mesh** link in the
panel jumps to it. Picking that mesh tabs **mesh / material**, the way the editor
tabs geometry and material.
Each tab renames its own entry and shows its index, plus type and child count
for a node, primitive count for a mesh, alpha mode and double-sidedness for a
material — with a visibility checkbox and Frame / Isolate buttons.

A mesh with several materials repeats the outliner's dropdown at the top of its
**material** tab, so which one you are editing is a choice you can make from
either end — and picking one in the outliner shows it in the panel, and the other
way round.

### Transform

A node's tab shows its **position, rotation and scale** as three draggable
numbers each, the way the editor's do: drag across one to scrub it, click it to
type an exact value, or nudge it with `↑`/`↓` (hold `Shift` for ten times the
step). Rotation is shown in degrees; the file stores a quaternion.

Selecting a node also puts a transform gizmo on it in the viewport. The toolbar
switches between **Move / Rotate / Scale** (`W` / `E` / `R`) and between dragging
along **World** or **Local** axes; clicking the active mode again puts the gizmo
away without losing the selection. Dragging it and typing in the fields are the
same edit — each shows up in the other immediately.

**Reset transform** puts a node back exactly as the file had it, down to the
representation: a node that stated a matrix gets its matrix back. Until it is
moved, that is: the panel decomposes a matrix for display, and the first edit
writes plain TRS and drops the matrix, since a node cannot legally carry both.
Putting every component back by hand clears the "moved" mark on its own.

**Reset all** (**File → Reset all changes**, or the Tools tab) does that for the
whole file at once, and for every other kind of edit with it: every name, every
moved node, every texture binding, and any image added along the way. It re-reads
the bytes the file was opened with, so the result is the file itself again rather
than an undo history walked backwards — and the preview reloads from those same
bytes. **Reset names** is still there for the names alone.

Mesh data has no transform of its own — only the nodes using it do — so the mesh
tab shows where it ended up instead: its **world origin**, its bounding **size**,
and how many instances of it are in the scene.

### Textures

Selecting a material gives it the five core PBR slots — base colour,
metal/roughness, normal, occlusion and emissive — each with a thumbnail of what
is bound and a picker listing every texture in the file. Bind one and the
preview repaints immediately, without re-parsing the model.

**Add image…** in the picker, or dropping an image file straight onto the slot,
brings in a new image: it becomes an image + texture in the document and is
bound in one step. On export a `.glb` swallows those bytes whole; a `.gltf`
references them, and the app tells you which files to save alongside it.

Assigning an emissive texture also sets the emissive factor to white when it is
still black, since glTF multiplies the two and the texture would otherwise be
invisible.

### 3D preview

The viewport is always live, and answers "which name is this?":

- Click any object to select it — the matching outliner row is highlighted and
  scrolled to, and the properties panel gives you the node it belongs to, its
  transform included; its mesh data and material are a click away from there
- Click a row (or focus its name field) to select it in the viewport
- Hover a row to outline it in the viewport. Hovering the *object* outlines that
  one object; hovering the *mesh* named beside it outlines every instance of that
  mesh, and a *material* outlines everything using it — which is the quickest way
  to feel the difference between the three
- Toggle visibility per node or mesh. When something is hidden because its
  parent is hidden, the row says so, and clicking its eye reveals the parent
- **Isolate** the selection, **Show all**, **Frame** and a grid toggle, from the
  toolbar under the viewport or the **View** menu
- Visibility is preview-only and never changes the exported file

The preview needs the actual geometry, so for a `.gltf` with external files it
asks for them — dropping the model's folder in is usually all it takes, and
**Add files / Add folder** does the same. Only the `.bin` is required; missing
textures render as placeholders. Renaming always works regardless.

three.js loads lazily, so the shell itself stays ~20 kB gzipped and the renderer
is only fetched once a file is open.

### Kept across reloads

Reloading the page — or coming back to it later — brings the file back exactly as
you left it, the way the [three.js editor](https://threejs.org/editor/) restores
its scene: the same renames, texture bindings and moved nodes, the same scene,
selection, sidebar tab and camera angle.

It is held in this browser's IndexedDB, on your device, and never uploaded — the
file still never leaves your machine. **Close** (or **File → Close**) is what
clears it; opening another file replaces it. Since nothing is lost to a reload,
there is no "unsaved changes" prompt on the way out — unless keeping the session
failed, which the app says at the time. Files over 256 MB are not kept, since
writing them would cost more than the restore is worth.

Only the document is stored. Which rows were collapsed, what is hidden in the
preview, and the filter text all start fresh.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # type-check + production build to dist/
```

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the site
and publishes it to GitHub Pages. One-time setup: in the repo's
**Settings → Pages**, set **Source** to **GitHub Actions**.
