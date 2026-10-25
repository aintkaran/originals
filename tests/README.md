# Tests

`npm test` runs the pipeline's checks, and the GitHub Action runs them before every sync - a failing test stops the publish.

- `tests/lib.test.mjs` - unit tests for the pure helpers: name validators (HEIC is accepted), meta.json parsing and the empty-gallery guard.
- `tests/exif.test.mjs` - the EXIF allow-list (no GPS/serials/dates) and the HEIC metadata reader.
- `tests/write-meta.test.mjs` - the meta.json write-back: human fields preserved, only the generated `exif` field regenerated, malformed files left untouched.
- `tests/heic-fixture.mjs` - a minimal synthetic HEIC container shared by the tests, plus an embedded real 64x48 HEIC (base64) for the decode path.
- `tests/e2e.test.mjs` - an end-to-end run over generated fixtures (a JPEG, a plain PNG, a Display P3 image, a 1000 px image, an EXIF-orientation-6 portrait, a 300 px image, a synthetic HEIC, a real heif-enc-encoded HEIC when libheif is on PATH, a corrupt file). It checks that the 1000 px original yields only the 600 px export, a 300 px original publishes at native size, a HEIC original is copied byte-identical with EXIF and WebP previews (graceful degradation when undecodable), a corrupt file is skipped while everything else publishes, no camera metadata leaks into the outputs and no camera data or auto-captions reach the manifest, a second run changes nothing, a meta.json-only edit leaves images untouched, deleting a source removes its exports, deleting a whole project removes its site folder, and emptying the gallery is held until a forced run.
