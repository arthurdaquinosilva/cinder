// Running & timing magics.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import inspector from 'node:inspector';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import util from 'node:util';
import vm from 'node:vm';
import readline from 'node:readline';
import { renderError, renderValue } from '../display.js';
import { formatDuration, shortPath, truncate } from '../text.js';
import { hasTopLevelAwait, parse, stripPrompts } from '../transform.js';
import { MagicError, cellMagic, lineMagic, parseArgs } from './registry.js';

const category = 'execution';
const ROOT = pathToFileURL(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))).href;

function isAsyncCode(code) {
  try {
    return hasTopLevelAwait(parse(code));
  } catch {
    return /\bawait\b/.test(code);
  }
}

async function timed(shell, code, label) {
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  let result;
  let error;
  try {
    result = (await shell.runJS(code, label)).value;
  } catch (e) {
    error = e;
  }
  const wall = Number(process.hrtime.bigint() - t0) / 1e9;
  const cpu = process.cpuUsage(cpu0);
  const p = (s, t) => shell.theme.paint(s, t);
  shell.print(p('muted', 'wall ') + p('fg', formatDuration(wall)) + p('faint', '  ·  ') + p('muted', 'cpu ')
    + p('fg', formatDuration((cpu.user + cpu.system) / 1e6)) + p('faint', ` (user ${formatDuration(cpu.user / 1e6)}, system ${formatDuration(cpu.system / 1e6)})`));
  if (error) throw error;
  return result;
}

lineMagic(['time'], { doc: 'Time one statement or expression: wall and CPU time. The value is returned.', usage: 'code', category }, (shell, args) => {
  if (!args.trim()) throw new MagicError('usage: %time code');
  return timed(shell, args, '[%time]');
});

cellMagic(['time'], { doc: 'Time the whole cell.', category }, (shell, _args, body) => timed(shell, body, '[%%time]'));

// ── %timeit ──────────────────────────────────────────────────────────────────

export class TimeitResult {
  constructor(loops, repeat, runs) {
    this.loops = loops;
    this.repeat = repeat;
    this.all_runs = runs; // seconds per run of `loops` loops
    const per = runs.map((t) => t / loops);
    this.average = per.reduce((a, b) => a + b, 0) / per.length;
    this.stdev = Math.sqrt(per.reduce((a, b) => a + (b - this.average) ** 2, 0) / per.length);
    this.best = Math.min(...per);
    this.worst = Math.max(...per);
  }

