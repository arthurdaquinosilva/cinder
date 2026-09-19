import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyDecoder, keyName } from '../src/keys.js';

function decode(...chunks) {
  const events = [];
  const d = new KeyDecoder((e) => events.push(e));
  for (const c of chunks) d.feed(c);
  d.drain(true);
  clearTimeout(d.timer);
  return events;
}

const names = (...chunks) => decode(...chunks).map((e) => (e.name === 'paste' ? `paste:${e.text}` : keyName(e)));

test('plain keys, control keys and Enter', () => {
  assert.deepEqual(names('ab\r\t\x7f\x01\x04\n'), ['a', 'b', 'return', 'tab', 'backspace', 'ctrl+a', 'ctrl+d', 'ctrl+j']);
  assert.equal(decode('é')[0].text, 'é');
});

test('Shift+Enter in xterm modifyOtherKeys and CSI-u forms', () => {
  assert.deepEqual(names('\x1b[27;2;13~'), ['shift+return']);
  assert.deepEqual(names('\x1b[13;2u'), ['shift+return']);
  assert.deepEqual(names('\x1b[13;5u'), ['ctrl+return']);
});

test('Alt as an ESC prefix', () => {
  assert.deepEqual(names('\x1b\r', '\x1bb', '\x1b\x7f'), ['alt+return', 'alt+b', 'alt+backspace']);
});

test('arrows, modifiers, home/end, delete and Shift+Tab', () => {
  assert.deepEqual(names('\x1b[A\x1b[1;5C\x1b[1;3D\x1bOH\x1b[4~\x1b[3~\x1b[Z'), ['up', 'ctrl+right', 'alt+left', 'home', 'end', 'delete', 'shift+tab']);
});

test('a lone Esc is a key once no more input follows', () => {
  assert.deepEqual(names('\x1b'), ['escape']);
});

test('bracketed paste arrives whole, even across chunks', () => {
  assert.deepEqual(names('x\x1b[200~line 1\nli', 'ne 2\x1b[20', '1~y'), ['x', 'paste:line 1\nline 2', 'y']);
});

test('sequences split across reads are reassembled', () => {
  assert.deepEqual(names('\x1b[', '1;5', 'A'), ['ctrl+up']);
});
