import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNames, parseMeta, deletionGuard } from '../scripts/lib.mjs';

test('names: reserved, collisions, case, hostile, HEIC', () => {
  const v = validateNames('P', ['a-600.png', 'b.png', 'b.jpg', 'C.png', 'c.PNG', 'x#y.png', 'é.png', 'p.heic', 'sp ace.png']);
  const e = v.errors.join('\n');
  for (const k of ['a-600.png', 'collide', 'x#y.png', 'é.png', 'HEIC']) assert.match(e, new RegExp(k));
  assert.match(v.warnings.join('\n'), /sp ace/);
});
test('meta: malformed reports line/column', () => {
  const r = parseMeta('{\n "a": 1,\n "b": }', 'P');
  assert.deepEqual(r.meta, {}); assert.match(r.warnings[0], /line 3/);
});
test('deletion guard', () => {
  assert.ok(deletionGuard({ existing: 10, toDelete: 3, imageCount: 5 }));
  assert.equal(deletionGuard({ existing: 10, toDelete: 2, imageCount: 5 }), null);
  assert.ok(deletionGuard({ existing: 10, toDelete: 0, imageCount: 0 }));
  assert.equal(deletionGuard({ existing: 10, toDelete: 10, imageCount: 0, force: true }), null);
});
