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

The one exception is a download with compression chosen on the Tools tab,
which exists precisely to re-encode: see [Compression](#compression). Left as
it is, **Download** stays byte-for-byte.

## Layout

The UI follows the [three.js editor](https://threejs.org/editor/): a menubar
across the top (File / Edit / View / Add / Help), the viewport filling the window, and
a resizable 350px sidebar on the right — drag the divider, double-click it to
reset. The sidebar has four tabs:

- **Scene** — scene picker, name filter, the **+** that adds groups, shapes and
  lights, the outliner, and a properties panel
- **Animations** — the model's animations: pick, play, rename, copy, trim and
  delete them, and set their speed and direction
- **Files** — the folder the model was opened from, and what is missing from it
- **Tools** — find & replace, file info, reset / close (names, or everything),
  and the download, with its compression options

With more than one model open, the **Animations**, **Files** and **Tools** tabs are about one of
them — the one the selection is in — and a **Model** picker at the top of each
says which, and switches it.

The viewport's bottom-left read-out counts nodes, meshes, materials and how many
names have been changed.

Picking a row and renaming it are separate, the way they are in a file browser:
a click selects, and a second click on the name opens it for editing — so a
double-click does both. Keyboard: `↑`/`↓` walk the rows, `←`/`→` close and open
them (or step out to the parent / in to the first child), `Enter`, `F2` or just
typing opens the name, `Enter` or `Esc` closes it again. While a name is open
`←`/`→` belong to the caret, so they never interrupt typing. `F` frames the
selection (or everything), `W`/`E`/`R` switch the gizmo between move, rotate and
scale, `Space` plays and pauses the model's animation, `Delete` (or
`Backspace`) deletes the selection, `Esc` clears it, `Ctrl`+`S` downloads,
`Ctrl`+`Z` undoes the last change and `Ctrl`+`Y` (or `Ctrl`+`Shift`+`Z`) redoes it.

## Features

- Drag & drop a `.glb`, a `.gltf`, or **the whole model folder** anywhere on the
  page — subfolders and all. **File → Open folder…** does the same from a dialog
- Open **several models at once**, into one scene: every file dropped or opened
  is added alongside the ones already there, each with its own outliner tree,
  edits, undo and download
- Sidecars are matched by path, so a `textures/wood.png` in the glTF finds the
  file that sat there, however deep the folder was nested
- The **Files** tab shows that folder back to you, file by file, previews any
  image in it on a click, names the references nothing supplied covers, and lets
  you drop a file back out with `Delete`
- Move, rotate and scale nodes — by dragging a gizmo in the viewport, or by
  typing exact numbers into the properties panel
- Play a model's animations from the **Animations** tab — pick a clip, play,
  pause, stop, loop, play it in reverse, change its speed, scrub through it by
  hand, and rename it
- Delete objects and mesh data with `Delete`, **Edit → Delete** or the panel's
  **Delete** button, and take it back with `Ctrl`+`Z`
- Edit any name inline — click to pick a row, click its name again to rename —
  with per-name revert and one-click reset
- **Reset all** puts the whole file back the way it was opened — names,
  transforms and texture bindings together — and **Reset names** does the names
  alone. Both are in **File** and on the **Tools** tab
- Filter names, and find & replace across all of them (plain text or regex),
  with one-level undo
- The open files and every change to them survive a reload, the way the
  three.js editor's scene does

### Several models

Opening a file never closes the one before it: it joins the scene, the way the
three.js editor imports model after model. Drop two `.glb` files at once, pick
several in **File → Open file…**, or drop another one later — each is added. A
folder holding several models opens all of them; the files dropped with them go
to the model whose folder they sat in, and a file under no model's folder (a
`textures` folder beside a `models` one) goes to all of them.

Every model keeps its own document. Renames, moved and deleted objects, texture
bindings, the scene on show, **Reset names**, **Reset all**, **Download** and
**Close** all belong to one file and leave the others alone — so two files are
free to share material names, and a delete in one never renumbers the other.
Find & replace and `Ctrl`+`Z` reach across all of them.

