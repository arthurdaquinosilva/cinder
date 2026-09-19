import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { KeyDecoder } from '../src/keys.js';
import { stripAnsi } from '../src/text.js';
import { Repl } from '../src/ui.js';
import { textObject, wordBack, wordEnd, wordForward } from '../src/vi.js';
import { FakeStdout, makeShell } from './helpers.js';

const stdin = { isTTY: false, setEncoding() {}, on() {}, off() {}, resume() {}, pause() {} };
const { shell } = makeShell({ editingMode: 'vi' });
shell.history.storeInput(1, 'older entry');
after(() => shell.close());

let repl;
let submitted;

/** A prompt holding `text` in normal mode with the cursor at `cursor`. */
function normal(text, cursor = 0) {
  submitted = undefined;
  repl = new Repl(shell, { stdin, stdout: new FakeStdout(80) });
  repl.buffer.reset(text);
  repl.buffer.cursor = cursor;
  repl.vi.mode = 'normal';
  repl.reading = { resolve: (v) => (submitted = v) };
}

function keys(...chunks) {
  const d = new KeyDecoder((ev) => repl.onKey(ev), { escapeTimeout: 0 });
  for (const c of chunks) {
    d.feed(c);
    d.drain(true);
  }
  clearTimeout(d.timer);
}

const state = () => [repl.buffer.text, repl.buffer.cursor];

beforeEach(() => normal(''));

describe('word motions', () => {
  const t = 'foo.bar(baz)  qux';
  test('w, b and e, small and big words', () => {
    assert.equal(wordForward(t, 0, false), 3);
    assert.equal(wordForward(t, 0, true), 14);
    assert.equal(wordBack(t, 14, false), 11);
    assert.equal(wordBack(t, 14, true), 0);
    assert.equal(wordEnd(t, 0, false), 2);
    assert.equal(wordEnd(t, 0, true), 11);
  });

  test('text objects', () => {
    assert.deepEqual(textObject('call(a, [b, c])', 9, true, '('), [5, 14]);
    assert.deepEqual(textObject('call(a, [b, c])', 9, true, '['), [9, 13]);
    assert.deepEqual(textObject('x = "hello world"', 8, true, '"'), [5, 16]);
    assert.deepEqual(textObject('x = "hello world"', 8, false, '"'), [4, 17]);
    assert.deepEqual(textObject('one two three', 5, false, 'w'), [4, 8]);
  });
});

describe('normal mode', () => {
  test('Esc leaves insert mode and moves back one character', () => {
    normal('');
    repl.vi.mode = 'insert';
    keys('abc', '\x1b');
    assert.equal(repl.vi.mode, 'normal');
    assert.deepEqual(state(), ['abc', 2]);
    assert.match(stripAnsi(repl.render().lines.at(-1)), /^\[NORMAL\]/);
  });

  test('motions with counts', () => {
    normal('one two three four');
    keys('2w');
    assert.equal(repl.buffer.cursor, 8);
    keys('$');
    assert.equal(repl.buffer.cursor, 17);
    keys('0', 'fe');
    assert.equal(repl.buffer.cursor, 2);
    keys(';');
    assert.equal(repl.buffer.cursor, 11);
  });

  test('operators with motions and text objects', () => {
    normal('const value = compute(a, b)', 6);
    keys('dw');
    assert.deepEqual(state(), ['const = compute(a, b)', 6]);
    keys('f(', 'ci(');
    assert.equal(repl.vi.mode, 'insert');
    keys('x', '\x1b');
    assert.equal(repl.buffer.text, 'const = compute(x)');
    keys('0', 'd$');
    assert.equal(repl.buffer.text, '');
  });

  test('cw changes to the end of the word, keeping the space', () => {
    normal('let name = 1');
    keys('w', 'cw', 'title', '\x1b');
    assert.equal(repl.buffer.text, 'let title = 1');
  });

  test('dd, yy and p work on whole lines', () => {
    normal('a\nb\nc');
    keys('dd');
    assert.deepEqual(state(), ['b\nc', 0]);
    keys('yy', 'p');
    assert.equal(repl.buffer.text, 'b\nb\nc');
    keys('G', 'dd');
    assert.equal(repl.buffer.text, 'b\nb');
  });

  test('x, r, ~, J and o', () => {
    normal('abc\n  def');
    keys('x');
    assert.equal(repl.buffer.text, 'bc\n  def');
    keys('rZ');
    assert.equal(repl.buffer.text, 'Zc\n  def');
    keys('~');
    assert.equal(repl.buffer.text, 'zc\n  def');
    keys('J');
    assert.equal(repl.buffer.text, 'zc def');
    keys('o', 'next', '\x1b');
    assert.equal(repl.buffer.text, 'zc def\nnext');
  });

  test('u undoes and Ctrl+R redoes', () => {
    normal('hello world');
    keys('dw');
    assert.equal(repl.buffer.text, 'world');
    keys('u');
    assert.equal(repl.buffer.text, 'hello world');
    keys('\x12');
    assert.equal(repl.buffer.text, 'world');
  });

  test('. repeats the last change', () => {
    normal('a b c d');
    keys('dw', '.');
    assert.equal(repl.buffer.text, 'c d');
    normal('x\ny');
    keys('A', ';', '\x1b', 'j', '.');
    assert.equal(repl.buffer.text, 'x;\ny;');
  });

  test('visual mode selects, deletes and yanks', () => {
    normal('one two three');
    keys('v', 'e', 'd');
    assert.equal(repl.buffer.text, ' two three');
    normal('l1\nl2\nl3');
    keys('V', 'j', 'd');
    assert.equal(repl.buffer.text, 'l3');
  });

  test('R replaces characters', () => {
    normal('abcd');
    keys('R', 'xy', '\x1b');
    assert.equal(repl.buffer.text, 'xycd');
  });

  test('Enter runs complete code from normal mode', () => {
    normal('1 + 1');
    keys('\r');
    assert.equal(submitted, '1 + 1');
  });

  test('k on the first line walks history', () => {
    normal('');
    keys('k');
    assert.equal(repl.buffer.text, 'older entry');
  });

  test('>> indents and << dedents', () => {
    normal('x');
    keys('>>');
    assert.equal(repl.buffer.text, '  x');
    keys('<<');
    assert.equal(repl.buffer.text, 'x');
  });
});
