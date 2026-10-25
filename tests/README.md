# Tests

`npm test` runs the pipeline's checks, and the GitHub Action runs them before every sync - a failing test stops the publish.

- `tests/lib.test.mjs` - unit tests for the pure helpers: name validators, meta.json parsing and the empty-gallery guard.
- `tests/exif.test.mjs` - the EXIF allow-list (no GPS/serials/dates).
- `tests/write-meta.test.mjs` - the meta.json write-back: human fields preserved, only the generated `exif` field regenerated, malformed files left untouched.
- `tests/e2e.test.mjs` - an end-to-end run over generated fixtures (a JPEG, a plain PNG, a Display P3 image, a 1000 px image, an EXIF-orientation-6 portrait, a 300 px image, an unsupported HEIC file, a corrupt file). It checks that the 1000 px original yields only the 600 px export, a 300 px original publishes at native size, an unsupported HEIC file is skipped with a clear warning, a corrupt file is skipped while everything else publishes, no camera metadata leaks into the outputs and no camera data or auto-captions reach the manifest, a second run changes nothing, a meta.json-only edit leaves images untouched, deleting a source removes its exports, deleting a whole project removes its site folder, and emptying the gallery is held until a forced run.
