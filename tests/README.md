# Tests

`npm test` runs the pipeline's checks, and the GitHub Action runs them before every sync - a failing test stops the publish.

- `tests/lib.test.mjs` - unit tests for the pure helpers: name validators, meta.json parsing and the deletion guard.
- `tests/e2e.test.mjs` - an end-to-end run over generated fixtures (a JPEG, a plain PNG, a Display P3 image, a 1000 px image, an EXIF-orientation-6 portrait, a 300 px image). It checks that the 1000 px original yields only the 600 px export, tiny files are skipped, no camera metadata leaks into the outputs and no camera data or auto-captions reach the manifest, a second run changes nothing, a meta.json-only edit leaves images untouched, deleting a source removes its exports, and an empty originals folder aborts the run.