The outliner has one **Scene** at its root, the way the three.js editor's does.
It belongs to no file: every model sits under it as an object of its own, named
after its file, with that file's objects nested below. Picking a model's row
picks the model as a whole: it is outlined in the viewport, its eye hides the
whole file at once, and its panel can hide, frame, isolate or close it.

Models arrive where their files put them, so they often start out on top of
each other at the origin. A model picked as a whole can be moved, rotated and
scaled with the gizmo or its panel's **Position / Rotation / Scale**, to get it
out of the way of the others. That placement belongs to the scene, not the file:
it survives a reload, **Reset placement** puts the model back, and a download
leaves the file exactly where it was. Moving an object *inside* a model is still
a change to that model's file, as before.

The **Files** and **Tools** tabs, the scene picker and `Ctrl`+`S` act on the
*active* model: the one the selection is in, or the one opened last. **File →
Close** closes that one; **File → Close all** closes every model.

### Undo and redo

`Ctrl`+`Z` (**Edit → Undo**) takes back the last change, whatever it was: a
rename, a find & replace, an object moved, rotated or scaled, a model moved in
the scene, a material value, a texture assigned or removed, a shadow flag, a
morph target's weight, a trim, a copied or deleted animation, a delete in the outliner, **Reset names**
or **Reset all**, and every change to the scene's own lights, shapes and groups
or to its lighting. `Ctrl`+`Y` or `Ctrl`+`Shift`+`Z` (**Edit → Redo**) puts it
back again; a new change after an undo drops what could have been redone.

Changes made in quick succession are one step: a name typed, the gizmo dragged,
a slider pulled or a number scrubbed come back whole, not a keystroke or a pixel
at a time. Undoing selects again what was selected when the change was made.
`Ctrl`+`Z` works while a name or a number field has the keyboard, since those
change the document as they are typed; the filter, find & replace and shader
code fields keep the browser's own undo for their text. Each scene has its own
history, kept while another scene is on show, of up to 100 steps. Opening,
importing and closing files are not steps: a closed model is gone from the
history, as it is from the scene.

### Several scenes

The picker above the sidebar's tabs holds the scenes there are to work in, each
with models, lights, shapes and groups of its own — one for every environment a
game has, say. Picking another scene switches to it: the one on show is put
away exactly as it is, edits and camera and all, and the other comes back the
way it was left. Only the scene on show is in the preview, so a switch reloads
its models.

