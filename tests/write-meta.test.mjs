import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const run = src => execFileSync('node', [path.join(ROOT, 'scripts/write-meta.mjs'), '--source', src], { cwd: ROOT, encoding: 'utf8' });

test('write-meta preserves human fields and only regenerates exif', async () => {
  const src = await mkdtemp(path.join(os.tmpdir(), 'wm-'));
  await mkdir(path.join(src, 'P'));
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg().toFile(path.join(src, 'P', 'cam.jpg'));
  // Human-written meta with a stale generated exif field and unknown extra fields.
  await writeFile(path.join(src, 'P', 'meta.json'), JSON.stringify({
    project: 'My Project', date: '2026-01', customField: 'keep me',
    images: [{ file: 'cam', title: 'Hand title', caption: 'Hand caption', alt: '', exif: 'STALE' }]
  }, null, 2));
  const out1 = run(src);
  assert.match(out1, /updated P\/meta.json/);
  const m = JSON.parse(await readFile(path.join(src, 'P', 'meta.json'), 'utf8'));
  assert.equal(m.project, 'My Project');
  assert.equal(m.customField, 'keep me');
  const img = m.images.find(i => i.file === 'cam');
  assert.equal(img.title, 'Hand title');
  assert.equal(img.caption, 'Hand caption');
  assert.equal(img.alt, '');
  assert.equal(img.exif, undefined, 'no EXIF in a synthetic image: the field is removed, never stale');
  // Idempotent.
  const out2 = run(src);
  assert.match(out2, /already up to date/);
  // Missing meta.json is created.
  await mkdir(path.join(src, 'Q'));
  await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png().toFile(path.join(src, 'Q', 'new.png'));
  run(src);
  const q = JSON.parse(await readFile(path.join(src, 'Q', 'meta.json'), 'utf8'));
  assert.ok(q.images.some(i => i.file === 'new'));
  // Malformed meta.json is left untouched (unparseable human data is never overwritten).
  await writeFile(path.join(src, 'Q', 'meta.json'), '{ broken');
  const before = await readFile(path.join(src, 'Q', 'meta.json'), 'utf8');
  const out3 = run(src);
  assert.match(out3, /malformed/);
  assert.equal(await readFile(path.join(src, 'Q', 'meta.json'), 'utf8'), before);
});
