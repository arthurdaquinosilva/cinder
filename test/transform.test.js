import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classify, isComplete, nextIndent, rewrite, stripPrompts } from '../src/transform.js';

describe('rewrite', () => {
  test('sync cells turn let/const into var so they can be declared again', () => {
    const r = rewrite('const a = 1, {b} = {b: 2}');
    assert.equal(r.code, 'var a = 1, {b} = {b: 2}');
    assert.equal(r.async, false);
    assert.deepEqual(r.names, ['a', 'b']);
  });

  test('classes become re-declarable var bindings', () => {
    assert.equal(rewrite('class A {}').code, 'var A = class A {};');
  });

  test('a lone object literal is an expression, not a block', () => {
    const r = rewrite('{a: 1, b: [2]}');
    assert.equal(r.code, '({a: 1, b: [2]})');
    assert.equal(r.shows, true);
    assert.equal(rewrite('{ let x = 1 }').code, '{ let x = 1 }'); // a real block keeps its scoping
  });

  test('top-level await hoists declarations and returns the last expression', () => {
    const r = rewrite('const x = await f()\nx + 1');
    assert.equal(r.async, true);
    assert.equal(r.code, 'var x; (async () => { void (x = await f())\nreturn (x + 1)\n})()');
    assert.equal(r.col1, 'var x; (async () => { '.length);
  });

  test('imports load with import() and keep line numbers', () => {
    const r = rewrite('import fs, {join as j} from "node:path"\nimport * as os from "node:os"\nj("a")');
    assert.equal(r.async, true);
    assert.deepEqual(r.names.sort(), ['fs', 'j', 'os']);
    assert.equal(r.code.split('\n').length, 4);
    assert.match(r.code, /void \(\{default: fs, join: j\} = await import\("node:path"\)\);/);
    assert.match(r.code, /os = await import\("node:os"\);/);
  });

  test('function declarations in async cells are exported to globals', () => {
    const r = rewrite('async function load() {}\nawait load()');
    assert.match(r.code, /globalThis\.load = load;/);
  });

  test('let without a value resets, var without a value keeps', () => {
    assert.match(rewrite('let a\nawait 0').code, /void \(a = undefined\)/);
    assert.match(rewrite('var a\nawait 0').code, /void \(a = a\)/);
  });

  test('export is stripped so module code can be pasted', () => {
    assert.equal(rewrite('export const a = 1').code, 'var a = 1');
    assert.equal(rewrite('export default 42').code, '42');
  });

  test('import.meta is rewritten only for files run with %run', () => {
    assert.match(rewrite('import.meta.url', { meta: {} }).code, /__cinder__\.meta\.url/);
  });

  test('syntax errors come from acorn with a location', () => {
    assert.throws(() => rewrite('let = ;'), (e) => e instanceof SyntaxError && e.loc.line === 1);
  });
});

describe('isComplete', () => {
  test('unfinished code keeps the cell open', () => {
    for (const src of ['foo(', 'if (x) {', 'const a = [1,', '`abc ${', '/* comment', 'x = ', 'a &&']) {
      assert.equal(isComplete(src), false, src);
    }
  });

  test('finished code and real errors run', () => {
    for (const src of ['x = 1', 'foo()', '}', '"unterminated', 'let let = 1', '', 'if (x) {}\n']) {
      assert.equal(isComplete(src), true, src);
    }
  });

  test('magics, shell and inspection are one-liners', () => {
    for (const src of ['%timeit f()', '!ls -la', 'Math.max?', 'obj??']) assert.equal(isComplete(src), true, src);
  });

  test('cell magics end with a blank line', () => {
    assert.equal(isComplete('%%bash\necho hi'), false);
    assert.equal(isComplete('%%bash\necho hi\n'), true);
  });

  test('a trailing backslash continues the line', () => {
    assert.equal(isComplete('!echo a \\'), false);
  });
});

describe('classify', () => {
  const defined = (n) => n === 'value';
  test('recognises each kind of cell', () => {
    assert.deepEqual(classify('%cd ..'), { kind: 'magic', name: 'cd', args: '..' });
    assert.deepEqual(classify('%%bash -o out\nls'), { kind: 'cellmagic', name: 'bash', args: '-o out', body: 'ls' });
    assert.deepEqual(classify('Math.max?'), { kind: 'inspect', expr: 'Math.max', level: 1 });
    assert.deepEqual(classify('?Math'), { kind: 'inspect', expr: 'Math', level: 1 });
    assert.deepEqual(classify('fn??'), { kind: 'inspect', expr: 'fn', level: 2 });
    assert.deepEqual(classify('Math.*round*?'), { kind: 'psearch', pattern: 'Math.*round*' });
    assert.equal(classify('a ? b : c').kind, 'js');
    assert.equal(classify('x ?? y').kind, 'js');
  });

  test('`!` is a shell command unless it negates one of your variables', () => {
    assert.deepEqual(classify('!ls -la', defined), { kind: 'shell', cmd: 'ls -la' });
    assert.equal(classify('!git', defined).kind, 'shell');
    assert.equal(classify('!value', defined).kind, 'js');
    assert.equal(classify('!!value', defined).kind, 'js');
    assert.equal(classify('!= 3', defined).kind, 'js');
  });
});

describe('pasted prompts', () => {
  test('strips Node REPL prompts and drops output lines', () => {
    const pasted = '> const a = [3, 1]\nundefined\n> a.sort()\n[ 1, 3 ]\n> function f() {\n... return 1\n... }';
    assert.equal(stripPrompts(pasted), 'const a = [3, 1]\na.sort()\nfunction f() {\nreturn 1\n}');
  });

  test('leaves ordinary code alone', () => {
    assert.equal(stripPrompts('a > b\nc'), 'a > b\nc');
  });
});

test('nextIndent adds a level after an opening bracket or arrow', () => {
  assert.equal(nextIndent('function f() {'), '  ');
  assert.equal(nextIndent('    call(a,'), '    ');
  assert.equal(nextIndent('  const x = ['), '    ');
  assert.equal(nextIndent('  x => // note'), '    ');
  assert.equal(nextIndent('  done()'), '  ');
});
