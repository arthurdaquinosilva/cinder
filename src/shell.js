// The execution engine: globals, cell execution, output capture and cell chrome.

import { spawn } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import util from 'node:util';
import vm from 'node:vm';
import { cellFilename, psearch, renderError, renderInspect, renderValue } from './display.js';
import { runs, styleMap } from './highlight.js';
import { HistoryManager } from './history.js';
import { describe, resolveExpr } from './introspect.js';
import { CELL_MAGICS, LINE_MAGICS, MagicError, lookupMagic } from './magics/index.js';
import { Macro } from './magics/history.js';
import { DEFAULT_ALIASES } from './magics/osm.js';
import { AutoReloader } from './autoreload.js';
import { Rail, Spinner } from './output.js';
import { Settings } from './config.js';
import { charWidth, formatDuration, stripAnsi, width as textWidth } from './text.js';
import { Theme } from './theme.js';
import { API, classify, parse, rewrite, stripPrompts, transformMagicLines, wrapObjectLiteral } from './transform.js';
import * as ts from './typescript.js';

function parsesAsJavaScript(code) {
  try {
    parse(wrapObjectLiteral(code));
    return true;
  } catch {
    return false;
  }
}

export class ExitRequest extends Error {
  constructor(code = 0) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export class Interrupted extends Error {
  constructor() {
    super('interrupted');
    this.name = 'Interrupted';
  }
}

// vm.USE_MAIN_CONTEXT_DEFAULT_LOADER warns that it's experimental; it's the documented way for scripts to
// use import(), so keep the warning out of the user's session.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/USE_MAIN_CONTEXT_DEFAULT_LOADER|stripTypeScriptTypes|Type Stripping|type stripping|registerHooks/i.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};

const IMPORT_LOADER = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

export class Shell {
  constructor({ settings = new Settings(), profile = null, history = undefined, stdout = process.stdout } = {}) {
    this.settings = settings;
    this.profile = profile;
    this.theme = new Theme(settings.theme);
    this.theme.installInspectColors();
    this.stdout = stdout;
    this.In = [''];
    this.Out = {};
    this.sources = new Map(); // filename → {source, col1}, for error context
    this.count = 0;
    this.lastDuration = null;
    this.lastOk = true;
    this.lastError = null;
    this.nextInput = '';
    this.prevDir = null;
    this.running = false;
    this.suppressFooter = false;
    this.aliases = { ...DEFAULT_ALIASES, ...settings.aliases };
    this.logger = null;
    this.dirStack = [];
    this.dirHistory = [process.cwd()];
    this.bgJobs = [];
    this.autoreload = new AutoReloader();
    this.autoreload.mode = settings.autoreload;
    if (settings.autoreload) this.autoreload.snapshot();
    this.bookmarks = {};
    this.cleared = new Set(); // undeletable globals set to undefined by %del/%reset
    this.history = history ?? new HistoryManager(profile ? profile.historyFile : null);
    this.rail = null;
    this.interruptWait = null;
    this.onBackgroundOutput = null; // set by the UI while the prompt is showing
    this.spinner = new Spinner(1, this.spinnerLook());
    ts.setTypeScriptMode(settings.typescript);
    if (settings.typescript !== 'off') ts.installLoader();
    this.installGlobals();
  }

  // ── globals ─────────────────────────────────────────────────────────────────

