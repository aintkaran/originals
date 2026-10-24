import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCaption, formatShutter, validateNames, parseMeta, resolveCaption, deletionGuard, pickExif } from '../scripts/lib.mjs';
const cfg = { captionTemplate: '{focal} / f/{aperture} / {shutter} / ISO {iso}', separator: ' / ', showCamera: true, showLens: true };
const full = { Make: 'Apple', Model: 'Apple iPhone 15 Pro', FocalLengthIn35mmFormat: 35, FNumber: 1.78, ExposureTime: 0.004, ISO: 400 };

test('caption: full and exposure-only', () => {
  assert.equal(formatCaption(full, cfg), '35mm / f/1.8 / 1/250s / ISO 400');
  assert.equal(formatCaption(full, { ...cfg, captionTemplate: '{camera} / {focal} / {shutter}' }), 'Apple iPhone 15 Pro / 35mm / 1/250s');
});
test('caption: missing fields leave no stray separators; nothing readable gives empty', () => {
  assert.equal(formatCaption({ FNumber: 2, ISO: 100 }, cfg), 'f/2 / ISO 100');
  assert.equal(formatCaption({}, cfg), '');
  assert.equal(formatCaption(undefined, cfg), '');
});
test('caption: long exposures and maker de-duplication', () => {
  assert.equal(formatShutter(2), '2s'); assert.equal(formatShutter(1), '1s'); assert.equal(formatShutter(0.5), '1/2s');
  const t = { ...cfg, captionTemplate: '{camera}' };
  assert.equal(formatCaption({ Make: 'Apple', Model: 'Apple iPhone 15 Pro' }, t), 'Apple iPhone 15 Pro');
  assert.equal(formatCaption({ Make: 'CANON', Model: 'Canon EOS R6' }, t), 'Canon EOS R6');
  assert.equal(formatCaption({ Make: 'SONY', Model: 'ILCE-7M4' }, t), 'Sony ILCE-7M4');
});
test('caption: showCamera/showLens toggles', () => {
  assert.equal(formatCaption({ ...full, LensModel: 'X' }, { ...cfg, captionTemplate: '{camera} / {lens}', showCamera: false }), 'X');
});
test('names: reserved, collisions, case, hostile, HEIC', () => {
  const v = validateNames('P', ['a-600.png', 'b.png', 'b.jpg', 'C.png', 'c.PNG', 'x#y.png', 'é.png', 'p.heic', 'sp ace.png']);
  const e = v.errors.join('\n');
  for (const k of ['a-600.png', 'collide', 'x#y.png', 'é.png', 'HEIC']) assert.match(e, new RegExp(k));
  assert.match(v.warnings.join('\n'), /sp ace/);
});
test('meta: malformed reports line/column; precedence', () => {
  const r = parseMeta('{\n "a": 1,\n "b": }', 'P');
  assert.deepEqual(r.meta, {}); assert.match(r.warnings[0], /line 3/);
  assert.equal(resolveCaption({ caption: 'Mine' }, full, cfg), 'Mine');
  assert.equal(resolveCaption({ caption: '' }, full, cfg), '');
  assert.equal(resolveCaption({}, full, cfg), '35mm / f/1.8 / 1/250s / ISO 400');
  assert.equal(resolveCaption({ exif: false }, full, cfg), '');
});
test('deletion guard', () => {
  assert.ok(deletionGuard({ existing: 10, toDelete: 3, imageCount: 5 }));
  assert.equal(deletionGuard({ existing: 10, toDelete: 2, imageCount: 5 }), null);
  assert.ok(deletionGuard({ existing: 10, toDelete: 0, imageCount: 0 }));
  assert.equal(deletionGuard({ existing: 10, toDelete: 10, imageCount: 0, force: true }), null);
});
test('exif whitelist drops everything else', () => {
  const o = pickExif({ Make: 'A', GPSLatitude: 1, SerialNumber: 'S', OwnerName: 'N', ISO: 100 });
  assert.deepEqual(Object.keys(o).sort(), ['ISO', 'Make']);
});
