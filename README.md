# Sceneforge

Rename scenes, nodes, meshes, materials, animations & more inside `.glb` / `.gltf`
files, and wire textures into material slots — entirely in your browser, with a
3D preview that shows you which name belongs to which object. Files are processed
locally and never leave your device.

**Live site:** https://ilya-nuhi.github.io/sceneforge/

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
- **Names** — the flat, category-by-category list of every name in the file
- **Tools** — find & replace, file info, download / reset / close

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
- Move, rotate and scale nodes — by dragging a gizmo in the viewport, or by
  typing exact numbers into the properties panel
- Edit any name inline — click to pick a row, click its name again to rename —
  with per-name revert and one-click reset
- Filter names, and find & replace across all of them (plain text or regex),
  with one-level undo
- The open file and every change to it survive a reload, the way the three.js
  editor's scene does

### Outliner

The **Scene** tab shows an outliner rooted at the scene, the way the editor's
does: objects nested under their parents, each object's mesh data nested under
it, and each mesh's materials under that. Every type has its own icon and colour
— empty/transform object, mesh object, camera, light, joint/bone, mesh data
(distinguishing meshes that carry a material from those that don't), material,
texture, image, animation, skin, material variant.

Rows collapse and expand, and anything the current scene doesn't reach is listed
below a "Not used in this scene" heading so it stays renameable. The same mesh or
material can appear in several places; editing one row updates them all, and
find & replace applies once per entry rather than once per row.

The **Names** tab lists everything flat, category by category — including the
types the outliner does not nest (scenes, skins, textures, images, animations,
cameras, lights, material variants).

### Properties

Selecting something fills the properties panel under the outliner, tabbed
**node / mesh / material** the way the editor tabs object / geometry / material.
Each tab renames its own entry and shows its index, plus type and child count
for a node, primitive count for a mesh, alpha mode and double-sidedness for a
material — with a visibility checkbox and Frame / Isolate buttons.

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
  scrolled to, and the properties panel gives you its node, mesh and material
- Click a row (or focus its name field) to select it in the viewport
- Hover a row to outline it in the viewport. Hovering a *node* outlines one
  object; hovering a *mesh* outlines every instance of it — which is the
  quickest way to feel the difference between the two
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
