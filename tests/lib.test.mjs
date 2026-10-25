import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNames, parseMeta, deletionGuard } from '../scripts/lib.mjs';

test('names: reserved, collisions, case, hostile', () => {
  const v = validateNames('P', ['a-600.png', 'b.png', 'b.jpg', 'C.png', 'c.PNG', 'x#y.png', 'é.png', 'sp ace.png']);
  const e = v.errors.join('\n');
  for (const k of ['a-600.png', 'collide', 'x#y.png', 'é.png']) assert.match(e, new RegExp(k));
  assert.match(v.warnings.join('\n'), /sp ace/);
});
test('meta: malformed reports line/column', () => {
  const r = parseMeta('{\n "a": 1,\n "b": }', 'P');
  assert.deepEqual(r.meta, {}); assert.match(r.warnings[0], /line 3/);
});
test('guard: only an empty gallery is held, and only without force', () => {
  // Deleting individual projects - even most of them - is a normal sync.
  assert.equal(deletionGuard({ toDelete: 3, imageCount: 5 }), null);
  assert.equal(deletionGuard({ toDelete: 40, imageCount: 2 }), null);
  // Emptying the whole site is held for a manual, forced run.
  assert.ok(deletionGuard({ toDelete: 10, imageCount: 0 }));
  assert.equal(deletionGuard({ toDelete: 10, imageCount: 0, force: true }), null);
  // Nothing to delete + nothing in originals = no-op, not a hold.
  assert.equal(deletionGuard({ toDelete: 0, imageCount: 0 }), null);
});
