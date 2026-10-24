# originals (private)

The only place photos are dropped. One folder per project: the original files plus an optional `meta.json`. A GitHub Action turns them into optimized WebP and JPEG XL exports and a `manifest.json`, and commits those to the public site repo (`aintkaran/website3` in this trial). Vercel only serves the result; it does no image work.

## Daily workflow
1. On github.com, open (or create) a project folder here, drag the photos in, commit to `main`.
2. Wait for the green tick under the Actions tab, then check the site a few minutes later.

Uploading many photos at once makes one run; runs queue, they do not race. A failed run leaves the site untouched - the red X is in this repo's Actions tab.

## Files
- `<project>/<photo>.png|jpg|jpeg|webp|avif|tif|tiff` - the originals. HEIC/HEIF is rejected with a message: convert to JPEG or TIFF first.
- `<project>/meta.json` - optional. Fields: `project`, `order`, `date`, and `images`, a list of `{ "file": "<name without extension>", "title", "caption", "credit", "alt", "order", "exif" }`. Anything set here always wins. `"alt": ""` marks an image decorative on purpose. `"exif": false` turns off the auto-caption for that image. A broken meta.json gives a warning with line and column, and defaults are used.
- `config.json` - caption template, separator, camera/lens toggles, run limits.
- `scripts/sync.mjs` - the generator. `tests/` - unit and end-to-end tests (`npm test`); the Action runs them before every sync.

## Names
Rejected: stems ending in `-600`, `-1200`, `-2400`; two files whose names differ only by case or extension; names with `#`, `?`, `%` or non-ASCII. Warned: spaces in file names, spaces/uppercase in the folder name. The folder name is the project slug.

## What gets generated
Widths 600/1200/2400, never upscaled (only widths up to the original's width). Originals under 600 px wide are skipped with a warning. Every output is sRGB with all metadata stripped. A JPEG XL failure fails the run.

## Captions from camera data
Read from the original, whitelist only: Make, Model, LensModel, FocalLength, FocalLengthIn35mmFormat, FNumber, ExposureTime, ISO, DateTimeOriginal. GPS, serial numbers, owner names and everything else are never written anywhere. Default caption: `{focal} / f/{aperture} / {shutter} / ISO {iso}`. Precedence: `meta.json` caption, then auto caption, then empty. PNG exports from Photos or Lightroom usually carry no camera data; upload the JPEG, TIFF or DNG-derived file if you want captions.

## Alt text
Human-written only, set per image in `meta.json` (`"alt"`). It is never generated or overwritten. An image with no meta alt ships with an empty alt; `"alt": ""` marks an image decorative on purpose.

## Safety
- Sync, not diff: compares full contents with `.sync/state.json` in the site repo (SHA-256 of each source plus the settings used). Rerunning changes nothing.
- Aborts without pushing if a run would delete more than 25% of existing exports, or if there are zero images. Override only with the `force` input on a manual run.
- `node scripts/sync.mjs --target <site checkout> --dry-run` prints the plan and changes nothing.

## Setup checklist
- Repo visibility is private.
- Actions secret `WEBSITE3_DEPLOY_KEY` holds the private deploy key (the full multi-line block including BEGIN/END lines and a trailing newline). The matching public key is a deploy key on the site repo with "Allow write access" ticked.
- Workflow permissions are `contents: read`. The workflow never prints secrets or camera data.
- Bot commits use the GitHub no-reply identity. Check that Vercel deployed the first bot commit.
- Default branch is `main` in both repos. Enable email notifications for failed workflows.
- Browser uploads are limited to 25 MiB per file; larger files need `git push` (100 MiB hard limit). Avoid Git LFS.
- Replacing a photo under the same filename works; the hash changes and exports regenerate.
- Never edit `public/assets/projects/` in the site repo by hand; the next sync undoes it.