  toString() {
    const runs = `${this.repeat} run${this.repeat === 1 ? '' : 's'}`;
    const loops = `${this.loops.toLocaleString('en-US')} loop${this.loops === 1 ? '' : 's'} each`;
    return `${formatDuration(this.average)} ± ${formatDuration(this.stdev)} per loop (mean ± std. dev. of ${runs}, ${loops})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `<TimeitResult: ${this.toString()}>`;
  }
}

async function timeit(shell, code, { number, repeat = 7, setup = '', quiet = false }) {
  if (!code.trim()) throw new MagicError('nothing to time');
  if (setup.trim()) await shell.runJS(setup, '[%timeit setup]');
  const isAsync = isAsyncCode(code);
  const fn = vm.runInThisContext(`(${isAsync ? 'async ' : ''}function timeit() {\n${code}\n})`, { filename: '[%timeit]' });
  globalThis.__cinder_timeit__ = fn;
  let loop;
  if (isAsync) {
    loop = async (n) => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) await fn();
      return Number(process.hrtime.bigint() - t0) / 1e9;
    };
  } else {
    // The loop runs as a vm script so Ctrl+C can interrupt it.
    const script = new vm.Script('(() => { const f = __cinder_timeit__, n = __cinder_timeit_n__, t0 = process.hrtime.bigint(); for (let i = 0; i < n; i++) f(); return Number(process.hrtime.bigint() - t0) / 1e9; })()');
    loop = async (n) => {
      globalThis.__cinder_timeit_n__ = n;
      return script.runInThisContext({ breakOnSigint: true });
    };
  }
  try {
    let n = number;
    if (!n) {
      // autorange: 1, 2, 5, 10, 20, 50… until one run takes at least 0.2s
      for (let k = 1; ; k *= 10) {
        let done = false;
        for (const m of [1, 2, 5]) {
          n = k * m;
          const t = await shell.waitInterruptible(loop(n));
          if (t >= 0.2 || n >= 1e9) {
            done = true;
            break;
          }
        }
        if (done) break;
      }
    }
    const runs = [];
    for (let r = 0; r < repeat; r++) runs.push(await shell.waitInterruptible(loop(n)));
    const result = new TimeitResult(n, repeat, runs);
    if (!quiet) {
      const p = (s, t) => shell.theme.paint(s, t);
      shell.print(p('fg.bold', formatDuration(result.average)) + p('muted', ` ± ${formatDuration(result.stdev)} per loop`)
        + p('faint', ` (mean ± std. dev. of ${repeat} run${repeat === 1 ? '' : 's'}, ${n.toLocaleString('en-US')} loop${n === 1 ? '' : 's'} each)`));
      if (result.worst > result.best * 4 && result.worst > 1e-6) {
        shell.print(p('warn', `⚠ the slowest run took ${(result.worst / result.best).toFixed(1)}× longer than the fastest — results may be affected by caching or JIT warm-up`));
      }
    }
    return result;
  } finally {
    delete globalThis.__cinder_timeit__;
    delete globalThis.__cinder_timeit_n__;
  }
}

lineMagic(['timeit'], {
  doc: 'Time a statement, choosing the number of loops automatically. -n loops, -r runs (default 7), -q quiet, -o return a TimeitResult (.average, .stdev, .best, .all_runs). Async code is awaited on each loop.',
  usage: '[-n N] [-r R] [-q] [-o] code',
  category,
}, async (shell, args) => {
  const m = /^((?:\s*-[nr]\s*\d+|\s*-[qo]+)*)\s*([\s\S]*)$/.exec(args);
  const { opts } = parseArgs(m[1], { n: 'value', r: 'value', q: 'bool', o: 'bool' });
  const result = await timeit(shell, m[2], { number: opts.n ? +opts.n : undefined, repeat: opts.r ? +opts.r : 7, quiet: opts.q });
  return opts.o ? result : undefined;
});

cellMagic(['timeit'], {
  doc: 'Time the whole cell; code on the %%timeit line runs once first, as setup. Same options as %timeit.',
  usage: '[-n N] [-r R] [-q] [-o] [setup]',
  category,
}, async (shell, args, body) => {
  const m = /^((?:\s*-[nr]\s*\d+|\s*-[qo]+)*)\s*([\s\S]*)$/.exec(args);
  const { opts } = parseArgs(m[1], { n: 'value', r: 'value', q: 'bool', o: 'bool' });
  const result = await timeit(shell, body, { number: opts.n ? +opts.n : undefined, repeat: opts.r ? +opts.r : 7, quiet: opts.q, setup: m[2] });
  return opts.o ? result : undefined;
});

// ── %run ─────────────────────────────────────────────────────────────────────

/** Read a file's source (TypeScript files are compiled later, by runJS). */
export function readSource(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new MagicError(`can't read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
  }
  return source.replace(/^#!.*/, '');
}

export function resolveFile(name) {
  const file = path.resolve(name.replace(/^~(?=$|\/)/, os.homedir()));
  if (fs.existsSync(file)) return file;
  for (const ext of ['.js', '.mjs', '.cjs', '.ts']) if (fs.existsSync(file + ext)) return file + ext;
  throw new MagicError(`no such file: ${name}`);
}

/** Run a file's code in the session: its top-level declarations become your variables. */
export async function runFile(shell, file, argv = [], { time = false } = {}) {
  const { ExitRequest } = await import('../shell.js');
  const source = readSource(file);
  const g = globalThis;
  const saved = { require: g.require, __filename: g.__filename, __dirname: g.__dirname, argv: process.argv };
  const req = createRequire(file);
  Object.defineProperty(g, 'require', { value: req, writable: true, configurable: true });
  g.__filename = file;
  g.__dirname = path.dirname(file);
  process.argv = [process.argv[0], file, ...argv];
  const t0 = process.hrtime.bigint();
  const meta = { url: pathToFileURL(file).href, filename: file, dirname: path.dirname(file), resolve: (s) => pathToFileURL(req.resolve(s)).href };
  try {
    await shell.runJS(source, file, { filename: file, meta, typescript: /\.(c|m)?ts$/.test(file) });
  } catch (e) {
    if (!(e instanceof ExitRequest)) throw e;
    const p = (s, t) => shell.theme.paint(s, t);
    shell.print(p(e.code ? 'warn' : 'muted', `${path.basename(file)} called process.exit(${e.code})`));
    if (e.code) shell.suppressFooter = false;
  } finally {
    Object.defineProperty(g, 'require', { value: saved.require, writable: true, configurable: true });
    if (saved.__filename === undefined) delete g.__filename;
    else g.__filename = saved.__filename;
    if (saved.__dirname === undefined) delete g.__dirname;
    else g.__dirname = saved.__dirname;
    process.argv = saved.argv;
    if (time) shell.print(shell.theme.paint('muted', `ran ${path.basename(file)} in ${formatDuration(Number(process.hrtime.bigint() - t0) / 1e9)}`));
  }
}

lineMagic(['run'], {
  doc: 'Run a .js/.mjs/.cjs or .ts/.mts/.cts file in this session (TypeScript is compiled, enums and all): its top-level variables and functions become yours. `require`, `import`, `import.meta`, __dirname and process.argv point at the file; process.exit() only ends the file. -t prints how long it took.',
  usage: '[-t] file [args…]',
  category,
}, async (shell, args) => {
  const { opts, rest } = parseArgs(args, { t: 'bool' });
  if (!rest.length) throw new MagicError('usage: %run file.js [args…]');
  await runFile(shell, resolveFile(rest[0]), rest.slice(1), { time: opts.t });
});

lineMagic(['load'], {
  doc: 'Put a file (or lines of it: -r 5-10) into the input, to edit before running.',
  usage: '[-r lines] file',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { r: 'value' });
  if (!rest.length) throw new MagicError('usage: %load file');
  let text = readSource(resolveFile(rest[0]));
  if (opts.r) {
    const lines = text.split('\n');
    const keep = [];
    for (const part of opts.r.split(',')) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!m) throw new MagicError(`bad line range ${part} — try 5-10 or 1,3,7-9`);
      keep.push(...lines.slice(+m[1] - 1, m[2] ? +m[2] : +m[1]));
    }
    text = keep.join('\n');
  }
  shell.nextInput = text.trimEnd();
  shell.print(shell.theme.paint('muted', `loaded ${text.split('\n').length} lines into the input`));
});

