import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { runCells } from './helpers.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('cells', () => {
  test('a cell is echoed, its result shown on the rail, and a footer written', () => {
    const [r] = runCells(['1 + 1']);
    assert.equal(r.value, '2');
    assert.match(r.out, /^> 1 \+ 1\n│\n│ 2\n│\n╰─ ✓ .+ · number · Out\[1\]\n/);
  });

  test('declarations persist and can be declared again', () => {
    const r = runCells([
      'const persisted = 1',
      'const persisted = 2; persisted * 10',
      'class Point { constructor(x) { this.x = x } }',
      'class Point { constructor(x) { this.x = x * 2 } }\nnew Point(2).x',
    ]);
    assert.equal(r[1].value, '20');
    assert.equal(r[3].value, '4');
  });

  test('top-level await and import', () => {
    const r = runCells(['const waited = await Promise.resolve(21)\nwaited * 2', 'waited', 'import { basename } from "node:path"\nbasename("/a/b.txt")']);
    assert.equal(r[0].value, '42');
    assert.equal(r[1].value, '21');
    assert.equal(r[2].value, "'b.txt'");
  });

  test('console output lands on the rail, stderr included', () => {
    const [r] = runCells(['console.log("to stdout"); console.error("to stderr")']);
    assert.match(r.out, /│ to stdout\n│ to stderr\n/);
  });

  test('_ , _N and Out keep results', () => {
    const r = runCells(['"kept"', '[_, _1, Out[1]]']);
    assert.equal(r[1].value, "[ 'kept', 'kept', 'kept' ]");
  });

  test('statements show no result', () => {
    const [r] = runCells(['let quiet = 5']);
    assert.equal(r.value, 'undefined');
    assert.match(r.out, /╰─ ✓ [\d.]+(µs|ms)\n/);
  });

  test('errors show the source line and the footer names the error', () => {
    const r = runCells(['const broken = null\nbroken.field', '_error instanceof TypeError']);
    assert.equal(r[0].ok, false);
    assert.match(r[0].out, /✗ TypeError: Cannot read properties of null \(reading 'field'\)/);
    assert.match(r[0].out, /❱ 2 │ broken\.field/);
    assert.match(r[0].out, /╰─ ✗ TypeError/);
    assert.equal(r[1].value, 'true');
  });

  test('syntax errors point at the problem', () => {
    const [r] = runCells(['let x = ;']);
    assert.match(r.out, /✗ SyntaxError: /);
    assert.match(r.out, /❱ 1 │ let x = ;/);
  });

  test('exit and process.exit end the session', () => {
    assert.equal(runCells(['exit'])[0].thrown, 'ExitRequest');
    const [r] = runCells(['process.exit(3)']);
    assert.deepEqual([r.thrown, r.code], ['ExitRequest', 3]);
  });
});

describe('shell syntax', () => {
  test('!cmd streams output and reports a failing exit status', () => {
    const r = runCells(['!echo hello from sh', '!exit 3']);
    assert.match(r[0].out, /│ hello from sh\n/);
    assert.match(r[1].out, /╰─ ✗ exit 3/);
  });

  test('$name puts JS values into commands; negation of your variables stays JS', () => {
    const r = runCells(['const greeting = "hi there"', '!echo $greeting', '!greeting']);
    assert.match(r[1].out, /│ hi there\n/);
    assert.equal(r[2].value, 'false');
  });

  test('obj? inspects without running code', () => {
    const [r] = runCells(['Math.max?']);
    assert.match(r.out, /type\s+function max/);
    assert.match(r.out, /signature\s+ƒ max\(\.\.\.values: number\[\]\) → number/);
  });

  test('wildcard search', () => {
    const [r] = runCells(['Math.*SQRT*?']);
    assert.match(r.out, /Math\.SQRT2/);
    assert.match(r.out, /Math\.SQRT1_2\n/);
  });

  test('built-in modules are globals, loaded on first use', () => {
    const [r] = runCells(['typeof path.join']);
    assert.equal(r.value, "'function'");
  });
});

