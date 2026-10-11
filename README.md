# SLS — Ink & Ignition

A procedural, stylized NASA Space Launch System Block 1, inspired by the chunky shapes, hard light bands and ink contours of early cel-shaded games. Built with the img2threejs skill and plain TypeScript / Three.js. All geometry is authored in code; no downloaded meshes.

Artemis II livery update: the major external markings now include the red NASA worms, AMERICA 250 emblems on both boosters, USA lettering, U.S. flags and Orion's NASA insignia and ESA identifier. Official NASA/AMERICA 250 vector outlines are converted to painted surface meshes, preserving them in the portable GLB. The small ESA identifier and national lettering use a simplified typeface; marking sizes and rear placement are adapted to the stylized model. Tiny serial stencils are omitted. Sources and placement limitations are recorded in `reference/livery-sources.json`.

## View

Open `SLS-viewer.html` directly in a browser; its renderer and model code are bundled into the file. Optional Google Fonts fall back to local fonts when offline. For development, run `npm install`, then `npm run dev`, and open the local URL printed in the terminal. The current session runs at http://127.0.0.1:5173/.

- Drag to orbit; scroll to zoom; click geometry to identify its assembly.
- Auto orbit, exploded view, ignition and reset controls.
- Export GLB downloads the assembled model with portable matte materials.

## Use the model

`src/createSLSModel.ts` exports `createSLSModel()`, returning `root`, `parts`, `nodes`, `setExplode(t)`, exhaust groups and disposal. Add `root` to a Three.js scene. The `root.userData.sculptRuntime` object exposes named assemblies, effect sockets, collider intent and separation metadata. A physics engine is not included.

`sls-cel.glb` is a portable mesh export. Its standard materials retain the palette, but the Three.js toon lighting and inverted hull outlines belong to the source renderer and are omitted from this export.

## Art direction and evidence

Orange foam core, twin white five-segment boosters, ribbed intertank, external feed line, upper adapter, Orion abort tower and four core engine bells. Dimensions are art-directed; this is not an engineering model. Rear hardware is inferred. The reference is NASA's [SLS illustration](https://www.nasa.gov/gallery/space-launch-system-illustrations/), saved in `reference/sls-nasa.jpg`.

The sculpt spec passes strict validation. TypeScript and the production build pass. Browser verification covers part picking, mode changes, GLB download, cardinal views, mobile rendering and loading the standalone file; results and screenshots are under `evidence/`. Part coverage reports all 16 specified components present. Four-angle coverage and volume checks pass. The full img2threejs photo-fidelity pipeline is **not certified complete**: the NASA image fails automatic foreground isolation, and its Tier 1 photo comparison rejects the different framing/background and intentionally stylized proportions. Those failures are retained, not overridden. PBR extraction and pixel projection are inapplicable to the requested nonphotographic finish.

Build: `npm run build`. Launch scripts use Vite; the code has no server-side component.