function editor() {
  return process.env.VISUAL || process.env.EDITOR || 'vi';
}

export function openEditor(shell, file) {
  shell.spinner.pause(true);
  const result = spawnSync(`${editor()} ${JSON.stringify(file)}`, { stdio: 'inherit', shell: true });
  shell.spinner.pause(false);
  if (result.error || result.status) throw new MagicError(`editor ${editor()} failed${result.status ? ` (exit ${result.status})` : ''}`);
}

lineMagic(['edit', 'ed'], {
  doc: 'Open a file (or, with no file, the previous cell) in $EDITOR, then run it when you close the editor. -x edits without running.',
  usage: '[-x] [file]',
  category,
}, async (shell, args) => {
  const { opts, rest } = parseArgs(args, { x: 'bool' });
  let file;
  if (rest.length) {
    file = path.resolve(rest[0]);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  } else {
    file = path.join(os.tmpdir(), `cinder-edit-${process.pid}-${shell.count}.js`);
    fs.writeFileSync(file, shell.In[shell.count - 1] ?? '');
  }
  openEditor(shell, file);
  if (opts.x) return undefined;
  const source = readSource(file);
  if (!source.trim()) return undefined;
  const { value, shows } = await shell.runJS(source, file, { filename: file });
  return shows ? value : undefined;
});

