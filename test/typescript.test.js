import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { isComplete } from '../src/transform.js';
import { findTsSignature } from '../src/signature.js';
import { looksLikeTypeScript } from '../src/typescript.js';
import { runCells } from './helpers.js';

// Node's own TypeScript compiler arrived in 22.13; module hooks for imported .ts files in 22.15.
const compiler = typeof module.stripTypeScriptTypes === 'function' ? false : 'needs Node 22.13+';
const hooks = typeof module.registerHooks === 'function' && !compiler ? false : 'needs Node 22.15+';
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cinder-ts-')));

describe('TypeScript in cells', { skip: compiler }, () => {
  test('types, interfaces, generics and `as` are erased; positions stay exact', () => {
    const r = runCells([
      'interface User { name: string; age?: number }\nconst users: User[] = [{ name: "ada" }]\nusers.length',
      'function first<T>(xs: T[]): T | undefined {\n  return xs[0]\n}\nfirst<string>(["a"])',
      'type Pair<A, B> = [A, B]\nconst p = [1, "x"] as Pair<number, string>\np[1]',
      'const n: number = null as unknown as number\nn!.toFixed(1)',
    ]);
    assert.deepEqual(r.map((x) => x.value), ['1', "'a'", "'x'", 'undefined']);
    assert.match(r[3].out, /❱ 2 │ n!\.toFixed\(1\)/); // the error is on line 2 of what you typed
  });

  test('enums, namespaces and parameter properties are compiled', () => {
    const r = runCells([
      'enum Color { Red, Green = "g" }\n[Color.Red, Color.Green, Color[0]]',
      'namespace Geo {\n  export const R = 6371\n}\nGeo.R',
      'class Point {\n  constructor(public x: number, private y = 0) {}\n  norm(): number { return Math.hypot(this.x, this.y) }\n}\nnew Point(3, 4).norm()',
    ]);
    assert.deepEqual(r.map((x) => x.value), ["[ 0, 'g', 'Red' ]", '6371', '5']);
  });

  test('errors in compiled cells point at the TypeScript line', () => {
    const [r] = runCells(['enum E { A }\nfunction boom(n: number): never {\n  throw new Error(`bad ${n}`)\n}\nboom(E.A)']);
    assert.match(r.out, /at boom · cell 1:3\n.*\n.*❱ 3 │ {3}throw new Error/);
    assert.match(r.out, /at cell 1:5/);
  });

  test('TypeScript syntax errors say so', () => {
    const [r] = runCells(['const bad: = 1']);
    assert.match(r.out, /✗ SyntaxError \(TypeScript\): Unexpected token `=`/);
  });

  test('%config typescript=off keeps cells JavaScript', () => {
    const r = runCells(['%config typescript=off', 'const x: number = 1']);
    assert.match(r[1].out, /✗ SyntaxError: Unexpected token/);
    assert.doesNotMatch(r[1].out, /TypeScript/);
  });

  test('smart Enter knows unfinished TypeScript', () => {
    for (const src of ['interface User {', 'enum E { A,', 'type T = string |', 'function f<T>(x: T): T {']) assert.equal(isComplete(src), false, src);
    for (const src of ['interface User { name: string }', 'enum E { A }', 'const y: = 1']) assert.equal(isComplete(src), true, src);
  });

  test('%run compiles .ts files, enums included', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'setup.ts'), 'enum Level { Low = 1, High = 10 }\nconst limit: number = Level.High * 2\n');
    const r = runCells([`%run ${path.join(dir, 'setup.ts')}`, 'limit']);
    assert.equal(r[1].value, '20');
  });
});

describe('importing .ts files', { skip: hooks }, () => {
  test('import and require compile TypeScript, enums included, with traces on the .ts lines', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'model.ts'), 'export enum Level { Low = 1, High = 10 }\nexport class Box<T> {\n  constructor(private item: T) {}\n  get(): T { return this.item }\n  fail(): never { throw new Error("from ts") }\n}\n');
    fs.writeFileSync(path.join(dir, 'legacy.cts'), 'enum Mode { A = "a" }\nmodule.exports = { mode: Mode.A }\n');
    const r = runCells(['import { Level, Box } from "./model.ts"\n[Level.High, new Box(42).get()]', 'new Box(1).fail()', 'require("./legacy.cts").mode'], { cwd: dir });
    assert.equal(r[0].value, '[ 10, 42 ]');
    assert.match(r[1].out, /at Box\.fail · .*model\.ts:5/);
    assert.equal(r[2].value, "'a'");
  });
});

test('signatures from TypeScript source', () => {
  const src = ['function pick<T, K extends keyof T>(obj: T, keys: K[], strict = false): Pick<T, K> {\n  return obj as any\n}'];
  const sig = findTsSignature('pick', src);
  assert.equal(sig.generics, '<T, K extends keyof T>');
  assert.deepEqual(sig.params.map((p) => [p.name, p.type ?? null, p.def ?? null]), [['obj', 'T', null], ['keys', 'K[]', null], ['strict', null, 'false']]);
  assert.equal(sig.returns, 'Pick<T, K>');
  const ctor = findTsSignature('Account', ['class Account {\n  constructor(public owner: string, private balance?: number) {}\n}']);
  assert.deepEqual(ctor.params.map((p) => [p.name, p.type, p.optional]), [['owner', 'string', false], ['balance', 'number', true]]);
  assert.equal(findTsSignature('plain', ['function plain(a, b) { return a }']), null);
});

test('looksLikeTypeScript', () => {
  for (const src of ['const x: number = 1', 'interface A {}', 'enum E { A }', 'x as string', 'function f(a: string) {}', 'type T = number']) {
    assert.equal(looksLikeTypeScript(src), true, src);
  }
  for (const src of ['const x = 1', 'a ? b : c', 'const type = 1', '({ a: 1 })']) assert.equal(looksLikeTypeScript(src), false, src);
});
