// Syncs ./<project>/ originals into optimized exports + manifest.json + per-project
// meta.json in a website checkout.
// Usage: node scripts/sync.mjs --target ../website3 [--dry-run] [--force]
import { readdir, readFile, writeFile, mkdir, rm, access, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { z } from 'zod';
import encodeJxl, { init as initJxl } from '@jsquash/jxl/encode.js';
import { exifText, parseExif, extractHeicExif, heicDimensions } from './exif.mjs';
import {
  WIDTHS, IMAGE_EXT_RE, HEIC_EXT_RE, parseMeta, metaImageMap, validateNames, deletionGuard
} from './lib.mjs';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DRY = flag('--dry-run');
const FORCE = flag('--force') || process.env.FORCE === 'true';
const SRC = path.resolve(opt('--source') || '.');
const TARGET = path.resolve(opt('--target') || process.env.WEBSITE_DIR || '../website3');
const PROJECTS_DIR = path.join(TARGET, 'public/assets/projects');
const STATE_FILE = path.join(TARGET, '.sync/state.json');
const SETTINGS = { widths: WIDTHS, webpQuality: 90, jxlQuality: 90, jxlEffort: 4, v: 2 };
const SKIP_DIRS = new Set(['node_modules', 'scripts', 'tests', 'docs']);
const EXPORT_RE = /^(.*)-(\d+)\.(webp|jxl)$/;

const log = (...a) => console.log(...a);
const exists = async p => { try { await access(p); return true; } catch { return false; } };
const sha = buf => createHash('sha256').update(buf).digest('hex');
const execFileP = promisify(execFile);

// Decodes a HEIC/HEIF still to a PNG buffer with libheif's heif-convert
// (decoding only - the original file is never altered or replaced). Picks the
// largest decoded image, which is the primary photo, not the thumbnail.
async function decodeHeic(buf, label) {
  const tmp = await mkdir(path.join(os.tmpdir(), `heic-${Date.now()}-${Math.random().toString(36).slice(2)}`), { recursive: true });
  try {
    const src = path.join(tmp, 'in.heic');
    await writeFile(src, buf);
    await execFileP('heif-convert', [src, path.join(tmp, 'out.png')]);
    const outs = [];
    for (const f of await readdir(tmp)) {
      if (!f.startsWith('out') || !f.endsWith('.png')) continue;
      const b = await readFile(path.join(tmp, f));
      const m = await sharp(b).metadata();
      outs.push({ b, px: (m.width || 0) * (m.height || 0), width: m.width, height: m.height });
    }
    if (!outs.length) throw new Error('heif-convert produced no image');
    outs.sort((a, b2) => b2.px - a.px);
    return outs[0];
  } catch (e) {
    throw new Error(`HEIC preview decode failed for ${label}: ${e.message}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
const stable = o => JSON.stringify(o);

const ConfigSchema = z.object({
  limits: z.object({ concurrency: z.number().int().min(1).max(4).default(2) }).passthrough().default({})
});

let cfg;
try {
  cfg = ConfigSchema.parse(JSON.parse(await readFile(path.join(SRC, 'config.json'), 'utf8')));
} catch (e) {
  const msg = e instanceof z.ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message;
  console.error(`config.json invalid: ${msg}`); process.exit(1);
}

const warnings = [], errors = [], summary = { added: [], updated: [], removed: [], skipped: [] };

// ---------- state ----------
let state = { version: 2, settings: SETTINGS, projects: {} };
if (await exists(STATE_FILE)) {
  try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { warnings.push('state.json unreadable; regenerating everything.'); state = { version: 2, settings: SETTINGS, projects: {} }; }
}
const settingsChanged = state.version !== 2 || stable(state.settings) !== stable(SETTINGS);
state.settings = SETTINGS;

// ---------- scan ----------
// The scan is the only source of truth for what exists. If a project folder
// cannot be read, the run aborts: a failed read must never look like a deletion.
let projectDirs;
try {
  projectDirs = (await readdir(SRC, { withFileTypes: true }))
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name)).map(d => d.name).sort();
} catch (e) {
  console.error(`Cannot read the originals folder: ${e.message}. Aborting without changing the site.`);
  process.exit(1);
}
const scan = [];
for (const slug of projectDirs) {
  let files;
  try { files = (await readdir(path.join(SRC, slug))).sort(); }
  catch (e) { console.error(`Cannot read project folder ${slug}: ${e.message}. Aborting without changing the site.`); process.exit(1); }
  const v = validateNames(slug, files);
  errors.push(...v.errors); warnings.push(...v.warnings);
  const metaText = files.includes('meta.json') ? await readFile(path.join(SRC, slug, 'meta.json'), 'utf8') : null;
  if (metaText == null) warnings.push(`${slug}: no meta.json; using folder and file names.`);
  const pm = parseMeta(metaText, slug); warnings.push(...pm.warnings);
  const images = files.filter(f => IMAGE_EXT_RE.test(f) || HEIC_EXT_RE.test(f));
  scan.push({ slug, files: images, meta: pm.meta });
}
if (errors.length) { for (const e of errors) console.error('ERROR', e); await finish(1); }
const imageCount = scan.reduce((n, p) => n + p.files.length, 0);

// ---------- plan ----------
const plan = []; // {slug, file, stem, buf, hash, action, heic}
for (const p of scan) {
  for (const f of p.files) {
    const buf = await readFile(path.join(SRC, p.slug, f));
    const heic = HEIC_EXT_RE.test(f);
    const stem = f.replace(heic ? HEIC_EXT_RE : IMAGE_EXT_RE, '');
    const hash = sha(buf);
    const prev = state.projects[p.slug]?.[stem];
    const outDir = path.join(PROJECTS_DIR, p.slug, 'web');
    const origDir = path.join(PROJECTS_DIR, p.slug, 'original');
    let complete = !!prev;
    if (complete && !prev.skipped) {
      if (prev.heic) {
        complete = await exists(path.join(origDir, f));
        if (complete) for (const w of prev.sizes || []) if (!(await exists(path.join(outDir, `${stem}-${w}.webp`)))) complete = false;
      }
      else for (const w of prev.sizes || []) if (!(await exists(path.join(outDir, `${stem}-${w}.webp`))) || !(await exists(path.join(outDir, `${stem}-${w}.jxl`)))) complete = false;
    }
    if (prev?.skipped) complete = true;
    const action = !prev ? 'add' : (prev.sha256 !== hash || settingsChanged || !complete) ? 'update' : 'keep';
    plan.push({ slug: p.slug, file: f, stem, buf, hash, action, heic, outDir, origDir });
  }
}
// removals: anything on disk whose source is gone - stray exports, stray copied
// originals, and whole project folders that no longer exist in originals.
const wanted = new Set(plan.map(x => `${x.slug}/${x.stem}`));
const removals = [];
const slugsOnDisk = (await exists(PROJECTS_DIR)) ? (await readdir(PROJECTS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name) : [];
let filesToDelete = 0;
for (const slug of slugsOnDisk) {
  if (!scan.some(p => p.slug === slug)) {
    // Project deleted from originals on purpose: remove its whole output folder.
    const dir = path.join(PROJECTS_DIR, slug);
    filesToDelete += (await readdir(dir, { recursive: true })).length;
    removals.push({ path: dir, recursive: true });
    continue;
  }
  const dir = path.join(PROJECTS_DIR, slug, 'web');
  if (await exists(dir)) for (const f of await readdir(dir)) {
    const m = EXPORT_RE.exec(f);
    if (!m) continue;
    if (!wanted.has(`${slug}/${m[1]}`)) { removals.push({ path: path.join(dir, f) }); filesToDelete++; }
  }
  const odir = path.join(PROJECTS_DIR, slug, 'original');
  if (await exists(odir)) for (const f of await readdir(odir)) {
    const stem = f.replace(HEIC_EXT_RE, '');
    if (!HEIC_EXT_RE.test(f) || !wanted.has(`${slug}/${stem}`)) { removals.push({ path: path.join(odir, f) }); filesToDelete++; }
  }
}
const guard = deletionGuard({ toDelete: filesToDelete, imageCount, force: FORCE });
if (guard) { console.error('GUARD:', guard); await finish(1); }

log(`Plan: ${plan.filter(x => x.action === 'add').length} add, ${plan.filter(x => x.action === 'update').length} update, ${plan.filter(x => x.action === 'keep').length} unchanged, ${filesToDelete} files to remove.`);
if (DRY) {
  for (const x of plan) if (x.action !== 'keep') log(`  ${x.action} ${x.slug}/${x.file}`);
  for (const r of removals) log(`  remove ${path.relative(TARGET, r.path)}`);
  log('Dry run: nothing changed.'); process.exit(0);
}

// ---------- generate ----------
let jxlReady;
const jxlInit = () => jxlReady ??= (async () => {
  await initJxl(await WebAssembly.compile(await readFile(path.resolve('node_modules/@jsquash/jxl/codec/enc/jxl_enc.wasm'))));
})();

// One bad file must never sink a push: per-file failures skip that file with a
// warning and everything else still publishes. Systemic failures (bad config,
// unreadable folders, failing tests in CI) still stop the whole run.
async function generate(x) {
  if (x.heic) {
    // The HEIC/HEIF original is copied unchanged; WebP previews are decoded
    // from it for browsers that cannot display HEIC (Chrome, Firefox).
    await mkdir(x.origDir, { recursive: true });
    await writeFile(path.join(x.origDir, x.file), x.buf);
    const exifBuf = extractHeicExif(x.buf);
    const parsed = exifBuf ? parseExif(exifBuf) : null;
    const dims = heicDimensions(x.buf);
    let width = parsed?.pixelWidth || dims?.width || null;
    let height = parsed?.pixelHeight || dims?.height || null;
    if (width && height && parsed?.orientation >= 5) [width, height] = [height, width];
    let widths = [];
    try {
      const dec = await decodeHeic(x.buf, `${x.slug}/${x.file}`);
      width = width || dec.width; height = height || dec.height;
      widths = WIDTHS.filter(w => w <= dec.width);
      if (!widths.length) widths = [dec.width];
      await mkdir(x.outDir, { recursive: true });
      for (const w of widths) {
        await sharp(dec.b).rotate().resize({ width: w }).webp({ quality: SETTINGS.webpQuality }).toFile(path.join(x.outDir, `${x.stem}-${w}.webp`));
      }
    } catch (e) {
      warnings.push(`${e.message}; the unchanged original still publishes and displays in Safari 17+.`);
    }
    if (!width || !height) warnings.push(`${x.slug}/${x.file}: dimensions unreadable; the layout will use a fallback box.`);
    return { sha256: x.hash, heic: true, original: x.file, width, height, sizes: widths, jxlSizes: [] };
  }
  const meta = await sharp(x.buf).metadata();
  if (!meta.width) throw new Error('no dimensions');
  await mkdir(x.outDir, { recursive: true });
  // Widths capped at the photo's own width; a small photo ships at native size.
  let widths = WIDTHS.filter(w => w <= meta.width);
  if (!widths.length) widths = [meta.width];
  for (const w of widths) {
    await sharp(x.buf).rotate().resize({ width: w }).webp({ quality: SETTINGS.webpQuality }).toFile(path.join(x.outDir, `${x.stem}-${w}.webp`));
    try {
      await jxlInit();
      const { data, info } = await sharp(x.buf).rotate().resize({ width: w }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const jxl = await encodeJxl({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height },
        { quality: SETTINGS.jxlQuality, effort: SETTINGS.jxlEffort });
      await writeFile(path.join(x.outDir, `${x.stem}-${w}.jxl`), Buffer.from(jxl));
    } catch (e) { throw new Error(`${x.slug}/${x.stem}-${w}.jxl failed: ${e.message}`); }
  }
  // remove stale sizes (e.g. original replaced by a smaller one)
  for (const f of await readdir(x.outDir)) {
    const m = EXPORT_RE.exec(f);
    if (m && m[1] === x.stem && !widths.includes(+m[2])) await rm(path.join(x.outDir, f), { force: true });
  }
  const big = widths[widths.length - 1];
  const { width, height } = await sharp(path.join(x.outDir, `${x.stem}-${big}.webp`)).metadata();
  return { sha256: x.hash, width, height, sizes: widths, jxlSizes: widths };
}

const limit = pLimit(cfg.limits.concurrency);
const results = {};
await Promise.all(plan.filter(x => x.action !== 'keep').map(x => limit(async () => {
  try {
    const r = await generate(x);
    (results[x.slug] ??= {})[x.stem] = r;
    summary[x.action === 'add' ? 'added' : 'updated'].push(`${x.slug}/${x.file}`);
    log(`  ${x.action} ${x.slug}/${x.file}`);
  } catch (e) {
    warnings.push(`${x.slug}/${x.file}: unreadable or failed to process (${e.message}); skipped, everything else still publishes.`);
    summary.skipped.push(`${x.slug}/${x.file}: ${e.message}`);
    (results[x.slug] ??= {})[x.stem] = { skipped: true, sha256: x.hash };
  }
})));
for (const r of removals) { await rm(r.path, { force: true, recursive: !!r.recursive }); summary.removed.push(path.relative(TARGET, r.path)); }

// ---------- merge state + manifest + public meta.json ----------
const newState = { version: 2, settings: SETTINGS, projects: {} };
const manifest = [];
for (const p of scan) {
  const ov = metaImageMap(p.meta);
  const images = [], publicImages = [];
  for (const x of plan.filter(x => x.slug === p.slug)) {
    const rec = results[p.slug]?.[x.stem] ?? state.projects[p.slug]?.[x.stem];
    if (!rec || rec.skipped) { (newState.projects[p.slug] ??= {})[x.stem] = { sha256: x.hash, skipped: true }; continue; }
    const o = ov.get(x.stem) || {};
    // Camera, lens and exposure details from the original, as plain text (see scripts/exif.mjs).
    // Published in the manifest and the public meta.json for crawlers and agents;
    // the page keeps it visually hidden. Allow-list only: no GPS, serials, people or dates.
    let exif = '';
    try {
      if (x.heic) { const eb = extractHeicExif(x.buf); exif = eb ? exifText(eb) : ''; }
      else { const em = await sharp(x.buf).metadata(); exif = em.exif ? exifText(em.exif) : ''; }
    } catch { /* unreadable: no EXIF */ }
    // Alt text is human-written in meta.json only ("" marks an image decorative on purpose).
    const alt = o.alt ?? '';
    // Captions are human-written in meta.json only. EXIF is a separate plain-text field, never a caption.
    const caption = o.caption ?? '';
    const img = {
      file: x.stem, title: o.title ?? x.stem, date: o.date ?? p.meta.date ?? '',
      width: rec.width, height: rec.height, sizes: rec.sizes, alt, caption, credit: o.credit ?? '', exif,
      order: o.order ?? 999, jxlSizes: rec.jxlSizes, jxl: rec.jxlSizes.length > 0, jpg: false
    };
    if (rec.heic) { img.heic = true; img.original = rec.original; }
    images.push(img);
    publicImages.push({
      file: x.stem, source: x.file, title: img.title, caption, credit: img.credit, alt, order: img.order,
      exif, width: rec.width, height: rec.height,
      ...(rec.heic ? { heic: true, original: `original/${rec.original}`, webp: rec.sizes.map(w => `web/${x.stem}-${w}.webp`) } : { webp: rec.sizes.map(w => `web/${x.stem}-${w}.webp`), jxl: rec.jxlSizes.map(w => `web/${x.stem}-${w}.jxl`) })
    });
    const recOut = { ...rec };
    delete recOut.ai; // drop any legacy AI-alt cache entries from older state files
    delete recOut.exif; // drop legacy camera-data cache; captions are human-written only now
    (newState.projects[p.slug] ??= {})[x.stem] = recOut;
  }
  images.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file, undefined, { numeric: true }));
  publicImages.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file, undefined, { numeric: true }));
  manifest.push({ order: p.meta.order ?? 999, slug: p.slug, project: p.meta.project ?? p.slug, date: p.meta.date ?? '', images });
  // The project's public meta.json sits next to the images on the site: human
  // fields plus the EXIF allow-list, exactly what the gallery reads plus paths.
  if (images.length) {
    const pub = { project: p.meta.project ?? p.slug, slug: p.slug, date: p.meta.date ?? '', images: publicImages };
    const pubText = JSON.stringify(pub, null, 2) + '\n';
    const pubPath = path.join(PROJECTS_DIR, p.slug, 'meta.json');
    await mkdir(path.dirname(pubPath), { recursive: true });
    if (!(await exists(pubPath)) || (await readFile(pubPath, 'utf8')) !== pubText) await writeFile(pubPath, pubText);
  }
}
manifest.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
const manifestText = JSON.stringify(manifest.map(({ order, ...m }) => m), null, 2) + '\n';
const stateText = JSON.stringify(newState, null, 2) + '\n';
await mkdir(PROJECTS_DIR, { recursive: true });
await mkdir(path.dirname(STATE_FILE), { recursive: true });
const manifestPath = path.join(PROJECTS_DIR, 'manifest.json');
if (!(await exists(manifestPath)) || (await readFile(manifestPath, 'utf8')) !== manifestText) await writeFile(manifestPath, manifestText);
if (!(await exists(STATE_FILE)) || (await readFile(STATE_FILE, 'utf8')) !== stateText) await writeFile(STATE_FILE, stateText);
await finish(0);

async function finish(code) {
  const lines = ['## Sync summary', '',
    `- Added: ${summary.added.length}`, `- Updated: ${summary.updated.length}`, `- Removed export files: ${summary.removed.length}`, `- Skipped: ${summary.skipped.length}`, ''];
  if (summary.skipped.length) lines.push('### Skipped', ...summary.skipped.map(s => `- ${s}`), '');
  if (warnings.length) lines.push('### Warnings', ...warnings.map(s => `- ${s}`), '');
  if (errors.length) lines.push('### Errors', ...errors.map(s => `- ${s}`), '');
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  process.exit(code);
}