lineMagic(['debugger', 'inspector'], {
  doc: 'Open the V8 inspector so Chrome DevTools (chrome://inspect) or VS Code can attach; `debugger;` statements then pause there. -w waits until a debugger attaches; `%debugger off` closes it.',
  usage: '[-w] [port | off]',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { w: 'bool' });
  const p = (s, t) => shell.theme.paint(s, t);
  if (rest[0] === 'off') {
    inspector.close();
    shell.print(p('muted', 'inspector closed'));
    return;
  }
  if (!inspector.url()) {
    try {
      inspector.open(rest[0] ? +rest[0] : 9229, '127.0.0.1', false);
    } catch (e) {
      throw new MagicError(`can't open the inspector: ${e.message}`);
    }
  }
  shell.print(p('muted', 'inspector ') + p('fg', inspector.url()));
  shell.print(p('faint', 'attach from chrome://inspect (Chrome) or "Attach to Node Process" (VS Code); `debugger;` in your code pauses there'));
  if (opts.w) {
    shell.print(p('muted', 'waiting for a debugger to attach… (ctrl+c to stop waiting)'));
    shell.spinner.pause(true);
    inspector.waitForDebugger();
    shell.spinner.pause(false);
  }
});

// ── %profile ─────────────────────────────────────────────────────────────────

async function profile(shell, code, limit = 15) {
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  let result;
  let error;
  let prof;
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 100 });
    await session.post('Profiler.start');
    try {
      result = (await shell.runJS(code, '[%profile]')).value;
    } catch (e) {
      error = e;
    }
    ({ profile: prof } = await session.post('Profiler.stop'));
  } finally {
    session.disconnect();
  }
  const total = (prof.endTime - prof.startTime) / 1000; // ms
  const perSample = prof.samples.length ? total / prof.samples.length : 0;
  const self = new Map();
  for (const node of prof.nodes) {
    const f = node.callFrame;
    if (['(idle)', '(program)', '(root)'].includes(f.functionName)) continue;
    if (f.url.startsWith(ROOT)) continue; // cinder's own work (parsing the cell)
    const url = decodeURIComponent(f.url);
    const where = url ? `${shortPath(url.replace(/^file:\/\//, ''))}:${f.lineNumber + 1}` : '';
    const key = `${f.functionName || '(anonymous)'}\u0000${where}`;
    self.set(key, (self.get(key) ?? 0) + (node.hitCount ?? 0) * perSample);
  }
  const rows = [...self.entries()].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const p = (s, t) => shell.theme.paint(s, t);
  const lines = [p('accent.bold', 'self ms'.padStart(9) + '      %  function')];
  for (const [key, ms] of rows) {
    const [fn, where] = key.split('\u0000');
    const label = /\[(%profile|cell \d+)\]/.test(where) ? 'your code' : where;
    lines.push(p('fg', ms.toFixed(1).padStart(9)) + p('muted', `${((ms / total) * 100).toFixed(1).padStart(7)}`) + '  ' + p('info', fn) + (label ? p('faint', '  ' + truncate(label, Math.max(10, shell.width - fn.length - 24))) : ''));
  }
  if (!rows.length) lines.push(p('faint', '  too fast to sample — try a bigger workload or %timeit'));
  lines.push(p('faint', `total ${formatDuration(total / 1000)} · ${prof.samples.length} samples`));
  shell.print(lines.join('\n'));
  if (error) throw error;
  return result;
}

