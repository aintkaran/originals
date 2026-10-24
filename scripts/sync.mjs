// Syncs ./<project>/ originals into optimized exports + manifest.json in a website checkout.
// Usage: node scripts/sync.mjs --target ../website3 [--dry-run] [--force]
import { readdir, readFile, writeFile, mkdir, rm, access, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { z } from 'zod';
import { exiftool } from 'exiftool-vendored';
import encodeJxl, { init as initJxl } from '@jsquash/jxl/encode.js';
import {
  WIDTHS, IMAGE_EXT_RE, parseMeta, metaImageMap, validateNames, pickExif,
  resolveCaption, deletionGuard
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
const SETTINGS = { widths: WIDTHS, webpQuality: 82, jxlQuality: 80, jxlEffort: 4, v: 1 };
const SKIP_DIRS = new Set(['node_modules', 'scripts', 'tests', 'docs']);

const log = (...a) => console.log(...a);
const exists = async p => { try { await access(p); return true; } catch { return false; } };
const sha = buf => createHash('sha256').update(buf).digest('hex');
const stable = o => JSON.stringify(o);

const ConfigSchema = z.object({
  captionTemplate: z.string().min(1),
  separator: z.string().default(' / '),
  showCamera: z.boolean().default(true),
  showLens: z.boolean().default(true),
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
let state = { version: 1, settings: SETTINGS, projects: {} };
if (await exists(STATE_FILE)) {
  try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { warnings.push('state.json unreadable; regenerating everything.'); state = { version: 1, settings: SETTINGS, projects: {} }; }
}
const settingsChanged = stable(state.settings) !== stable(SETTINGS);
state.settings = SETTINGS;

// ---------- scan ----------
const projectDirs = (await readdir(SRC, { withFileTypes: true }))
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name)).map(d => d.name).sort();
const scan = [];
for (const slug of projectDirs) {
  const files = (await readdir(path.join(SRC, slug))).sort();
  const v = validateNames(slug, files);
  errors.push(...v.errors); warnings.push(...v.warnings);
  const metaText = files.includes('meta.json') ? await readFile(path.join(SRC, slug, 'meta.json'), 'utf8') : null;
  if (metaText == null) warnings.push(`${slug}: no meta.json; using folder and file names.`);
  const pm = parseMeta(metaText, slug); warnings.push(...pm.warnings);
  const images = files.filter(f => IMAGE_EXT_RE.test(f));
  scan.push({ slug, files: images, meta: pm.meta });
}
if (errors.length) { for (const e of errors) console.error('ERROR', e); await finish(1); }
const imageCount = scan.reduce((n, p) => n + p.files.length, 0);

// ---------- plan ----------
const plan = []; // {slug, file, stem, buf, hash, action}
for (const p of scan) {
  for (const f of p.files) {
    const buf = await readFile(path.join(SRC, p.slug, f));
    const stem = f.replace(IMAGE_EXT_RE, '');
    const hash = sha(buf);
    const prev = state.projects[p.slug]?.[stem];
    const outDir = path.join(PROJECTS_DIR, p.slug, 'web');
    let complete = !!prev && prev.sizes?.length > 0;
    if (complete) for (const w of prev.sizes) if (!(await exists(path.join(outDir, `${stem}-${w}.webp`))) || !(await exists(path.join(outDir, `${stem}-${w}.jxl`)))) complete = false;
    if (prev?.skipped) complete = true;
    const action = !prev ? 'add' : (prev.sha256 !== hash || settingsChanged || !complete) ? 'update' : 'keep';
    plan.push({ ...p, slug: p.slug, file: f, stem, buf, hash, action, outDir });
  }
}
// removals: exports on disk (or state) whose source is gone
const wanted = new Set(plan.map(x => `${x.slug}/${x.stem}`));
const removals = [];
const slugsOnDisk = (await exists(PROJECTS_DIR)) ? (await readdir(PROJECTS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name) : [];
let existingExports = 0;
for (const slug of slugsOnDisk) {
  const dir = path.join(PROJECTS_DIR, slug, 'web');
  if (!(await exists(dir))) continue;
  for (const f of await readdir(dir)) {
    const m = /^(.*)-(600|1200|2400)\.(webp|jxl)$/.exec(f);
    if (!m) continue;
    existingExports++;
    if (!wanted.has(`${slug}/${m[1]}`)) removals.push({ slug, stem: m[1], path: path.join(dir, f) });
  }
}
const guard = deletionGuard({ existing: existingExports, toDelete: removals.length, imageCount, force: FORCE });
if (guard) { console.error('GUARD:', guard); await finish(1); }

log(`Plan: ${plan.filter(x => x.action === 'add').length} add, ${plan.filter(x => x.action === 'update').length} update, ${plan.filter(x => x.action === 'keep').length} unchanged, ${removals.length} export files to remove.`);
if (DRY) {
  for (const x of plan) if (x.action !== 'keep') log(`  ${x.action} ${x.slug}/${x.file}`);
  for (const r of removals) log(`  remove ${path.relative(TARGET, r.path)}`);
  log('Dry run: nothing changed.'); await exiftool.end(); process.exit(0);
}

// ---------- generate ----------
let jxlReady;
const jxlInit = () => jxlReady ??= (async () => {
  await initJxl(await WebAssembly.compile(await readFile(path.resolve('node_modules/@jsquash/jxl/codec/enc/jxl_enc.wasm'))));
})();

async function generate(x) {
  const meta = await sharp(x.buf).metadata();
  if (!meta.width || meta.width < WIDTHS[0]) {
    warnings.push(`${x.slug}/${x.file}: only ${meta.width || '?'}px wide (need ${WIDTHS[0]}); skipped.`);
    summary.skipped.push(`${x.slug}/${x.file}: under ${WIDTHS[0]}px wide`);
    return { skipped: true, sha256: x.hash };
  }
  await mkdir(x.outDir, { recursive: true });
  const widths = WIDTHS.filter(w => w <= meta.width);
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
  for (const w of WIDTHS.filter(w => !widths.includes(w))) for (const ext of ['webp', 'jxl']) await rm(path.join(x.outDir, `${x.stem}-${w}.${ext}`), { force: true });
  const big = widths[widths.length - 1];
  const { width, height } = await sharp(path.join(x.outDir, `${x.stem}-${big}.webp`)).metadata();
  let exif = {};
  try { exif = pickExif(await exiftool.read(path.join(SRC, x.slug, x.file))); } catch { warnings.push(`${x.slug}/${x.file}: metadata unreadable; no auto-caption.`); }
  return { sha256: x.hash, width, height, sizes: widths, jxlSizes: widths, exif };
}

const limit = pLimit(cfg.limits.concurrency);
const results = {};
await Promise.all(plan.filter(x => x.action !== 'keep').map(x => limit(async () => {
  const r = await generate(x);
  (results[x.slug] ??= {})[x.stem] = r;
  summary[x.action === 'add' ? 'added' : 'updated'].push(`${x.slug}/${x.file}`);
  log(`  ${x.action} ${x.slug}/${x.file}`);
})));
for (const r of removals) { await rm(r.path, { force: true }); summary.removed.push(path.relative(TARGET, r.path)); }

// ---------- merge state + manifest ----------
const newState = { version: 1, settings: SETTINGS, projects: {} };
const manifest = [];
for (const p of scan) {
  const ov = metaImageMap(p.meta);
  const images = [];
  for (const x of plan.filter(x => x.slug === p.slug)) {
    const rec = results[p.slug]?.[x.stem] ?? state.projects[p.slug]?.[x.stem];
    if (!rec || rec.skipped) { (newState.projects[p.slug] ??= {})[x.stem] = { sha256: x.hash, skipped: true }; continue; }
    const o = ov.get(x.stem) || {};
    // Alt text is human-written in meta.json only ("" marks an image decorative on purpose).
    const alt = o.alt ?? '';
    const caption = resolveCaption(o, rec.exif, cfg);
    const img = {
      file: x.stem, title: o.title ?? x.stem, date: o.date ?? p.meta.date ?? '',
      width: rec.width, height: rec.height, sizes: rec.sizes, alt, caption, credit: o.credit ?? '',
      order: o.order ?? 999, jxlSizes: rec.jxlSizes, jxl: rec.jxlSizes.length > 0, jpg: false
    };
    if (rec.exif && Object.keys(rec.exif).length) img.exif = rec.exif;
    images.push(img);
    const recOut = { ...rec };
    delete recOut.ai; // drop any legacy AI-alt cache entries from older state files
    (newState.projects[p.slug] ??= {})[x.stem] = recOut;
  }
  images.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file, undefined, { numeric: true }));
  manifest.push({ order: p.meta.order ?? 999, slug: p.slug, project: p.meta.project ?? p.slug, date: p.meta.date ?? '', images });
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
  await exiftool.end();
  process.exit(code);
}
