import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { commonPrefix, complete } from '../src/completer.js';
import { callAt, functionInfo, renderSignature, signatureAt } from '../src/signature.js';
import { Theme } from '../src/theme.js';
import { stripAnsi } from '../src/text.js';

const texts = (res) => res?.items.map((i) => i.text) ?? [];
const at = (src) => complete(src, src.length, { aliases: {}, userVars: () => ({ cinderUserThing: 1 }) });

before(() => {
  globalThis.cinderUserThing = { alpha: 1, beta: () => 2, nested: { deep: true } };
  globalThis.cinderGreet = function greet(name, times = 1) {
    return `hi ${name}`.repeat(times);
  };
  /** Adds two numbers.
   * @param {number} a
   * @param {number} b
   * @returns {number}
   */
  globalThis.cinderAdd = function cinderAdd(a, b) {
    return a + b;
  };
});

after(() => {
  delete globalThis.cinderUserThing;
  delete globalThis.cinderGreet;
  delete globalThis.cinderAdd;
});

describe('completion', () => {
  test('global names, your variables first', () => {
    const res = at('cinderU');
    assert.equal(res.start, 0);
    assert.deepEqual(texts(res), ['cinderUserThing']);
    assert.ok(texts(at('JSO')).includes('JSON'));
  });

  test('properties along a member chain, without calling anything', () => {
    assert.deepEqual(texts(at('cinderUserThing.')).slice(0, 3), ['alpha', 'beta', 'nested']);
    assert.deepEqual(texts(at('cinderUserThing.nested.d')), ['deep']);
    assert.deepEqual(texts(at('cinderUserThing["nested"].d')), ['deep']);
    const beta = at('cinderUserThing.b').items[0];
    assert.equal(beta.kind, 'function');
  });

  test('literal receivers: strings and arrays', () => {
    assert.ok(texts(at('"abc".toUp')).includes('toUpperCase'));
    assert.ok(texts(at('[1, 2].fla')).includes('flatMap'));
  });

  test('magic names and file paths for path magics', () => {
    assert.deepEqual(texts(at('%timei')), ['timeit']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinder-comp-'));
    fs.writeFileSync(path.join(dir, 'script.js'), '');
    fs.mkdirSync(path.join(dir, 'lib'));
    assert.deepEqual(texts(at(`%run ${dir}/`)), [`${dir}/lib/`, `${dir}/script.js`]);
  });

  test('module names inside require() and import', () => {
    assert.ok(texts(at('require("node:fs')).includes('node:fs'));
    assert.ok(texts(at('import x from "acor')).includes('acorn'));
  });

  test('nothing inside ordinary strings, comments or after whitespace', () => {
    assert.equal(at('"hello wor'), null);
    assert.equal(at('// cinderU'), null);
    assert.equal(at('const x = '), null);
  });

  test('commonPrefix', () => {
    assert.equal(commonPrefix([{ text: 'padStart' }, { text: 'padEnd' }]), 'pad');
  });
});

describe('signatures', () => {
  test('callAt finds the call and the argument under the cursor', () => {
    assert.deepEqual(callAt('foo.bar(1, "x", ', 16), { callee: 'foo.bar', index: 2, arg: '', isNew: false });
    assert.deepEqual(callAt('f(a, [1, 2], g(3', 16).callee, 'g');
    assert.equal(callAt('if (x', 5), null);
    assert.equal(callAt('f(a) + 1', 8), null);
  });

  test('parameters, defaults and inferred types', () => {
    const info = functionInfo(globalThis.cinderGreet);
    assert.deepEqual(info.params.map((p) => [p.name, p.type ?? null, p.def ?? null]), [['name', null, null], ['times', 'number', '1']]);
  });

  test('JSDoc from a cell gives declared types and a summary', () => {
    const src = ['/** Adds two numbers.\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nfunction cinderAdd(a, b) { return a + b }'];
    const info = functionInfo(globalThis.cinderAdd, 'cinderAdd', src);
    assert.equal(info.returns, 'number');
    assert.equal(info.returnsInferred, false);
    assert.deepEqual(info.params.map((p) => p.type), ['number', 'number']);
    assert.equal(info.summary, 'Adds two numbers.');
  });

  test('built-ins come from the table; the value being typed gives a type', () => {
    const sig = signatureAt('JSON.stringify(data, null, ', 27);
    assert.equal(sig.index, 2);
    assert.equal(sig.returns, 'string');
    const typed = signatureAt('cinderGreet("Ada"', 17);
    assert.equal(typed.params[0].type, 'string');
    assert.equal(typed.params[0].inferred, true);
  });

  test('rendering shrinks to fit', () => {
    const theme = new Theme('void', 1);
    const info = { name: 'f', params: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((n) => ({ name: n, def: '"a long default"' })), index: 3, returns: 'string' };
    assert.equal(stripAnsi(renderSignature(info, 200, theme)).includes('= "a long default"'), true);
    const narrow = stripAnsi(renderSignature(info, 40, theme));
    assert.ok(narrow.length <= 40, narrow);
    assert.match(narrow, /delta/);
  });
});

test('\\alpha completes to α; single-letter escapes like \\n stay quiet', () => {
  assert.deepEqual(texts(at('const \\alp')), ['α']);
  assert.equal(at('const \\alp').start, 6);
  assert.ok(texts(at('\\pi')).includes('π'));
  assert.equal(at('"\\n'), null);
});

test('string members skip the deprecated HTML helpers and sort by name', () => {
  const names = texts(at('"abc".'));
  assert.ok(!names.includes('bold'));
  assert.deepEqual(names.slice(0, 3), ['length', 'at', 'charAt']);
});
