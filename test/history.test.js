import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HistoryManager } from '../src/history.js';

function file() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cinder-hist-')), 'history.jsonl');
}

test('sessions persist and ranges address them like IPython', () => {
  const f = file();
  const first = new HistoryManager(f);
  first.storeInput(1, 'const a = 1');
  first.storeInput(2, 'a + 1');
  first.storeOutput(2, '2');

  const second = new HistoryManager(f);
  second.storeInput(1, 'const b = 2');
  second.storeInput(2, 'b * 3');
  second.storeInput(3, 'b - 1');

  assert.deepEqual(second.rangeByString('2').map((e) => e.src), ['b * 3']);
  assert.deepEqual(second.rangeByString('1-2').map((e) => e.src), ['const b = 2', 'b * 3']);
  assert.deepEqual(second.rangeByString('1:3').map((e) => e.src), ['const b = 2', 'b * 3']);
  assert.deepEqual(second.rangeByString('2-').map((e) => e.src), ['b * 3', 'b - 1']);
  assert.deepEqual(second.rangeByString('~1/').map((e) => e.src), ['const a = 1', 'a + 1']);
  assert.deepEqual(second.rangeByString('~1/2 3').map((e) => e.src), ['a + 1', 'b - 1']);
  assert.equal(second.rangeByString('~1/2')[0].out, '2');
  assert.equal(second.label(second.rangeByString('~1/2')[0]), '~1/2');
  assert.throws(() => second.rangeByString('x-y'), /bad history range/);
});

test('search, unique and recent inputs', () => {
  const h = new HistoryManager(null);
  ['fetch(url)', 'x = 1', 'fetch(url)', 'fetch(other)'].forEach((s, i) => h.storeInput(i + 1, s));
  assert.equal(h.search('fetch').length, 3);
  assert.deepEqual(h.search('fetch', { unique: true }).map((e) => e.src), ['fetch(url)', 'fetch(other)']);
  assert.deepEqual(h.search('fetch(*)').map((e) => e.n), [1, 3, 4]);
  assert.deepEqual(h.recentInputs(), ['fetch(other)', 'fetch(url)', 'x = 1']);
});

test('a damaged line in the file is skipped', () => {
  const f = file();
  fs.writeFileSync(f, '{"session":1,"start":"x"}\nnot json\n{"s":1,"n":1,"src":"ok"}\n');
  const h = new HistoryManager(f);
  assert.deepEqual(h.recentInputs(), ['ok']);
});