**+** (or **File → New scene**) starts a new, empty scene; **Rename** (or **File
→ Rename scene…**, or the **Name** field of the **Scene** row's panel) renames
the one on show; **×** (or **File → Delete scene**) deletes it, and the models
in it, after asking. **File → Close all** empties the scene on show and leaves
the others be; with only one scene, it starts over altogether. Every scene is
kept across a reload.

### Importing a studio scene

**File → Import studio scene…** opens a scene exported from the studio — the
folder with `___main.json` and `___meta.json` in it — as a scene of its own,
named after it. Dropping that folder in does the same. Its lights, planes and
shapes become the scene's own objects, its empty nodes become groups, every
model node opens its model at the place the studio had it (a file placed eight
times opens eight times, each row named after its node), and the studio's
camera is the view it opens at. Scripts, fog and the background have no
counterpart here and are left out, which the import says.

### Outliner

The **Scene** tab shows an outliner rooted at the one Scene, then a row per open
model, then each model's objects — the contents of the file's scene on show, what
three.js loads as `gltf.scene` — nested under their parents, one row per object.
A file with more than one scene gets a **glTF scene** picker above the outliner.
The file's scene has no row of its own, since the model's row is the file: its
name is renamed in the model's panel, as **glTF scene**, and still counts as a
rename, reverts with **Reset names** and is reached by find & replace.

Several rows can be selected at once. `Ctrl`+click (`⌘`+click on a Mac) adds a
row to the selection or takes it out; `Shift`+click selects every row on screen
from the last one clicked to this one, and `Ctrl`+`Shift`+click adds that run to
what is selected already. Every selected row is lit and boxed in yellow in the
viewport; the one picked last is the one the properties panel and the gizmo
show. **Delete**, **Isolate** and **Frame** act on all of them — scene objects,
objects and mesh data across models alike, while a whole model in the selection
is closed — and `Ctrl`+`Z` brings back everything one delete took, at once.

An object is not split from what it draws. Right after its own name comes the
symbol for the mesh data it draws — the symbol alone, since a mesh almost always
carries the object's name over again and printing it twice says nothing; its name
is in the tooltip. A mesh with morph targets adds a chip saying how many, named
in its tooltip (see **Morph targets** below). Then come that mesh's materials by
name, the way the three.js editor's outliner prints an object's material after
its name. One material is a
chip; a mesh with several gets a dropdown saying how many. Picking any of them
selects it and fills the properties panel with it, hovering one outlines it in
the viewport, and a rename anywhere repaints it here. Mesh data no object in the
file draws still gets a row of its own, under the leftovers below.

Every type has its own icon and colour — empty/transform object, mesh object,
camera, light, joint/bone, mesh data (distinguishing meshes that carry a material
from those that don't), material, texture, image, animation, skin, material
variant. The Scene row collapses the whole tree, and a model's row its file.

Rows collapse and expand, and anything the file's scene doesn't reach is listed
below a "Not in the file’s scene" heading so it stays renameable. The same mesh or
material can appear in several places; editing one row updates them all, and
find & replace applies once per entry rather than once per row. The filter
searches what a row names as well as the row itself, so a material still turns up
its meshes, and a morph target's name the objects whose mesh has it.

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
dropping the file back in undoes it completely. `Delete` on the `.glb` / `.gltf`
itself closes the model, as **File → Close** does. `↑`/`↓` walk the rows
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
for a node and primitive count for a mesh — with a visibility checkbox, a
**Shadow** row for a node that draws a mesh (see **Shadows** below), and
Frame / Isolate buttons. A material's tab is its whole editor; see **Materials**
below.

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

A model picked as a whole gets the same gizmo and the same three rows, for where
it sits in the scene. Those move the model's group, not any node in its file, so
they are kept with the session rather than in the document, and a download never
carries them.

**Reset all** (**File → Reset all changes**, or the Tools tab) does that for the
whole file at once, and for every other kind of edit with it: every name, every
moved node, every material edit and texture binding, and any image added along
the way. It re-reads
the bytes the file was opened with, so the result is the file itself again rather
than an undo history walked backwards — and the preview reloads from those same
bytes. **Reset names** is still there for the names alone.

Mesh data has no transform of its own — only the nodes using it do — so the mesh
tab shows where it ended up instead: its **world origin**, its bounding **size**,
and how many instances of it are in the scene.

### Deleting

`Delete` (or `Backspace`) deletes what is selected — picked in the viewport, or
the outliner row the keyboard is on — and so do **Edit → Delete** and the
**Delete** button in the properties panel. The keyboard stays on the next row, so
pressing it again deletes that one too. `Ctrl`+`Z` takes deletes back one at a
time, newest first, and **Reset all** takes back all of them.

- An **object** goes with everything under it. What only it used goes too: mesh
  data nothing else draws, a skin nothing else is skinned with, and animation
  channels aimed at it — plus any animation left with no channel at all
- **Mesh data** goes on its own. The objects that drew it stay, empty, since
  they may have children of their own
- A bone something is still skinned to is refused, with the object named: delete
  that one first
- The **model** itself is closed, as **File → Close** does. `Ctrl`+`Z` cannot
  bring a closed file back, so one with edits in it asks first

glTF refers to everything by index, so a delete renumbers what came after it —
child lists, scene roots, skin joints, animation channels. Only the JSON
changes: the geometry stays in the binary data, unreferenced, so the download is
no smaller. Materials and textures stay as well, under "Not in the file’s scene"
when nothing uses them any more. References held inside vendor extensions
(`MSFT_lod`, `KHR_animation_pointer`) are not followed.

### Materials

A material's tab is the three.js editor's material panel, over the material's
glTF JSON. It leads with the **Type** — the three.js class the material loads
as — and the rows below are the ones that type has: MeshBasicMaterial has no
roughness or metalness, MeshStandardMaterial has them, MeshPhysicalMaterial adds
IOR and its layers.

glTF has one material model, so the type is stored the way GLTFLoader reads it:

- **MeshStandardMaterial** — plain glTF PBR: colour, emissive, roughness,
  metalness, the five core maps, side, alpha mode, opacity and alpha test
- **MeshBasicMaterial** — the same material with `KHR_materials_unlit`: colour,
  map, side and alpha, nothing lit. The PBR values are kept underneath, as the
  unlit spec asks, so switching back loses nothing
- **MeshPhysicalMaterial** — Standard plus the `KHR_materials_*` extensions:
  **IOR**, **Clearcoat**, **Sheen**, **Transmission** (with volume thickness,
  attenuation and dispersion), **Specular**, **Iridescence** and
  **Anisotropy**, each a folding section with its own maps. A section the
  material uses is marked, and open to begin with

Lambert, Phong, Toon, Matcap, Normal and Depth are listed but can't be picked:
glTF has no form for them, so a download could not keep them.

Every row writes straight into the document and onto the preview's material as
it changes — colours live while the picker is open, numbers while they are
scrubbed. A value put back to glTF's default is left out of the file rather
than written, and `extensionsUsed` is kept in step with the extensions the
materials use. Turning a Physical material into Standard removes its physical
extensions, and says which; **Reset all** brings them back.

### Textures

Every map row — the five core slots, and each physical extension's own — has a
thumbnail of what is bound and a picker listing every texture in the file. Bind
one and the preview repaints immediately, without re-parsing the model. A normal
map gets its scale, and an AO map its intensity, once one is bound.

Clicking the thumbnail, **Add image…** in the picker, or dropping an image file
straight onto the row brings in a new image: it becomes an image + texture in
the document and is bound in one step. On export a `.glb` swallows those bytes
whole; a `.gltf` references them, and the app tells you which files to save
alongside it.

glTF multiplies a texture by its factor, so binding one to a slot whose factor
is zero — emissive black, clearcoat or transmission 0 — lifts the factor to one
(or white) and says so; the texture would be invisible otherwise.

The sliders button at the end of a bound map row opens **Texture parameters**,
the three.js editor's texture dialog, stored the way glTF stores it:

- **Wrap S/T** and **Min/Mag filter** are the texture's sampler, so they change
  every map that uses the texture (the dialog says how many). A sampler other
  textures share is never edited under them — the texture gets one of its own.
- **UV set**, **Offset**, **Repeat** and **Rotation** are the map's own:
  `texCoord` and `KHR_texture_transform`, declared in `extensionsUsed` while
  anything uses it. glTF turns textures about the corner, so a **Center** is
  folded into the stored offset — every viewer turns it the same way — and kept
  in the transform's `extras.center` so the dialog can show it again.
- **Anisotropy** has no glTF form. It is kept in the sampler's
  `extras.anisotropy`; GLTFLoader does not read it, so your own code has to.
- **Mapping**, **Premultiply alpha** and **Color space** are shown but fixed:
  glTF maps by UV only, never premultiplies, and sets colour space by slot.

Changes show in the viewport and in the dialog's preview (the UV square, as the
shader samples it) as you make them. **OK** keeps them, **Cancel** or Escape
puts back what was there.

### Lights, shapes and groups

The scene has objects of its own besides the models, the way the three.js
editor's scene does. A new scene is lit by a **DirectionalLight** and an
**AmbientLight**, listed at the top of the outliner under **Scene**; the **+** at
the end of the Scene tab's filter row (or **Add** in the menubar) adds more:

- **Group** — an empty object to hang others off
- **Mesh** — Box, Sphere, Cylinder, Cone and Plane, unit-sized at the origin,
  the plane lying flat like a floor
- **Light** — Ambient, Directional, Hemisphere, Point and Spot

A new object goes inside the group that is selected, or next to whichever scene
object is selected, or else at the top of the scene. Selecting one — in the
outliner, or by clicking it in the viewport — gives it a panel of its own: its
name, its **Parent** (the scene, or another of its objects: this is how things
go into a group, and out again), position / rotation / scale with the gizmo,
colour, and for a light its intensity, plus distance and decay for point and
spot lights, the cone's angle and penumbra for a spot, and the ground colour for
a hemisphere — plus a **Shadow** section for the three lights that can cast one
(see **Shadows** below). Directional and spot lights also have a **Target**: the point in
world space they shine towards, the origin to begin with. A light's helper — the
editor's debug drawing of it, with the line to its target — only shows while
that light is selected; hovering its row outlines where it sits. An ambient
light is everywhere at once and has no place at all.

Rows rename, hide, frame and fold the way a model's do, and `Delete` takes an
object with everything under it — `Ctrl`+`Z` brings it back.

Besides its lights, the scene is lit by an **environment**: a room every material
reflects, which is what the preview always had. Select the **Scene** row to turn
it off — then the models are seen under their lights alone — or to change how
strong it is.

These objects are the scene's, not any file's, the way a model's placement is:
they are kept across a reload and never written into a download. (Ambient and
hemisphere lights have no glTF form at all.) A scene that has been added to or
changed stays on screen when its last model is closed, and is kept on its own;
**File → Close all** starts it over as a new scene.

### Shadows

Shadows are drawn the way the three.js editor draws them, with its switches in
the places it keeps them:

- The **Scene** row's panel has **Shadows** on or off for the whole scene, and
  the **Shadow type** — Basic, PCF, PCF Soft or VSM — that the editor's Project
  settings have. On, with PCF, to begin with; on costs nothing until something
  casts
- A light's panel has a **Shadow** section, folded like a material's
  extensions: **Cast**, then the shadow's **Intensity**, **Bias**, **Normal
  bias**, **Radius** and **Map size**. Directional, point and spot lights cast
  from the start, so a shape or a model told to cast shows its shadow without a
  trip to the light; an ambient or hemisphere light has no direction to throw
  one along, and no section
- A shape's panel, and a mesh node's, have the editor's **Shadow** row with
  **cast** and **receive**. A new box, sphere, cylinder or cone does both; a new
  plane only receives, being a floor. A model's nodes do neither until told to
  — three.js's own default — and the model's row has the same two boxes to set
  every mesh node in the file at once; while the nodes disagree, a box shows a
  dash, and a click sets them all
- The row sets everything under it too: a node's sets every mesh node below it,
  so ticking a character's root makes its body, hair and clothes all cast, and a
  shape's or a group's sets the shapes hung under it. It only ever shows the
  object's own two flags, so setting a child never changes what its parents
  show. A group — a node with no mesh, or one of the scene's own groups — keeps
  a pair of its own for this (a group node's in its extras, like a mesh node's),
  and has no row when nothing under it draws. Lights under a group keep their
  own **Cast**

A node's two flags are the one part of this that goes into the file: glTF has
no form for shadows, so they are kept in the node's `extras` — `castShadow` and
`receiveShadow`, each written only while it is on — the way an editor-only
material type is kept in `extras.threeMaterial`. GLTFLoader hands a node's
extras over as `object.userData`, so code loading the file can copy them onto
the object (the preview does exactly that); other viewers ignore them. They
count as edits (*shadow changes* in the Tools tab's file info), and **Reset
all** puts them back. Everything else — the scene's setting, and what its lights
and shapes are set to — is the scene's, kept across a reload and never
downloaded.

A directional light's shadow map is fitted each frame to what casts — the models
on show, and the scene's casting shapes — and a point or spot light's range to
the scene, so a shadow neither clips on a big model nor blurs away on a small
one. three.js on its own draws a directional shadow inside a fixed 10-unit box.

### Morph targets

A mesh with morph targets — Blender's shape keys — gets a **Morph targets**
section in its panel, and so does every node drawing it: a slider per target,
named the way the file's `extras.targetNames` names them (*Target 0*, *Target 1*…
where it names none), with the exact weight beside it to drag or type. The
slider covers the usual 0–1; the number goes past either end. The preview
follows as you drag.

They are easy to find. In the outliner, every object whose mesh has morph
targets carries a chip with their count, and clicking it opens them in the
panel. Filtering by a target's name — *smile* — leaves the objects that have
it. And a model's own row has a **morph targets** tab beside **model** that
gathers every one in the file, a section per object with the same sliders and a
**Select** button to go to it.

Weights are written into the file. glTF keeps them on the mesh, as the defaults
every node drawing it starts from, and a node may carry its own in place of
them: a node's panel edits whichever its file uses for it, the mesh's panel the
mesh's own. They count as edits (*morph changes* in the Tools tab's file info),
**Reset weights** puts a mesh's back the way the file had them — its own and
its nodes' — and so does **Reset all**.