lineMagic(['profile', 'prun'], {
  doc: 'Profile a statement with the V8 CPU profiler and show where the time went (self time per function). -l N shows N rows.',
  usage: '[-l N] code',
  category,
}, (shell, args) => {
  const m = /^((?:\s*-l\s*\d+)?)\s*([\s\S]*)$/.exec(args);
  const { opts } = parseArgs(m[1], { l: 'value' });
  if (!m[2].trim()) throw new MagicError('usage: %profile code');
  return profile(shell, m[2], opts.l ? +opts.l : 15);
});

cellMagic(['profile', 'prun'], { doc: 'Profile the whole cell. -l N shows N rows.', usage: '[-l N]', category }, (shell, args, body) => {
  const { opts } = parseArgs(args, { l: 'value' });
  return profile(shell, body, opts.l ? +opts.l : 15);
});

// ── %%capture ────────────────────────────────────────────────────────────────

/** What %%capture caught: .stdout, .stderr, .outputs; call it (or .show()) to print everything again. */
export class CapturedIO {
  constructor(shell) {
    const self = () => self.show();
    Object.setPrototypeOf(self, CapturedIO.prototype);
    Object.assign(self, { stdout: '', stderr: '', outputs: [], shell });
    Object.defineProperty(self, 'shell', { enumerable: false });
    return self;
  }

  show() {
    const s = this.shell;
    if (this.stdout) process.stdout.write(this.stdout);
    if (this.stderr) process.stderr.write(this.stderr);
    for (const v of this.outputs) s.print(renderValue(v, { theme: s.theme, width: s.width - 2, depth: s.settings.depth }));
  }

  [util.inspect.custom]() {
    return `<CapturedIO stdout: ${this.stdout.length} chars, stderr: ${this.stderr.length} chars, ${this.outputs.length} output${this.outputs.length === 1 ? '' : 's'}>`;
  }
}

cellMagic(['capture'], {
  doc: 'Run the cell and keep its output instead of printing it: %%capture out, then out.stdout, out.stderr, out.outputs, or out() to show it. --no-stdout, --no-stderr and --no-display let those through.',
  usage: '[--no-stdout] [--no-stderr] [--no-display] [name]',
  category,
}, async (shell, args, body) => {
  const { opts, rest } = parseArgs(args, { 'no-stdout': 'bool', 'no-stderr': 'bool', 'no-display': 'bool' });
  const io = new CapturedIO(shell);
  const saved = [process.stdout.write, process.stderr.write, shell.print];
  const catcher = (key, passthrough, original) => function (chunk, encoding, cb) {
    if (passthrough) return original.call(process[key], chunk, encoding, cb);
    io[key] += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    const done = typeof encoding === 'function' ? encoding : cb;
    if (done) process.nextTick(done);
    return true;
  };
  process.stdout.write = catcher('stdout', opts['no-stdout'], saved[0]);
  process.stderr.write = catcher('stderr', opts['no-stderr'], saved[1]);
  try {
    const { value, shows } = await shell.execute(body, shell.count);
    if (shows && value !== undefined) {
      if (opts['no-display']) shell.print(renderValue(value, { theme: shell.theme, width: shell.width - 2, depth: shell.settings.depth }));
      else io.outputs.push(value);
    }
  } finally {
    [process.stdout.write, process.stderr.write] = saved;
  }
  if (rest[0]) globalThis[rest[0]] = io;
  return undefined;
});

lineMagic(['tb'], {
  doc: 'Show the last error again, optionally in another %xmode: %tb verbose.',
  usage: '[minimal|plain|context|verbose]',
  category,
}, (shell, args) => {
  if (!shell.lastError) throw new MagicError('no error yet');
  const mode = args.trim() || shell.settings.xmode;
  if (!['minimal', 'plain', 'context', 'verbose'].includes(mode)) throw new MagicError('mode must be minimal, plain, context or verbose');
  shell.print(renderError(shell.lastError, { theme: shell.theme, sources: shell.sources, mode, width: shell.width - 2 }));
});

// ── clipboard ────────────────────────────────────────────────────────────────

