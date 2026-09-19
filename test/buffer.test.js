import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditBuffer } from '../src/buffer.js';

test('typing and undo group consecutive characters', () => {
  const b = new EditBuffer();
  for (const ch of 'hello') b.insert(ch);
  b.insert(' ');
  for (const ch of 'you') b.insert(ch);
  assert.equal(b.text, 'hello you');
  b.undo();
  assert.equal(b.text, 'hello ');
  b.undo();
  b.undo();
  assert.equal(b.text, '');
});

test('word movement and killing', () => {
  const b = new EditBuffer('const answer = compute(a, b)');
  b.wordLeft();
  assert.equal(b.cursor, 26);
  b.killWordBack();
  assert.equal(b.text, 'const answer = compute(b)');
  b.cursor = 0;
  b.wordRight();
  assert.equal(b.cursor, 5);
  b.killToEnd();
  assert.equal(b.text, 'const');
  b.yank();
  assert.equal(b.text, 'const answer = compute(b)');
});

test('lines: up/down keep the column, home toggles indentation', () => {
  const b = new EditBuffer('function f() {\n  return 1\n}');
  b.cursor = b.indexOf(1, 8);
  assert.deepEqual(b.rowCol(), [1, 8]);
  b.up();
  assert.deepEqual(b.rowCol(), [0, 8]);
  b.down();
  b.down();
  assert.deepEqual(b.rowCol(), [2, 1]);
  b.cursor = b.indexOf(1, 6);
  b.home();
  assert.deepEqual(b.rowCol(), [1, 2]);
  b.home();
  assert.deepEqual(b.rowCol(), [1, 0]);
});

test('dedent removes spaces from the current line only', () => {
  const b = new EditBuffer('if (x) {\n    y');
  b.dedent(2);
  assert.equal(b.text, 'if (x) {\n  y');
  assert.equal(b.dedent(4), true);
  assert.equal(b.dedent(2), false);
});

test('surrogate pairs move and delete as one character', () => {
  const b = new EditBuffer('a😀');
  b.left();
  assert.equal(b.cursor, 1);
  b.right();
  b.deleteBack();
  assert.equal(b.text, 'a');
});