Animations can drive the same weights. While a clip holds the model, the clip's
weights are what show; the ones set in the panel are what the model comes back
to once it is stopped, and the section says so for a mesh that is animated.

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

### Animation

Everything about a model's animations is on the **Animations** tab. It lists
the clips one row each: its index, its name and its length, with a ▶ that plays
or pauses that clip. Clicking a row picks it; double-clicking it (or `Enter` /
`F2` on it) opens its name in the panel at the bottom, which also shows its
channel count, how many nodes it moves and which of their properties. `↑`/`↓`
walk the rows and `Space` plays the one the keyboard is on. The list comes from
the document rather than the preview, so a model the preview cannot draw still
has its animations listed and renameable — only playing them needs the preview.
Renamed clips count towards **renamed**, and **Reset names** puts them back.

Under the list, **Playback** holds the controls for the picked clip:

- **Play / Pause** and **Stop**. `Space` plays and pauses from anywhere, and so
  does **View → Play animation**
- **Reverse** plays from the end towards the start. Turned on mid-clip, the clip
  turns round where it stands; at rest, **Play** starts it from its last frame
- **Loop** starts a clip over when it runs out — in either direction. With it
  off, a clip stops on its last frame (its first, in reverse), and **Play**
  starts it again
- The **Time** scrubber holds the model at any instant — a clip that was
  playing waits out the drag and carries on from where you let go