describe('magics', () => {
  test('unknown magics suggest a close name', () => {
    const [r] = runCells(['%timit 1']);
    assert.match(r.out, /unknown magic %timit — did you mean %timeit\?/);
    assert.match(r.out, /╰─ ✗ failed/);
  });

  test('%timeit returns a result with -o', () => {
    const r = runCells(['%timeit -n 50 -r 3 -o [1, 2, 3].map((x) => x * 2)', '[_.loops, _.all_runs.length]']);
    assert.match(r[0].out, /per loop \(mean ± std\. dev\. of 3 runs, 50 loops each\)/);
    assert.equal(r[1].value, '[ 50, 3 ]');
  });

  test('%%bash runs a cell with bash', () => {
    const [r] = runCells(['%%bash\necho "from $0"']);
    assert.match(r.out, /│ from bash\n/);
  });

  test('%cd changes directory and require follows', () => {
    const dir = fs.realpathSync(tmp('cinder-cd-'));
    fs.writeFileSync(path.join(dir, 'answer.cjs'), 'module.exports = 42');
    const r = runCells([`%cd ${dir}`, 'process.cwd()', 'require("./answer.cjs")', '%cd -', 'process.cwd()'], { cwd: os.tmpdir() });
    assert.equal(r[1].value, `'${dir}'`);
    assert.equal(r[2].value, '42');
    assert.equal(r[4].value, `'${fs.realpathSync(os.tmpdir())}'`);
  });

  test('%run runs a file in the session, with its own require, argv and import.meta', () => {
    const dir = tmp('cinder-run-');
    fs.writeFileSync(path.join(dir, 'helper.cjs'), 'module.exports = (x) => x + 1');
    fs.writeFileSync(path.join(dir, 'script.mjs'), 'import inc from "./helper.cjs"\nconst fromScript = inc(1)\nconst args = process.argv.slice(2)\nconst here = import.meta.url\n');
    const r = runCells([`%run ${path.join(dir, 'script.mjs')} one two`, '[fromScript, args, here.endsWith("script.mjs")]']);
    assert.equal(r[1].value, "[ 2, [ 'one', 'two' ], true ]");
  });

  test('%run keeps process.exit inside the file', () => {
    const file = path.join(tmp('cinder-exit-'), 'bye.js');
    fs.writeFileSync(file, 'process.exit(0)\n');
    const [r] = runCells([`%run ${file}`]);
    assert.match(r.out, /bye\.js called process\.exit\(0\)/);
  });

  test('magic lines work inside JS cells', () => {
    const [r] = runCells(['const where = 1\n%pwd']);
    assert.equal(r.value, `'${process.cwd()}'`);
  });

  test('%who lists your variables only', () => {
    const r = runCells(['const mine = 1', '%who']);
    assert.match(r[1].out, /│ mine\n/);
  });

  test('%del and %reset clear variables, including undeletable var/function bindings', () => {
    const r = runCells(['const a = 1', 'function f() {}', 'let b = 2', '%del a', '%who', '%reset -f', '%who', 'typeof f']);
    assert.match(r[4].out, /│ b {2}f\n/);
    assert.match(r[6].out, /no variables yet/);
    assert.equal(r[7].value, "'undefined'");
  });

  test('%config validates settings', () => {
    const r = runCells(['%config depth=2', '%config xmode=loud']);
    assert.match(r[0].out, /depth = 2/);
    assert.match(r[1].out, /xmode must be one of: minimal, plain, context, verbose/);
  });

  test('%history shows this session with line numbers', () => {
    const r = runCells(['1 + 1', 'const two = 2', '%history -n 1-2']);
    assert.match(r[2].out, /│ 1 1 \+ 1\n│ 2 const two = 2\n/);
  });
});

