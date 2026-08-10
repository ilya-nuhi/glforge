# glTF Renamer

Rename scenes, nodes, meshes, materials, animations & more inside `.glb` / `.gltf`
files — entirely in your browser. Files are processed locally with
[glTF Transform](https://gltf-transform.dev/) and never leave your device.

**Live site:** https://ilya-nuhi.github.io/gltf-renamer/

## Features

- Drag & drop a `.glb`, or a `.gltf` together with its `.bin` / texture files
- Edit any name inline, grouped by type (scenes, nodes, meshes, skins, materials, textures, animations, cameras)
- Filter names, and find & replace across all of them (plain text or regex)
- Per-name revert and one-click reset
- Export as a single self-contained `.glb`
- Round-trips all official Khronos (`KHR_*` / `EXT_*`) extensions

## Limitations

- Draco-compressed meshes are not supported yet (meshopt compression works)
- Unknown vendor extensions are dropped on export
- Output is always `.glb`, even when the input was a `.gltf`

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