- **Speed** is a multiple of the clip's own pace, from 0.01× to 10×. Drag
  across it, type a value, or nudge it with `↑`/`↓` (`Shift` for ten times the
  step). A clip that is playing carries on at the new pace

Speed, **Reverse** and **Loop** are one setting for every open model, the way
the grid is.

**Stop** puts the model back exactly as the file poses it. Playback is
preview-only, like visibility: it never changes the exported file, and the
viewport only draws continuously while a clip is actually playing.

While a clip holds a model posed — playing, paused or scrubbed — the transform
gizmo stays off that model, since a drag would read the clip's pose rather than
the file's. Numbers typed into the properties panel still go into the file, and
the model takes them up as soon as the clip stops.

With several models open, the tab is about the active one, as the scene picker
is: select something in another model to get its clips, or switch it with the
tab's **Model** picker. Each model keeps its own playback, so two characters can
play side by side. A reload that only changes how a model looks — a texture,
added files, a delete — keeps its clip playing where it was, as long as the
file still has the same animations; a delete that takes a whole animation with
it starts playback over from rest.

### Copying and trimming animations

**Copy** in the animation's panel adds a copy after the others, named
"Walk copy". It animates the same nodes from the same keyframes — only the entry
is new — so it costs next to nothing, and the two differ once one of them is
trimmed. That is the way to cut several clips out of one long take: copy it once
per clip, trim each copy, and delete or keep the original.

