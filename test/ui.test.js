import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { KeyDecoder } from '../src/keys.js';
import { stripAnsi } from '../src/text.js';
import { Repl } from '../src/ui.js';
import { FakeStdout, makeShell } from './helpers.js';

class FakeStdin {
  constructor() {
    this.isTTY = false;
  }
  setEncoding() {}
  on() {}
  off() {}
  resume() {}
  pause() {}
}

const { shell } = makeShell();
shell.history.storeInput(1, 'greet("Ada", 2)');
shell.history.storeInput(2, 'const total = items.reduce((a, b) => a + b, 0)');
after(() => shell.close());

let repl;
let submitted;

/** Start a prompt without touching the real terminal. */
function prompt(text = '') {
  submitted = undefined;
  repl = new Repl(shell, { stdin: new FakeStdin(), stdout: new FakeStdout(80) });
  repl.buffer.reset(text);
  repl.reading = { resolve: (v) => (submitted = v) };
}

/** Feed raw terminal input through the real key decoder. */
function keys(...chunks) {
  const d = new KeyDecoder((ev) => repl.onKey(ev));
  for (const c of chunks) d.feed(c);
  d.drain(true);
  clearTimeout(d.timer);
}

const screen = () => repl.render().lines.map((l) => stripAnsi(l).trimEnd());

beforeEach(() => prompt());

describe('the input bar', () => {
  test('shows a placeholder, the counter and the key bar', () => {
    const lines = screen();
    assert.match(lines[1], /^ {2}> Type JavaScript… {2}%help for help +\[1\]$/);
    assert.match(lines.at(-3), /RUN: Enter {2}\| {2}NEWLINE: Alt\+Enter/);
    assert.match(lines.at(-1), /node v\d+/);
  });

  test('Enter runs complete code', () => {
    keys('1 + 1\r');
    assert.equal(submitted, '1 + 1');
  });

  test('Enter continues unfinished code with indentation, and } dedents', () => {
    keys('function f() {\r');
    assert.equal(submitted, undefined);
    assert.equal(repl.buffer.text, 'function f() {\n  ');
    keys('return 1\r}');
    assert.equal(repl.buffer.text, 'function f() {\n  return 1\n}');
    assert.match(screen()[2], /^ {2}· {3}return 1/);
    keys('\r');
    assert.equal(submitted, 'function f() {\n  return 1\n}');
  });

  test('Shift+Enter always inserts a newline and the key bar learns about it', () => {
    keys('a', '\x1b[13;2u', 'b');
    assert.equal(repl.buffer.text, 'a\nb');
    assert.match(screen().at(-3), /NEWLINE: Shift\+Enter/);
  });

  test('two blank lines run an unfinished cell anyway', () => {
    keys('foo(\r\r');
    assert.equal(submitted, undefined);
    keys('\r');
    assert.equal(submitted, 'foo(');
  });

  test('pasting a Node REPL transcript keeps only the code', () => {
    keys('\x1b[200~> const a = 1\nundefined\n> a + 1\n2\n\x1b[201~');
    assert.equal(repl.buffer.text, 'const a = 1\na + 1');
  });

  test('Ctrl+C clears the input, then hints how to exit; Ctrl+D exits on empty input', () => {
    keys('abc\x03');
    assert.equal(repl.buffer.text, '');
    keys('\x03');
    assert.match(screen().at(-1), /press ctrl\+d to exit/);
    keys('\x04');
    assert.equal(submitted, null);
  });
});

describe('help while typing', () => {
  test('the signature of the call replaces the key bar', () => {
    keys('Math.max(1, ');
    assert.match(screen().at(-3), /ƒ max\(\.\.\.values: number\[\]\) → number/);
  });

  test('completions show while typing; Tab selects, Esc restores', () => {
    keys('Math.flo');
    assert.ok(repl.menu);
    assert.ok(screen().some((l) => /ƒ floor/.test(l)));
    keys('\t');
    assert.equal(repl.buffer.text, 'Math.floor');
    keys('\x1b');
    assert.equal(repl.buffer.text, 'Math.flo');
  });

  test('grey suggestion from history; → accepts it', () => {
    keys('gre');
    assert.match(screen()[1], /> gre{2}t\("Ada", 2\)/);
    keys('\x1b[C');
    assert.equal(repl.buffer.text, 'greet("Ada", 2)');
  });

  test('↑ walks history entries that start with what you typed', () => {
    keys('con', '\x1b[A');
    assert.equal(repl.buffer.text, 'const total = items.reduce((a, b) => a + b, 0)');
    keys('\x1b[B');
    assert.equal(repl.buffer.text, 'con');
  });

  test('Ctrl+R searches history', () => {
    keys('\x12red');
    assert.equal(repl.buffer.text, 'const total = items.reduce((a, b) => a + b, 0)');
    assert.ok(screen().some((l) => /search ↑ red/.test(l)));
    keys('\x1b');
    assert.equal(repl.buffer.text, '');
  });
});

describe('the box layout', () => {
  test('draws a rounded box with the counter in the title and a status line', () => {
    shell.settings.layout = 'box';
    try {
      prompt('let x = 1');
      const lines = screen();
      assert.match(lines[0], /^╭─ In \[1\] ─+╮$/);
      assert.match(lines[1], /^│ ❯ let x = 1 +│$/);
      assert.match(lines[2], /^╰─+╯$/);
      assert.match(lines.at(-1), /● node v\d+.*⏎ run/);
    } finally {
      shell.settings.layout = 'block';
    }
  });
});
