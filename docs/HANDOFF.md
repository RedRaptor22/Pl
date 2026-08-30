# Plume + Anvil — project handoff

Everything a fresh session needs to pick this up. Written to be pasted into a
new chat as context.

**Last updated at** `Pl@f685d2f` (branch `claude/plume-handoff-ozu2u5`) and
`Anvil@d894c1b` (branch `main`).

---

## 1. What this is

**Plume** is a 3D sketchbook that runs in a browser — a recreation of
[Feather 3D](https://www.feather.art/) (Sketchsoft; SIGGRAPH '23 paper). You
draw 3D *guide surfaces*, then draw strokes onto them, orbiting the sketch as
you go.

**Anvil** is the Android build of the same product, in Kotlin and OpenGL ES 3.0.
Not a WebView wrapper.

| | Pl (web) | Anvil (Android) |
|---|---|---|
| repo | `RedRaptor22/Pl` | `RedRaptor22/Anvil` |
| branch | `claude/plume-handoff-ozu2u5` (PR #1 open) | `main` |
| language | ES5 JavaScript | Kotlin |
| renderer | Three.js **r128**, vendored | OpenGL ES 3.0, direct |
| live | https://redraptor22.github.io/Pl/ | APK from CI artifacts |
| tests | 584 in-browser checks + 13 in `pt_test.js` | 19 JVM unit tests |

### Hard constraints on Pl — do not break these

- **No build step, no bundler, no package manager.** `Plume/plume.html` is a
  plain page of `<script>` tags and opens from disk.
- **ES5 style.** `var`, no arrow functions in app code, matching what is there.
- **Everything hangs off one global `P`.** No modules, no imports.
- Three.js is vendored at `Plume/js/vendor/three.min.js` and stays r128.

---

## 2. Layout

### Pl (web) — ~10,800 lines

```
Plume/plume.html   markup, CSS, SVG icon sprite, the whole UI shell
Plume/js/core.js       369  vector maths, tangents, transportFrames, clamp/uid
Plume/js/strokes.js   1631  stroke model, brush table, geometry, groups, erase
Plume/js/guides.js    1702  guide surfaces, sweep, bend, loft, primitives, snap
Plume/js/tools.js     1956  every tool, history, symmetry, fill, transform
Plume/js/ui.js        1904  panels, rails, bindings, refresh
Plume/js/camera.js     763  orbit, grid, axis, lighting, ground shadow
Plume/js/doc.js        579  serialize/restore, autosave (IndexedDB)
Plume/js/input.js      578  pointer events, pressure, tilt, palm rejection
Plume/js/export.js     544  OBJ+MTL, STL, glTF
Plume/js/app.js        335  frame loop, scene wiring
Plume/js/fx.js         227  DOF, grain, pixelate post pass
Plume/js/import.js     232  OBJ/STL parsers, image loading
Plume/test.html       ~5k   the 584-check suite (drives the app in an iframe)
Plume/pt_test.js      187   frame maths alone, no browser: `node Plume/pt_test.js`
```

### Anvil (Android)

```
core/   pure Kotlin, ZERO android.* imports — compiles and tests on a plain JVM
   Vec3.kt      vectors, MM constant, clamp
   Frames.kt    computeTangents, transportFrames, arcLengths, loopsClosed
   Dedupe.kt    spur removal
   Stroke.kt    brush table, segmentsFor, sectionPoint, geometry builder
   Surface.kt   SurfaceMesh triangle grid, nearestPoint, Reproject
app/    Android only — GL renderer, gestures, activity. COMPILES, NEVER RUN.
```

---

## 3. Domain concepts you need

- **Guide-as-sweep.** A guide surface is `surface(u,v) = path[v] + local[u]·frame`
  — a profile carried along a path by rotation-minimising frames.
- **Rotation-minimising frames** by double reflection (Wang et al. 2008), in
  `P.transportFrames`. A Frenet frame would flip at an inflection; this does not.
- **Units.** `P.MM = 0.001`. One world unit is 1000 mm = **1 metre**. Brush sizes
  are in mm. OBJ/STL export scales to mm; **glTF exports in metres** (spec).
- **Provenance annotations.** Comments are marked `FACT` (documented Feather
  behaviour, with a section ref like C.9), `INFERENCE`, or `GUESS`. Keep this up
  — it records what is known versus chosen.
- **Closed loops.** A stroke whose last point is its first is welded shut: no
  caps, the final band wraps to ring 0. Detected from geometry, not a flag.

---

## 4. How to test (exact commands)

```bash
# web app + suite — needs a server, the suite drives an iframe
cd Plume && python3 -m http.server 8125
#   app   http://127.0.0.1:8125/plume.html
#   tests http://127.0.0.1:8125/test.html

node Plume/pt_test.js          # frame maths only, no browser

cd anvil && ./gradlew :core:test -PcoreOnly    # Kotlin core, JDK only
```

**Headless driving.** Playwright lives at
`/opt/node22/lib/node_modules/playwright`, Chromium at `/opt/pw-browsers`.
Do **not** run `playwright install`.

**The suite has an async tail.** `flush()` is called twice — the first summary
(~467 checks) is only the synchronous sweep; the timer-driven tests keep
appending for ~45s. Wait for the count to stop moving or you will report the
wrong number. This caused a real mis-report once.

---

## 5. Current state

**Pl: 584 checks passing.** Feature-complete against most of Feather. Recently
added: radial symmetry, symmetry fold indicator, reference layers + delete,
glTF export, torus primitive, guide reprojection.

**Anvil: 19 core tests passing, APK builds in CI.** The renderer, gestures and
activity **compile but have never drawn a frame on a device.** That is the
single highest-value next action.

### Known open items

- Fill does nothing on primitive guides (fails loudly with a toast). Real gap —
  `surfaceSpan` needs a sweep grid or a flat plane; primitives have neither.
- Feather parity still missing: background *image*, video/turntable export,
  animation, AR.
- Rectangle brush width is pinned at 22.4 mm by `halfWidthMM`.
- Concave-corner fill coverage 92.6% at a 90 mm nib.
- Undoing an erase re-adds the stroke at the end of the list, changing z-order.
  Measured as **not visible** (three.js sorts by depth) — left alone deliberately.

---

## 6. Decisions already made — do not silently reverse

- **Symmetry composes.** Mirror × radial = a rosette, not a pinwheel: the copy
  is mirrored first, then rotated into its sector. `symmetryMatrices` never
  includes the identity.
- **Reprojection is gated on the Clamp setting**, which already promised
  "strokes leaving the guide clamp to its nearest point".
- **The cube brush uses `paint:1`** (flat), chosen by the user over `paint:'top'`.
- **The mirror fold is drawn as a bounded plane**, not a line — edge-on it reads
  as the line, orbited it stays truthful.
- **Anvil's UI is deliberately NOT ported.** A phone wants bottom sheets and a
  radial menu, not a 58px vertical rail.
- **The app is named Anvil**, not Plume. Confirmed by the user.

---

## 7. Bugs found the hard way — the lessons generalise

1. **Nearest-surface query indexed vertices.** A guide is coarse (520 vertices,
   896 triangles), so a point can lie exactly *on* a big triangle while the
   nearest vertex is 67 mm away on a different one. It slid correct points 21 mm
   *along* the surface. **Index triangles.** Caught only by checking against
   brute force.
2. **Ring-based cell search broke on a flat surface.** A plane has no extent in
   one axis, so the cell size hits the 1e-6 floor, a point 50 mm off lands at
   cell index 50000, and the clamped range is empty — the query scanned nothing
   and silently reported "already on the surface". **Grow by world radius.**
3. **Shader recompiles per pointermove.** `S.rebuild` disposed the material each
   time; disposing a `ShaderMaterial` frees its GL program. 90 links across a
   90-move drag — invisible on desktop, seconds of freeze on a phone.
4. **The suite leaked global state.** `reset()` restored the background but not
   the light or FX, so one group silently darkened every later pixel reading.
5. **A stale helper tinted pixel tests.** The symmetry fold's visibility only
   refreshed on the next frame.

### Working method that keeps paying off

**Measure before claiming.** Screenshots and framebuffer/geometry readback
repeatedly overturned confident reasoning — lasso "worked" by attribute but
rendered nothing; DOF looked broken but the *test scene* was flat; a 68 mm
"error" was the probe measuring vertex distance instead of surface distance.
Several probes were wrong before the code was. Verify the probe first.

---

## 8. Conventions

- Commit messages are prose explaining *why*, including what was measured and
  what was wrong before. No model identifiers anywhere in the repo.
- Tests assert the *unfixed* behaviour too where possible, so they cannot pass
  vacuously (e.g. the closed-loop test checks an open ring really is 5.625° off).
- Deployment is automatic: `.github/workflows/pages.yml` publishes on every push
  to the branch. Anvil's CI builds an APK artifact on every push.