  installGlobals() {
    const g = globalThis;
    const shell = this;
    const define = (name, value) => Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
    define('__cinder__', {
      magic: (name, args) => shell.runMagic(name, args),
      show: (value) => {
        if (value !== undefined) shell.print(shell.renderResult(value));
        return value;
      },
      shell,
    });
    define('In', this.In);
    define('Out', this.Out);
    this.updateRequire();

    // `_` and `_error` hold the last result and error until you assign to them yourself (as in Node's REPL).
    for (const [name, get] of [['_', () => shell.lastValue], ['_error', () => shell.lastError]]) {
      Object.defineProperty(g, name, {
        get,
        set(value) {
          Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
          shell.print(shell.theme.paint('faint', `(${name} is yours now; cinder stops updating it)`));
        },
        configurable: true,
        enumerable: false,
      });
    }

    if (this.settings.autoImport) {
      for (const name of builtinModules) {
        if (name.startsWith('_') || name.includes('/') || !/^[a-z_$][\w$]*$/i.test(name) || name in g) continue;
        Object.defineProperty(g, name, {
          get() {
            const value = shell.require(`node:${name}`);
            Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
            return value;
          },
          set(value) {
            Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
          },
          configurable: true,
          enumerable: false,
        });
      }
    }

    // process.exit() in a cell ends cinder cleanly instead of killing it mid-render.
    if (!process.exit.__cinder) {
      const realExit = process.exit.bind(process);
      const exit = (code) => {
        if (shell.running) throw new ExitRequest(code ?? process.exitCode ?? 0);
        shell.onExitRequest?.(code ?? 0);
        realExit(code);
      };
      exit.__cinder = realExit;
      process.exit = exit;
    }
    this.initialNames = new Set(Object.getOwnPropertyNames(g));
  }

  updateRequire() {
    this.require = createRequire(path.join(process.cwd(), '[cinder]'));
    Object.defineProperty(globalThis, 'require', { value: this.require, writable: true, configurable: true, enumerable: false });
  }

  /**
   * Remove a global you created. Top-level `var` and `function` declarations make bindings JavaScript can't
   * delete; those are set to undefined and hidden from %who instead.
   */
  deleteVar(name) {
    if (Object.getOwnPropertyDescriptor(globalThis, name)?.configurable !== false) {
      delete globalThis[name];
      return true;
    }
    globalThis[name] = undefined;
    this.cleared.add(name);
    return false;
  }

  isDefined(name) {
    return name in globalThis;
  }

  /** Variables you created: globals that weren't there at startup. */
  userVars() {
    const out = {};
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (this.initialNames.has(name) || /^_i?\d+$/.test(name)) continue;
      if (this.cleared.has(name) && globalThis[name] === undefined) continue;
      const d = Object.getOwnPropertyDescriptor(globalThis, name);
      if (d && 'value' in d) out[name] = d.value;
    }
    return out;
  }

  setSetting(name, value) {
    value = Settings.validate(name, value);
    if (name === 'autoreload') {
      this.autoreload.mode = value;
      if (value) this.autoreload.snapshot();
    }
    if (name === 'typescript') {
      ts.setTypeScriptMode(value);
      if (value !== 'off') ts.installLoader();
    }
    if (name === 'theme') {
      this.theme = new Theme(value);
      this.theme.installInspectColors();
      this.spinner.setLook(this.spinnerLook());
    }
    this.settings[name] = value;
    return value;
  }

  // ── output ──────────────────────────────────────────────────────────────────

  get width() {
    return this.stdout.columns || 100;
  }

  /** Print a line: onto the rail while a cell runs, otherwise straight to the terminal. */
  print(text = '') {
    const line = text.endsWith('\n') ? text : text + '\n';
    if (this.rail) this.rail.write(line);
    else if (this.onBackgroundOutput) this.onBackgroundOutput(line);
    else this.write(line);
  }

  write(text) {
    this.realStdoutWrite ? this.realStdoutWrite(text) : this.stdout.write(text);
  }

  spinnerLook() {
    const t = this.theme;
    const open = (style) => (t.color ? `\x1b[${t.codes[style]}m` : '');
    const reset = t.color ? '\x1b[0m' : '';
    return {
      before: t.paint('border', '╰─ '),
      frameOpen: open('accent'),
      after: reset + t.paint('muted', ' running '),
      timeOpen: open('faint'),
      hint: reset + t.paint('faint', '  ctrl+c to interrupt'),
      reset,
    };
  }