**Trim** sets where the clip starts and ends, in seconds of its own timeline:
drag across either number, type one, or play or scrub to the moment and press
**Start here** / **End here**. **Full length** takes the trim off again. The
preview plays the trimmed stretch straight away — the scrubber, the length in
the list and the loop all follow it — and the list marks a trimmed clip's length
in blue.

While you edit, a trim is only a range kept with the animation, so it can be
moved as often as you like and survives a reload. The download is where it
becomes keyframes: every channel is cut at the two ends, the keys in between are
kept, and each end gets a key of its own sampled exactly where it falls —
following the curve for linear, stepped and cubic-spline keys alike, and the
sphere for rotations — so the motion is the same, just shifted to start at 0. A
`.glb` gets the new keyframes on the end of its binary chunk; a `.gltf` gets them
in an embedded buffer of their own, so the `.bin` it refers to is left untouched.
The keyframes the file had stay in its data, unreferenced, the way a delete
leaves geometry behind. Keyframes compressed with meshopt, or stored as sparse
data, cannot be read, and the panel says so instead of offering the trim.

**Delete** (or `Delete` on the row) takes an animation out of the file.
`Ctrl`+`Z` takes back copies and deletes alike, newest first, and **Reset all**
takes back all of them along with every trim.

### Compression

There is one **Download** — the button in the Tools tab's **Download** panel,
**File → Download** and `Ctrl`+`S` — and the panel's options decide what it
writes. With every one of them left **As is**, it is the plain download: the file
as edited, in its own format, with its data copied byte for byte, and the button
says **Download .glb** or **Download .gltf**. Choose anything else — a geometry or
texture format, a max size, dropping unused data — and the button says
**Download compressed .glb** (or `.zip`, or `.gltf`, by the **Format**), and the
same click re-encodes instead.