describe('more magics', () => {
  test('%macro names history lines; typing the name runs them', () => {
    const r = runCells(['const base = 20', 'base + 1', '%macro again 2', 'again']);
    assert.match(r[3].out, /=== running macro again ===\n│ 21\n/);
  });

  test('automagic: magic names without %, unless the line reads as JavaScript', () => {
    const r = runCells(['pwd', 'cd /', 'cd -', 'time = 3', 'time * 2']);
    assert.equal(r[0].value, `'${process.cwd()}'`);
    assert.match(r[1].out, /│ \/\n/);
    assert.equal(r[4].value, '6');
  });

  test('interactivity: all, last_expr_or_assign and none', () => {
    const r = runCells(['%config interactivity=all', '1 + 1\n2 + 2', '%config interactivity=last_expr_or_assign', 'const total = 42', '%config interactivity=none', '7']);
    assert.match(r[1].out, /│ 2\n│ 4\n/);
    assert.match(r[3].out, /│ 42\n/);
    assert.doesNotMatch(r[5].out, /│ 7/);
  });

  test('%precision changes how numbers print, not the values', () => {
    const r = runCells(['%precision 2', '[Math.PI, { e: Math.E }]', 'Math.PI > 3.14159']);
    assert.match(r[1].out, /\[ 3\.14, \{ e: 2\.72 \} \]/);
    assert.equal(r[2].value, 'true');
  });

  test('%%capture keeps output; %tb shows the last error again', () => {
    const r = runCells(['%%capture cap\nconsole.log("quiet"); 5', '[cap.stdout, cap.outputs]', 'null.y', '%tb minimal']);
    assert.doesNotMatch(r[0].out, /│ quiet/);
    assert.equal(r[1].value, "[ 'quiet\\n', [ 5 ] ]");
    assert.match(r[3].out, /│ ✗ TypeError: Cannot read properties of null \(reading 'y'\)\n│\n/);
  });

  test('the directory stack', () => {
    const r = runCells(['%pushd /', '%dirs', '%popd', '%dhist'], { cwd: os.tmpdir() });
    assert.equal(r[1].value.split('\n')[0].includes("'/'"), true);
    assert.match(r[3].out, / {2}1 {2}\/\n/);
  });

  test('%%node runs a separate process; --bg runs in the background', () => {
    const r = runCells(['%%node\nconsole.log(typeof window, await Promise.resolve(1))', '%%sh --bg --out bgout\necho later', 'await new Promise((r) => setTimeout(r, 400)); bgout']);
    assert.match(r[0].out, /│ undefined 1\n/);
    assert.match(r[1].out, /job 1 started in the background/);
    assert.match(r[2].out, /job 1 \(sh\) finished: exit 0/);
    assert.equal(r[2].value, "'later\\n'");
  });

  test('%pdef, %psource and %pfile', () => {
    const r = runCells(['function area(w, h = 1) {\n  return w * h\n}', '%pdef area', '%psource area', '%pfile area']);
    assert.match(r[1].out, /ƒ area\(w, h: number = 1\)/);
    assert.match(r[2].out, /│ function area\(w, h = 1\) \{/);
    assert.match(r[3].out, /│ cell 1:1\n│ 1 │ function area/);
  });

  test('%who_ls and %reset_selective', () => {
    const r = runCells(['const tmpA = 1, tmpB = 2, keep = 3', '%who_ls', '%reset_selective -f ^tmp', '%who_ls']);
    assert.equal(r[1].value, "[ 'keep', 'tmpA', 'tmpB' ]");
    assert.equal(r[3].value, "[ 'keep' ]");
  });

  test('%autoreload updates code you already required', () => {
    const dir = fs.realpathSync(tmp('cinder-reload-'));
    const file = path.join(dir, 'lib.cjs');
    fs.writeFileSync(file, 'exports.greet = () => "v1"\nexports.Box = class Box { size() { return 1 } }\n');
    const edit = `require("fs").writeFileSync(${JSON.stringify(file)}, 'exports.greet = () => "v2"\\nexports.Box = class Box { size() { return 2 } }\\n'); require("fs").utimesSync(${JSON.stringify(file)}, new Date(), new Date(Date.now() + 5000))`;
    const r = runCells(['%autoreload 2', 'const lib = require("./lib.cjs"); const box = new lib.Box()', edit, '[lib.greet(), box.size()]'], { cwd: dir });
    assert.match(r[3].out, /↻ reloaded lib\.cjs/);
    assert.equal(r[3].value, "[ 'v2', 2 ]");
  });

  test('%store keeps values and functions across sessions', () => {
    const home = tmp('cinder-store-');
    const env = { XDG_DATA_HOME: home, XDG_CONFIG_HOME: home };
    runCells(['const saved = new Map([["a", 1]])', 'const twice = (x) => x * 2', '%store saved twice'], { env });
    const r = runCells(['%store -r', '[saved.get("a"), twice(4)]', '%store'], { env });
    assert.match(r[0].out, /restored (saved, twice|twice, saved)/);
    assert.equal(r[1].value, '[ 1, 8 ]');
    assert.match(r[2].out, /saved +Map\(1\)/);
  });

  test('%logstart writes cells (and results with -o) to a file', () => {
    const dir = tmp('cinder-log-');
    runCells(['%logstart -o session.js', '6 * 7', '%logstop', 'const notLogged = 1'], { cwd: dir });
    const log = fs.readFileSync(path.join(dir, 'session.js'), 'utf8');
    assert.match(log, /6 \* 7\n\/\/> 42\n/);
    assert.doesNotMatch(log, /notLogged/);
  });
});
