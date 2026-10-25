# originals

The only place photos are dropped. One folder per project: the original files plus an optional `meta.json`. A GitHub Action turns them into optimized WebP and JPEG XL exports and a `manifest.json`, and commits those to the public site repo (`aintkaran/website3` in this trial). Vercel only serves the result; it does no image work.

## Daily workflow
1. On github.com, open (or create) a project folder here, drag the photos in, commit to `main`.
2. Wait for the green tick under the Actions tab. Vercel deploys after a successful sync; how long that takes depends on the run and the deploy, so no fixed timing is promised.

Uploading many photos at once makes one run; runs queue, they do not race. A failed run leaves the site untouched - the red X is in this repo's Actions tab.

## Files
- `<project>/<photo>.png|jpg|jpeg|webp|avif|tif|tiff` - the originals. HEIC/HEIF (iPhone photos) and video files are not supported: the sync skips them with a clear warning and publishes everything else. Convert iPhone shots to JPEG first (iOS can do this automatically: Settings > Camera > Formats > Most Compatible, or share as JPEG).
- `<project>/meta.json` - optional to write, always maintained. Fields: `project`, `order`, `date`, and `images`, a list of `{ "file": "<name without extension>", "title", "caption", "credit", "alt", "order" }`. Anything set here always wins. Captions are human-written here; they are never read from camera data. `"alt": ""` marks an image decorative on purpose. A broken meta.json gives a warning with line and column, and defaults are used. After each sync the workflow writes the camera EXIF block into this file (only the generated `exif` field; human fields are never touched) and commits it back with a `[skip ci]` marker so it does not retrigger itself. The write re-reads the latest main before committing, retries if a concurrent edit wins the race, and never force-pushes. A malformed meta.json is left untouched rather than overwritten.
- `config.json` - run limits.
- `scripts/sync.mjs` - the generator. `scripts/exif.mjs` - the dependency-free EXIF reader (JPEG/TIFF EXIF). `scripts/write-meta.mjs` - the EXIF write-back. `tests/` - unit and end-to-end tests (`npm test`); the Action runs them before every sync.

## Names
Rejected: stems ending in `-600`, `-1200`, `-2400`; two files whose names differ only by case or extension; names with `#`, `?`, `%` or non-ASCII. Warned: spaces in file names, spaces/uppercase in the folder name. The folder name is the project slug.

## What gets generated
Widths 600/1200/2400, capped at each photo's own width; a photo smaller than 600 px ships at its native size instead of being skipped. WebP quality 90, JPEG XL quality 90. Every output is sRGB with all metadata stripped. A corrupt or unreadable file is skipped with a warning and everything else still publishes; failing tests or an unreadable project folder stop the whole run before anything is published.

## EXIF
Each run reads camera, lens and exposure details (camera, lens, focal length, aperture, shutter, ISO, exposure bias) from the originals and publishes them as one plain-text `exif` string per image in `manifest.json`, in each project's public `meta.json` on the site, and in the `exif` field written back here. The site keeps it visually hidden in the page but it is in the DOM and the manifest for crawlers and agents. It is separate from `caption` and `credit`, which stay human-written. Images with no EXIF get an empty string. GPS, serial numbers, owner/artist/copyright and dates are never read. The exported images themselves stay metadata-free.

## Alt text
Human-written only, set per image in `meta.json` (`"alt"`). It is never generated or overwritten. An image with no meta alt ships with an empty alt; `"alt": ""` marks an image decorative on purpose.

## Safety
- Sync, not diff: compares full contents with `.sync/state.json` in the site repo (SHA-256 of each source plus the settings used). Rerunning changes nothing.
- Deleting a project folder here deletes its outputs on the site on the next run. One rule guards the edge case: an automatic run never publishes an empty gallery. Emptying the whole site takes a manual run with the `force` input. There is no percentage rule.
- If the originals folder or a project folder cannot be read, the run aborts and changes nothing: a failed read is never treated as a deletion.
- `node scripts/sync.mjs --target <site checkout> --dry-run` prints the plan and changes nothing.
- The repair run is the same sync on a weekly schedule (Wednesdays, off the top of the hour; GitHub schedules run in UTC and can be delayed at busy times) plus the manual Run button. It fills anything missing on the site and removes outputs whose project was deleted here. It cannot restore photos whose source folder is gone from originals; that recovery is git history or re-uploading.

## Setup checklist
- Repo visibility is the owner's setting; nothing in the pipeline depends on it.
- Actions secret `WEBSITE3_DEPLOY_KEY` holds the private deploy key (the full multi-line block including BEGIN/END lines and a trailing newline). The matching public key is a deploy key on the site repo with "Allow write access" ticked.
- Workflow permission is `contents: write`, needed for the meta.json EXIF write-back. The workflow never prints secrets.
- Bot commits use the GitHub no-reply identity. Check that Vercel deployed the first bot commit.
- Default branch is `main` in both repos. Enable email notifications for failed workflows.
- Browser uploads are limited to 25 MiB per file; larger files need `git push` (100 MiB hard limit). Avoid Git LFS.
- Replacing a photo under the same filename works; the hash changes and exports regenerate.
- Never edit `public/assets/projects/` in the site repo by hand; the next sync undoes it.