**Format**

- **As is** — the opened file's own kind. A `.glb` stays one `.glb`; a `.gltf`
  that gets compressed comes as a `.zip`, since its `.bin` and textures are not
  the files beside it any more
- **.glb** — one file, everything inside it
- **.gltf + files (.zip)** — the `.gltf`, one `.bin` and every texture as a file
  of its own, zipped. A texture keeps the path its `.gltf` gave it
  (`textures/wood.png`), or is named after itself; its extension follows its
  format, so a PNG turned KTX2 is a `.ktx2`. Paths that would climb out of the
  folder (`../`) are flattened
- **.gltf, embedded** — one `.gltf` with its data and textures inline as base64:
  self-contained, and about a third bigger than a `.glb`

Picking another kind of file is enough on its own: with nothing compressed, the
button says **Download .zip** (say), and the file is rewritten into that shape
with its geometry and textures as they were. A `.glb` downloaded as `.glb` needs
no rewriting and is still the byte-for-byte copy.

A compressed download starts from exactly what the plain one would write — every
rename, move, delete, trim and added image — so it is a way of shipping your
edits, not a separate edit: the open file and its session are left as they
were. Unlike everything else in the app it does decode and re-encode, using
[glTF Transform](https://gltf-transform.dev/), in a worker so the page stays
responsive; the progress shows under the button, and **Cancel** stops it.

**Geometry**

- **Draco** — the smallest geometry. Loaders need a Draco decoder
  (`DRACOLoader` in three.js)
- **Meshopt** — `EXT_meshopt_compression`: decodes very fast and shrinks much
  further under gzip or brotli. **Level High** also filters normals and
  animation keys, lossily. Loaders need its decoder (`setMeshoptDecoder`)
- **As is** leaves whatever the file had — re-encoded the same way when some
  other option makes it a compressed download; **None** decodes Draco or
  meshopt, for loaders without either
- **Precision** sets how finely both snap vertex data to a grid, as a
  percentage with a slider beside it: **Original** is 100%, **High** 90%,
  **Medium** 75% and **Low** 50%. Picking one moves the slider there; dragging
  the slider makes it **Custom**, and choosing Custom from the list starts from
  wherever the slider already is. The line under it gives the bits that works
  out to — 16-bit positions at High, 14 at Medium, 12 at Low, down to 8 at 1%,
  with normals, UVs and colours scaled alongside
- **Original** (or Custom at 100%) is lossless: Draco stores the attributes
  unquantized, and meshopt skips quantizing and filtering altogether, so
  **Level** and **Positions** have no say there. The file is bigger than at any
  lower setting, but every vertex comes back exactly
- Draco only quantizes vertex data stored as floats, so data another tool has
  already stored as integers — meshopt or gltfpack output, or this panel's own —
  is turned back into floats first, and the precision applies to it as it
  would to any other file. At Original those integers are kept as they are:
  Draco stores them exactly, and far smaller than floats. Joint indices and
  custom attributes (`_ID` and the like) are never touched

Meshopt leaves positions as floats unless **Positions: Quantize** is ticked.
Quantized positions are smaller, but they only come back to size through a
scale and offset on the node drawing the mesh — so that node's transform
changes, and a node that has children gets a new unnamed child to hold the mesh.
Draco dequantizes on its own and never touches a node.

**Textures**

- **WebP** / **JPEG**, with a **Quality** of 1–100. Smaller downloads, but full
  size once in video memory. WebP needs `EXT_texture_webp`, and a browser that
  cannot write it (Safari) leaves the textures alone and says so; JPEG leaves
  textures with transparency alone. A texture the re-encode would make bigger
  keeps its original
- **KTX2 · ETC1S** / **KTX2 · UASTC** — Basis Universal, which stays compressed
  in video memory and is transcoded to whatever the GPU reads (`KTX2Loader`).
  ETC1S is the smallest, **Quality** 1–255. UASTC keeps far more detail and is
  bigger, **Level** 0–4, always zstd-supercompressed; **RDO** makes it smaller
  still for a little quality. With ETC1S, **Normal maps as UASTC** (on by
  default) spares normal maps the block artefacts ETC1S gives them
- Colour maps are encoded as sRGB, and normal, metal/rough and occlusion maps as
  linear data, as glTF defines them. Mipmaps are generated
- **Max size** scales anything larger down, keeping its shape. KTX2 also rounds
  both sides to a multiple of 4, as `KHR_texture_basisu` requires, and halves
  anything over the encoder's 12-megapixel limit
- Textures that are already KTX2 are left as they are

**Preview: In viewport** shows the textures in the viewport as the download
would carry them, before anything is downloaded. Every image a material shows is
encoded with the current Textures, Quality and Max size choices, through the same
encoder the download uses, and each replaces its original on screen as soon as
it is done. Move the Quality slider and the preview follows once the slider
rests. Under the checkbox is the textures' size before and after, plus any
texture that would stay as it is, and why. The preview only changes what the
viewport draws: edits still apply to the file's own textures, and unticking the
box (or choosing **As is** for both Textures and Max size) puts the originals
back. It starts unticked on every page load, since it encodes every texture.
Geometry compression is not previewed.

**Unused: Drop** removes meshes, materials, textures and skins nothing in the
file uses, and merges identical textures and accessors. Nodes always stay, and
materials that differ only in name stay two materials. Geometry a delete left
behind in the binary is dropped either way, so a compressed download is where
deletes finally make the file smaller.

The output goes out under the model's own name, whatever its kind. Rewriting a
`.gltf` means every file it refers to must have been supplied, and the panel
names any that were not. glTF Transform keeps names on everything, but
drops vendor extensions it does not know, and texture names in favour of image
names. The panel remembers its settings in this browser, starting from **As
is** everywhere, so a new browser always downloads the file as it is.

The encoders are fetched only when an export needs them — glTF Transform,
meshopt and Draco come to roughly a megabyte, and the Basis encoder for KTX2 to
about 3 MB of wasm — so the page itself is no heavier for any of this.

### Kept across reloads

Reloading the page — or coming back to it later — brings the files back exactly
as you left them, the way the [three.js editor](https://threejs.org/editor/) restores
its scene: the same renames, texture bindings, moved and deleted objects, the
same scene, the scene's own lights, shapes and groups, selection, sidebar tab
and camera angle. Deletes can still be reset
after a reload, though not undone one by one with `Ctrl`+`Z`: the undo history
starts over on every load.

It is held in this browser's IndexedDB, on your device, and never uploaded — the
files still never leave your machine. Each model is kept on its own, so
**Close** (or **File → Close**) drops that one file from what is kept, and
**File → Close all** clears the scene on show from it (everything, with only
one scene). Since nothing is lost to a reload, there is
no "unsaved changes" prompt on the way out — unless keeping the session failed,
which the app says at the time. A file over 256 MB is not kept, since writing it
would cost more than the restore is worth; the others still are, and the prompt
comes back for that one file's changes.

Only the document is stored. Which rows were collapsed, what is hidden in the
preview, what was playing, and the filter text all start fresh.

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
