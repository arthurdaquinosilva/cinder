import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inLiteral, matchBracket, tokenize } from '../src/lexer.js';

const types = (src) => tokenize(src).filter((t) => t.type !== 'space').map((t) => [t.type, t.value]);

test('keywords, builtins, calls, properties and classes', () => {
  assert.deepEqual(types('const x = Math.max(a, new Foo())'), [
    ['keyword', 'const'], ['name', 'x'], ['punct', '='], ['builtin', 'Math'], ['punct', '.'], ['function', 'max'],
    ['punct', '('], ['name', 'a'], ['punct', ','], ['keyword', 'new'], ['class', 'Foo'], ['punct', '('], ['punct', ')'], ['punct', ')'],
  ]);
});

test('regex versus division', () => {
  assert.deepEqual(types('a / b / c').map(([t]) => t), ['name', 'punct', 'name', 'punct', 'name']);
  assert.deepEqual(types('x = /ab+c/gi.test(s)').slice(2, 3), [['regex', '/ab+c/gi']]);
  assert.deepEqual(types('return /x/')[1], ['regex', '/x/']);
});

test('template literals with nested substitutions', () => {
  const toks = types('`a ${ {b: `c ${d}`}.b } e`');
  assert.deepEqual(toks[0], ['template', '`a ${']);
  assert.deepEqual(toks.at(-1), ['template', '} e`']);
  assert.ok(toks.some(([t, v]) => t === 'template' && v === '`c ${'));
});

test('unterminated literals run to the end without throwing', () => {
  assert.deepEqual(types('"abc'), [['string', '"abc']]);
  assert.deepEqual(types('`abc'), [['template', '`abc']]);
  assert.deepEqual(types('/* abc'), [['comment', '/* abc']]);
});

test('magic lines are highlighted as commands', () => {
  assert.deepEqual(types('%timeit f(1)')[0], ['magic', '%timeit']);
});

test('inLiteral knows when the cursor is inside a string or comment', () => {
  assert.equal(inLiteral('require("./li', 13)?.type, 'string');
  assert.equal(inLiteral('a("x") + b', 10), null);
  assert.equal(inLiteral('x // note', 9)?.type, 'comment');
  assert.equal(inLiteral('"done"', 6), null);
});

test('matchBracket pairs brackets and ignores ones in strings', () => {
  assert.deepEqual(matchBracket('f(a, "(", [1])', 1), [1, 13]);
  assert.deepEqual(matchBracket('f(a, [1])', 9), [1, 8]);
  assert.equal(matchBracket('f(a', 1), null);
});