  /** Route process.stdout/stderr through a rail while `fn` runs. */
  async capture(fn) {
    const plainOut = process.stdout.write;
    const plainErr = process.stderr.write;
    const realWrite = this.stdout === process.stdout ? (text) => plainOut.call(process.stdout, text) : (text) => this.stdout.write(text);
    const rail = new Rail({
      prefix: this.theme.paint('border', '│') + ' ',
      errPrefix: this.theme.paint('err', '│') + ' ',
      spinner: this.spinner,
      sink: realWrite,
    });
    const decode = (chunk, encoding) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'));
    const patch = (isErr) => function (chunk, encoding, cb) {
      rail.write(decode(chunk, encoding), isErr);
      const done = typeof encoding === 'function' ? encoding : cb;
      if (done) process.nextTick(done);
      return true;
    };
    this.rail = rail;
    this.realStdoutWrite = realWrite;
    process.stdout.write = patch(false);
    process.stderr.write = patch(true);
    this.spinner.start();
    try {
      return await fn(rail);
    } finally {
      this.spinner.stop();
      process.stdout.write = plainOut;
      process.stderr.write = plainErr;
      this.rail = null;
      this.realStdoutWrite = null;
      rail.finish();
    }
  }

  /** Wait for a promise, but let Ctrl+C stop waiting. */
  waitInterruptible(promise) {
    return new Promise((resolve, reject) => {
      this.interruptWait = () => reject(new Interrupted());
      Promise.resolve(promise).then(resolve, reject).finally(() => {
        this.interruptWait = null;
      });
    });
  }

  /** Ctrl+C outside synchronous code (vm's breakOnSigint handles that). */
  interrupt() {
    if (this.interruptWait) {
      this.interruptWait();
      return true;
    }
    return false;
  }

  // ── running cells ───────────────────────────────────────────────────────────

  /**
   * Run one cell with its chrome: echo, rail output, footer. Returns {ok, value, error}.
   * `echo: false` skips printing the source (the caller already did, or it's not interactive).
   */
  async runCell(raw, { storeHistory = true, echo = true, footer = true } = {}) {
    const source = stripPrompts(raw).replace(/^\n+/, '').trimEnd();
    if (!source.trim()) return { ok: true };
    const trimmed = source.trim();
    if (['exit', 'quit', '.exit', 'exit()', 'quit()'].includes(trimmed) && !(trimmed.replace(/\(\)$/, '') in globalThis)) {
      throw new ExitRequest(0);
    }
    const n = ++this.count;
    this.In.push(source);
    globalThis[`_i${n}`] = source;
    if (storeHistory) this.history.storeInput(n, source);
    this.logger?.logInput(source);
    this.suppressFooter = false;
    if (echo) this.echo(source);

    let value;
    let shows = false;
    let error = null;
    let status = null;
    const start = process.hrtime.bigint();
    this.running = true;
    try {
      await this.capture(async () => {
        try {
          if (this.autoreload.mode) this.reportReload(this.autoreload.check());
          ({ value, shows, status } = await this.execute(source, n));
          if (shows && value !== undefined) this.displayResult(n, value);
        } catch (e) {
          if (e instanceof ExitRequest) throw e;
          error = e;
          this.showError(e, n);
        }
      });
    } finally {
      this.running = false;
    }
    if (this.autoreload.mode) this.autoreload.snapshot(true);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
    this.lastDuration = elapsed;
    this.lastOk = !error && !status;
    if (footer && !this.suppressFooter) this.footer(n, elapsed, shows ? value : undefined, error, status);
    return { ok: this.lastOk, value, error };
  }

  /** Run a cell's code without chrome (startup files, -e, nested calls). Errors are thrown. */
  async runQuiet(source, filename = '<startup>') {
    const cls = classify(source, (n) => this.isDefined(n));
    if (cls.kind !== 'js') return (await this.execute(source, filename)).value;
    return this.runJS(cls.source, filename).then((r) => r.value);
  }

