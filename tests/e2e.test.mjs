// End-to-end: fixtures -> sync -> assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const run = (src, target, ...extra) => execFileSync('node', [path.join(ROOT, 'scripts/sync.mjs'), '--source', src, '--target', target, ...extra], { cwd: ROOT, encoding: 'utf8' });
const tree = async d => { const o = {}; for (const f of (await readdir(d, { recursive: true }))) o[f] = 1; return Object.keys(o).sort().join('\n'); };

test('pipeline end to end', async () => {
  const src = await mkdtemp(path.join(os.tmpdir(), 'src-')), tgt = await mkdtemp(path.join(os.tmpdir(), 'tgt-'));
  await cp(path.join(ROOT, 'config.json'), path.join(src, 'config.json'));
  await mkdir(path.join(src, 'P'));
  const base = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 40 } } });
  await base(1300, 900).jpeg().toFile(path.join(src, 'P', 'cam.jpg'));
  await base(1000, 700).png().toFile(path.join(src, 'P', 'small.png'));
  await base(1300, 900).withIccProfile('p3').png().toFile(path.join(src, 'P', 'p3.png'));
  await base(900, 1300).jpeg().withMetadata({ orientation: 6 }).toFile(path.join(src, 'P', 'rot.jpg'));
  await base(300, 300).png().toFile(path.join(src, 'P', 'tiny.png'));
  await writeFile(path.join(src, 'P', 'meta.json'), JSON.stringify({ project: 'P', images: [{ file: 'p3', alt: '' }] }));

  run(src, tgt);
  const web = path.join(tgt, 'public/assets/projects/P/web');
  const files = await readdir(web);
  assert.ok(files.includes('small-600.webp') && !files.includes('small-1200.webp'), '1000px original makes only 600');
  assert.ok(!files.some(f => f.startsWith('tiny')), 'under 600px skipped');
  assert.ok(files.includes('cam-1200.jxl'));
  const m = JSON.parse(await readFile(path.join(tgt, 'public/assets/projects/manifest.json'), 'utf8'));
  const rotI = m[0].images.find(i => i.file === 'rot');
  assert.ok(rotI.width > rotI.height, 'EXIF orientation 6 applied (portrait stored, landscape displayed)');
  const cam = m[0].images.find(i => i.file === 'cam');
  assert.equal(cam.caption, '', 'no camera-data captions: captions are human-written only');
  assert.ok(!('exif' in cam), 'manifest carries no camera data');
  assert.equal(m[0].images.find(i => i.file === 'p3').alt, '');
  // outputs carry no camera metadata
  for (const f of files.filter(f => /\.webp$/.test(f))) {
    const om = await sharp(path.join(web, f)).metadata();
    assert.ok(!om.exif, `metadata in ${f}`);
  }
  // idempotent
  const before = await tree(tgt), sm = await readFile(path.join(tgt, '.sync/state.json'), 'utf8');
  run(src, tgt);
  assert.equal(await tree(tgt), before); assert.equal(await readFile(path.join(tgt, '.sync/state.json'), 'utf8'), sm);
  // meta-only edit: manifest updates, images untouched
  const mtime = (await import('node:fs')).statSync(path.join(web, 'cam-600.webp')).mtimeMs;
  await writeFile(path.join(src, 'P', 'meta.json'), JSON.stringify({ project: 'P2', images: [{ file: 'cam', caption: 'Hand caption' }] }));
  run(src, tgt);
  assert.equal((await import('node:fs')).statSync(path.join(web, 'cam-600.webp')).mtimeMs, mtime);
  const m2 = JSON.parse(await readFile(path.join(tgt, 'public/assets/projects/manifest.json'), 'utf8'));
  assert.equal(m2[0].project, 'P2'); assert.equal(m2[0].images.find(i => i.file === 'cam').caption, 'Hand caption');
  // deleting a source removes exports (guard allows <=25%; use force for the test fixture size)
  await rm(path.join(src, 'P', 'small.png'));
  run(src, tgt, '--force');
  assert.ok(!(await readdir(web)).some(f => f.startsWith('small-')));
  // guard: zero images aborts
  await rm(path.join(src, 'P'), { recursive: true });
  await mkdir(path.join(src, 'P'));
  assert.throws(() => run(src, tgt), /Command failed|GUARD/);
});