const PASTE_TOOLS = [['pbpaste'], ['wl-paste', '--no-newline'], ['xclip', '-selection', 'clipboard', '-o'], ['xsel', '--clipboard', '--output']];

function readClipboard() {
  for (const [cmd, ...args] of PASTE_TOOLS) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (!r.error && r.status === 0) return r.stdout;
  }
  throw new MagicError('no clipboard tool found (pbpaste, wl-paste, xclip or xsel)');
}

async function runPasted(shell, text, quiet) {
  const source = stripPrompts(text.replace(/\r\n?/g, '\n')).trimEnd();
  if (!source.trim()) throw new MagicError('nothing to run');
  if (!quiet) shell.print(source.split('\n').map((l) => shell.theme.paint('faint', '· ') + l).join('\n'));
  shell.history.storeInput(shell.count, source);
  const { value, shows } = await shell.execute(source, shell.count);
  return shows ? value : undefined;
}

lineMagic(['paste'], {
  doc: 'Run the code on the clipboard (prompts like > are removed). -q runs it without showing it.',
  usage: '[-q]',
  category,
}, (shell, args) => {
  const { opts } = parseArgs(args, { q: 'bool' });
  return runPasted(shell, readClipboard(), opts.q);
});

lineMagic(['cpaste'], {
  doc: 'Paste or type a block of code, then end it with a line holding only -- (or Ctrl+D); it runs as one cell. Prompts like > are removed.',
  usage: '[-q]',
  category,
}, async (shell, args) => {
  const { opts } = parseArgs(args, { q: 'bool' });
  shell.spinner.pause(true);
  const out = shell.realStdoutWrite ?? ((s) => process.stdout.write(s));
  out(shell.theme.paint('faint', 'paste code, then -- on its own line:') + '\n');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = [];
  try {
    for await (const line of rl) {
      if (line.trim() === '--') break;
      lines.push(line);
    }
  } finally {
    rl.close();
    shell.spinner.pause(false);
  }
  return runPasted(shell, lines.join('\n'), opts.q);
});

// ── %autoreload ──────────────────────────────────────────────────────────────

lineMagic(['autoreload'], {
  doc: 'Reload CommonJS files you changed before each cell, updating the objects you already hold (exports objects and class methods): %autoreload 2 for every file you required, 1 for only the %aimport-ed ones, 0 to stop. Alone, reloads changed files now. ES modules are cached by Node and can\'t be reloaded.',
  usage: '[0|1|2]',
  category,
}, (shell, args) => {
  const v = args.trim();
  if (v) {
    try {
      shell.setSetting('autoreload', v);
    } catch (e) {
      throw new MagicError(e.message);
    }
    shell.print(shell.theme.paint('muted', ['autoreload off', 'autoreload: %aimport-ed files', 'autoreload: every file you require'][shell.settings.autoreload]));
    return;
  }
  const mode = shell.autoreload.mode;
  shell.autoreload.mode = mode || 2;
  const results = shell.autoreload.check(true);
  shell.autoreload.mode = mode;
  shell.reportReload(results);
  if (!results.length) shell.print(shell.theme.paint('faint', 'nothing to reload'));
});

lineMagic(['aimport'], {
  doc: 'Mark a file for %autoreload 1 (and require it): %aimport ./lib.js. Alone, lists the marked files.',
  usage: '[module…]',
  category,
}, (shell, args) => {
  const { rest } = parseArgs(args);
  if (!rest.length) {
    const files = [...shell.autoreload.marked].map((f) => path.relative(process.cwd(), f));
    shell.print(files.length ? files.join('\n') : shell.theme.paint('faint', 'no files marked'));
    return;
  }
  for (const spec of rest) {
    let file;
    try {
      file = shell.require.resolve(spec);
    } catch (e) {
      throw new MagicError(`can't find ${spec}: ${e.code ?? e.message}`);
    }
    shell.require(file);
    shell.autoreload.marked.add(file);
    shell.autoreload.snapshot(true);
  }
});
