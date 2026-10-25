// Writes the camera EXIF block of each photo into its project's meta.json in
// originals. Human fields (title, caption, credit, alt, order, project, date,
// and anything unknown) are preserved exactly; only the generated `exif` field
// is added, updated or removed. A meta.json that cannot be parsed is left
// untouched with a warning - unparseable human data is never overwritten.
// Usage: node scripts/write-meta.mjs [--source .]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { exifText, extractHeicExif } from './exif.mjs';
import { IMAGE_EXT_RE, HEIC_EXT_RE, parseMeta, metaImageMap } from './lib.mjs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const SRC = path.resolve(opt('--source') || '.');
const SKIP_DIRS = new Set(['node_modules', 'scripts', 'tests', 'docs']);

const warnings = [];
let changedFiles = 0;

const dirs = (await readdir(SRC, { withFileTypes: true }))
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name)).map(d => d.name).sort();

for (const slug of dirs) {
  const dir = path.join(SRC, slug);
  const files = (await readdir(dir)).filter(f => IMAGE_EXT_RE.test(f) || HEIC_EXT_RE.test(f)).sort();
  if (!files.length) continue;

  const metaPath = path.join(dir, 'meta.json');
  let meta = {}, malformed = false;
  try { meta = JSON.parse(await readFile(metaPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') { malformed = true; warnings.push(`${slug}: meta.json is malformed (${e.message}); left untouched.`); } }
  if (malformed) continue;

  const existing = metaImageMap(meta); // file stem -> human entry (preserved)
  const images = [];
  for (const f of files) {
    const heic = HEIC_EXT_RE.test(f);
    const stem = f.replace(heic ? HEIC_EXT_RE : IMAGE_EXT_RE, '');
    let exif = '';
    try {
      const buf = await readFile(path.join(dir, f));
      if (heic) { const eb = extractHeicExif(buf); exif = eb ? exifText(eb) : ''; }
      else { const em = await sharp(buf).metadata(); exif = em.exif ? exifText(em.exif) : ''; }
    } catch { exif = ''; }
    const entry = { ...(existing.get(stem) || {}), file: stem };
    delete entry.exif; // regenerated below; everything else stays as the human wrote it
    if (exif) entry.exif = exif;
    images.push(entry);
  }

  const next = { ...meta, images };
  const nextText = JSON.stringify(next, null, 2) + '\n';
  let prevText = null;
  try { prevText = await readFile(metaPath, 'utf8'); } catch { /* missing */ }
  if (prevText !== nextText) { await writeFile(metaPath, nextText); changedFiles++; console.log(`updated ${slug}/meta.json`); }
}

for (const w of warnings) console.log('WARN', w);
console.log(changedFiles ? `${changedFiles} meta.json file(s) updated.` : 'meta.json already up to date.');