  async execute(source, n) {
    const trimmed = source.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && globalThis[trimmed] instanceof Macro) {
      this.print(this.theme.paint('faint', `=== running macro ${trimmed} ===`));
      return this.execute(globalThis[trimmed].source, n);
    }
    const cls = classify(this.automagic(source), (name) => this.isDefined(name));
    switch (cls.kind) {
      case 'magic':
        return this.shows(await this.runMagic(cls.name, cls.args));
      case 'cellmagic':
        return this.shows(await this.runCellMagic(cls.name, cls.args, cls.body));
      case 'shell': {
        const code = await this.system(cls.cmd);
        return { value: undefined, shows: false, status: code ? `exit ${code}` : null };
      }
      case 'inspect': {
        const found = this.evalSimple(cls.expr);
        this.print(renderInspect(cls.expr, found, cls.level, { theme: this.theme, width: this.width - 2, sources: this.In }));
        return { value: undefined, shows: false };
      }
      case 'psearch': {
        const names = psearch(cls.pattern);
        this.print(names.length ? names.join('\n') : this.theme.paint('faint', `nothing matches ${cls.pattern}`));
        return { value: undefined, shows: false };
      }
      default:
        return this.runJS(cls.source, n);
    }
  }

  /**
   * `cd ..`, `pwd`, `ls -la`: a one-line cell that starts with a magic's name (one that isn't a variable of
   * yours) runs as that magic, unless what follows the name reads as JavaScript: an assignment, a call, a
   * member access or a comparison (`time = Date.now()`, `run(1)`, `env.PATH`).
   */
  automagic(source) {
    if (!this.settings.automagic || source.includes('\n')) return source;
    const m = /^\s*([A-Za-z_][\w-]*)(?:(\s+)(.*))?$/.exec(source);
    if (!m) return source;
    const name = m[1];
    if (!(LINE_MAGICS[name] || this.aliases[name]) || this.isDefined(name)) return source;
    const rest = m[3] ?? '';
    if (/^(=(?!=)|[-+*/%&|^]=|\*\*=|&&=|\|\|=|\?\?=|==|!=|<=?|>=?|\?|\(|\.|\[|\+\+|--|,|;|=>|instanceof\b|in\b)/.test(rest)) return source;
    if (m[2] === undefined && /[^\w-]/.test(source.trim().slice(name.length))) return source;
    return `%${source.trim()}`;
  }

  shows(value) {
    return { value, shows: value !== undefined };
  }

  /** Evaluate an expression for `obj?`: plain member chains are looked up without running any code. */
  evalSimple(expr) {
    const { found, value } = resolveExpr(expr);
    if (found) return value;
    try {
      return vm.runInThisContext(`(${expr})`, { filename: '[inspect]' });
    } catch (e) {
      throw new MagicError(e instanceof ReferenceError ? `${expr} is not defined` : `${e.name}: ${e.message}`);
    }
  }

  /** Compile and run JS. `n` is the cell number (or a filename for startup code). */
  /**
   * Compile and run a cell (or file). `n` is the cell number, or a label for other code. TypeScript is
   * compiled first when the code isn't JavaScript (or always, with `typescript: true` / the setting).
   */
  async runJS(source, n, { filename, meta, typescript = false } = {}) {
    let code = transformMagicLines(source);
    const file = filename ?? (typeof n === 'number' ? cellFilename(n) : path.resolve(String(n)));
    this.sources.set(file, { source, col1: 0 });
    let map = null;
    const tsMode = ts.typeScriptMode();
    if (typescript || tsMode === 'always' || (tsMode === 'auto' && !parsesAsJavaScript(code))) {
      try {
        ({ code, map } = ts.compile(code, file.endsWith('.ts') ? file : `${file}.ts`));
      } catch (e) {
        // show TypeScript's complaint when it's TypeScript (or forced); otherwise JavaScript's, below
        if (typescript || tsMode === 'always' || ts.looksLikeTypeScript(source)) throw e;
      }
    }
    let r;
    try {
      r = rewrite(code, { meta, interactivity: typeof n === 'number' ? this.settings.interactivity : 'last_expr' });
    } catch (e) {
      if (e instanceof SyntaxError && e.loc) {
        e.file = file;
        e.stack = `${e.name}: ${e.message}`;
      }
      throw e;
    }
    this.sources.set(file, { source, col1: r.col1, map });
    if (meta) globalThis[API].meta = meta;
    const script = new vm.Script(r.code, {
      filename: file,
      importModuleDynamically: IMPORT_LOADER,
    });
    let value = script.runInThisContext({ breakOnSigint: true, displayErrors: false });
    if (r.async) value = await this.waitInterruptible(value);
    return { value, shows: r.shows };
  }

  displayResult(n, value) {
    this.lastValue = value;
    this.Out[n] = value;
    globalThis[`_${n}`] = value;
    if (this.settings.historyLogOutput) {
      let text;
      try {
        text = util.inspect(value, { depth: 2, breakLength: 100, maxArrayLength: 50 }).slice(0, 5000);
      } catch {
        text = null;
      }
      if (text !== null) this.history.storeOutput(n, text);
      if (text !== null) this.logger?.logOutput(text);
    }
    this.print(this.renderResult(value));
  }

  renderResult(value) {
    return renderValue(value, { theme: this.theme, width: this.width - 2, depth: this.settings.depth, precision: this.settings.precision });
  }

  showError(error, n) {
    if (error instanceof MagicError) {
      this.print(this.theme.paint('err', '✗ ') + this.theme.paint('fg', error.message));
      return;
    }
    if (error instanceof Interrupted) {
      this.print(this.theme.paint('warn', '⚠ interrupted') + this.theme.paint('faint', ' — async work the cell started may still be running'));
      return;
    }
    if (error && /^Script execution (was )?interrupted/.test(error.message)) {
      error.name = 'Interrupted';
      this.print(this.theme.paint('warn', '⚠ interrupted'));
      return;
    }
    this.lastError = error;
    this.print(renderError(error, { theme: this.theme, sources: this.sources, mode: this.settings.xmode, width: this.width - 2 }));
  }

  reportReload(results) {
    for (const { file, error } of results) {
      const where = path.relative(process.cwd(), file) || file;
      if (error) this.print(this.theme.paint('warn', `⚠ reloading ${where} failed: ${error.message}`));
      else this.print(this.theme.paint('faint', `↻ reloaded ${where}`));
    }
  }

  /** Errors thrown by timers and promises after their cell finished. */
  reportBackgroundError(error, kind) {
    this.lastError = error;
    const text = this.theme.paint('warn', `⚠ ${kind} in background code`) + '\n'
      + renderError(error, { theme: this.theme, sources: this.sources, mode: this.settings.xmode, width: this.width - 2 });
    this.print(text);
  }

  // ── magics & shell ──────────────────────────────────────────────────────────

  async runMagic(name, args) {
    if (this.aliases[name] !== undefined && !LINE_MAGICS[name]) return this.runAlias(name, args);
    const spec = lookupMagic(LINE_MAGICS, name, '%');
    this.currentMagic = name;
    return spec.fn(this, args);
  }

  async runCellMagic(name, args, body) {
    const spec = lookupMagic(CELL_MAGICS, name, '%%');
    return spec.fn(this, args, body);
  }

  async runAlias(name, args) {
    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    let cmd = this.aliases[name];
    if (cmd.includes('%l')) cmd = cmd.replace('%l', args.trim());
    else {
      cmd = cmd.replace(/%s/g, () => parts.shift() ?? '');
      if (parts.length) cmd += ' ' + parts.join(' ');
    }
    const code = await this.system(cmd);
    if (code) this.suppressFooter = false;
    return undefined;
  }

  /** Expand `$name` / `${expr}` / `{expr}` from JS values in shell commands. `$$` is a literal `$`. */
  expandVars(cmd) {
    return cmd.replace(/\$\$|\$\{([^}]+)\}|\$([A-Za-z_][\w]*)|\{([^{}]+)\}/g, (all, braced, name, curly) => {
      if (all === '$$') return '$';
      const expr = braced ?? curly ?? name;
      if (name && !(name in globalThis)) return all; // leave $HOME and friends to the shell
      try {
        const v = vm.runInThisContext(expr);
        return v === undefined ? all : String(v);
      } catch {
        return all;
      }
    });
  }

  /** Run a shell command, streaming its output onto the rail. Resolves to the exit code. */
  system(cmd, { capture = false, input, program } = {}) {
    const expanded = this.expandVars(cmd);
    const shellPath = process.env.SHELL || '/bin/sh';
    const [file, argv] = program ? [program[0], program.slice(1)] : [shellPath, ['-c', expanded]];
    return new Promise((resolve, reject) => {
      let out = '';
      const child = spawn(file, argv, { stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'], env: process.env });
      if (input !== undefined) child.stdin.end(input);
      child.stdout.on('data', (d) => (capture ? (out += d) : process.stdout.write(d)));
      child.stderr.on('data', (d) => process.stderr.write(d));
      this.interruptWait = () => child.kill('SIGINT');
      child.on('error', (e) => {
        this.interruptWait = null;
        reject(new MagicError(`${file}: ${e.code === 'ENOENT' ? 'command not found' : e.message}`));
      });
      child.on('close', (code, signal) => {
        this.interruptWait = null;
        const status = code ?? (signal ? 128 : 1);
        resolve(capture ? { out, code: status } : status);
      });
    });
  }

  // ── chrome ──────────────────────────────────────────────────────────────────

  /** Print the cell's code, highlighted, wrapped with a 2-column indent under the `>` marker. */
  echo(source) {
    const t = this.theme;
    const styles = styleMap(source);
    const room = Math.max(10, this.width - 2);
    const out = [];
    let offset = 0;
    for (const line of source.split('\n')) {
      let start = 0;
      let w = 0;
      const flush = (end) => {
        const text = runs(line.slice(start, end), styles, offset + start).map(([s, c]) => t.paint(s ?? 'fg', c)).join('');
        out.push(`${out.length ? ' ' : t.paint('accent.bold', this.settings.layout === 'box' ? '❯' : '>')} ${text}`);
      };
      for (let i = 0; i < line.length; i++) {
        const cw = charWidth(line[i]);
        if (w + cw > room) {
          flush(i);
          start = i;
          w = 0;
        }
        w += cw;
      }
      flush(line.length);
      offset += line.length + 1;
    }
    this.write(out.join('\n') + '\n');
  }

  footer(n, elapsed, value, error, status) {
    const p = (s, t) => this.theme.paint(s, t);
    let line = p('border', '╰─ ');
    if (error) {
      const name = error instanceof MagicError ? 'failed' : error instanceof Interrupted || error?.name === 'Interrupted' ? 'interrupted' : error?.name ?? 'Uncaught';
      line += p('err.bold', '✗ ') + p('err', name) + p('faint', ' · ');
    } else if (status) {
      line += p('err.bold', '✗ ') + p('err', status) + p('faint', ' · ');
    } else {
      line += p('ok', '✓ ');
    }
    line += p('muted', formatDuration(elapsed));
    if (value !== undefined && !error) {
      line += p('faint', ' · ') + p('muted', describe(value)) + p('faint', ' · ') + p('faint', `Out[${n}]`);
    }
    if (textWidth(line) > this.width) line = stripAnsi(line).slice(0, this.width - 1);
    this.write(line + '\n\n\n');
  }

  close() {
    for (const job of this.bgJobs) if (job.child.exitCode === null) job.child.kill('SIGTERM');
    this.spinner.close();
  }
}

export { CELL_MAGICS, LINE_MAGICS, MagicError };
