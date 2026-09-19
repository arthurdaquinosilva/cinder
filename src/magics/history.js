// History & session magics.

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import v8 from 'node:v8';
import vm from 'node:vm';
import { highlight } from '../highlight.js';
import { MagicError, lineMagic, parseArgs } from './registry.js';

const category = 'history';

function select(shell, spec) {
  try {
    return shell.history.rangeByString(spec);
  } catch (e) {
    throw new MagicError(e.message);
  }
}

lineMagic(['history', 'hist'], {
  doc: 'Show input history. Ranges: 4, 4-6, 4:6 (end exclusive), ~1/ (the whole previous session), ~2/3-5. -n line numbers, -o outputs, -g pattern searches every session (glob), -l N the last N lines, -u unique, -f file writes to a file, -p adds > prompts.',
  usage: '[-n] [-o] [-p] [-u] [-g pattern] [-l N] [-f file] [range…]',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { n: 'bool', o: 'bool', p: 'bool', u: 'bool', g: 'value', l: 'value', f: 'value' });
  const h = shell.history;
  let entries;
  let numbers = opts.n;
  if (opts.g !== undefined) {
    entries = h.search(opts.g, { unique: opts.u, limit: opts.l ? +opts.l : null });
    numbers = true;
  } else if (opts.l) entries = h.tail(+opts.l).filter((e) => !(e.s === h.session && e.n === shell.count));
  else if (rest.length) entries = select(shell, rest.join(' '));
  else entries = h.range(h.session, 1, shell.count);
  if (opts.u && opts.g === undefined) {
    const seen = new Set();
    entries = entries.filter((e) => !seen.has(e.src) && seen.add(e.src));
  }

  if (opts.f) {
    const text = entries.map((e) => (opts.p ? e.src.split('\n').map((l, i) => (i ? '... ' : '> ') + l).join('\n') : e.src)).join('\n') + '\n';
    const file = path.resolve(opts.f);
    fs.writeFileSync(file, text);
    shell.print(shell.theme.paint('muted', `wrote ${entries.length} entries to ${opts.f}`));
    return;
  }
  const p = (s, t) => shell.theme.paint(s, t);
  const lines = [];
  for (const e of entries) {
    const label = h.label(e);
    const src = e.src.split('\n');
    src.forEach((l, i) => {
      const prompt = opts.p ? (i ? '... ' : '> ') : '';
      const num = numbers ? (i ? ' '.repeat(label.length + 1) : p('faint', label.padStart(label.length)) + ' ') : '';
      lines.push(`${num}${p('faint', prompt)}${highlight(l, shell.theme)}`);
    });
    if (opts.o && e.out !== undefined) lines.push(p('muted', `${numbers ? ' '.repeat(label.length + 1) : ''}→ ${e.out.split('\n').join('\n  ')}`));
  }
  shell.print(lines.length ? lines.join('\n') : p('faint', 'no history yet'));
});

lineMagic(['recall', 'rep'], {
  doc: 'Put history lines back into the input for editing (default: the previous line).',
  usage: '[range]',
  category,
}, (shell, args) => {
  const entries = args.trim() ? select(shell, args) : shell.history.range(shell.history.session, shell.count - 1, shell.count);
  if (!entries.length) throw new MagicError('nothing to recall');
  shell.nextInput = entries.map((e) => e.src).join('\n');
});

lineMagic(['rerun'], {
  doc: 'Run history lines again as one cell (default: the previous line). -l N reruns the last N lines.',
  usage: '[-l N] [range]',
  category,
}, async (shell, args) => {
  const { opts, rest } = parseArgs(args, { l: 'value' });
  const h = shell.history;
  let entries;
  if (opts.l) entries = h.range(h.session, Math.max(1, shell.count - +opts.l), shell.count);
  else if (rest.length) entries = select(shell, rest.join(' '));
  else entries = h.range(h.session, shell.count - 1, shell.count);
  entries = entries.filter((e) => !/^%rerun\b/.test(e.src));
  if (!entries.length) throw new MagicError('nothing to rerun');
  const source = entries.map((e) => e.src).join('\n');
  shell.print(shell.theme.paint('faint', `=== rerunning ${entries.map((e) => h.label(e)).join(', ')} ===`));
  const { value, shows } = await shell.execute(source, shell.count);
  return shows ? value : undefined;
});

lineMagic(['save'], {
  doc: 'Save history lines to a file (default: every line of this session). -a appends; -f overwrites without asking.',
  usage: '[-a] [-f] file [range]',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { a: 'bool', f: 'bool' });
  if (!rest.length) throw new MagicError('usage: %save file.js [range]');
  let file = path.resolve(rest[0]);
  if (!path.extname(file)) file += '.js';
  const h = shell.history;
  const entries = rest.length > 1 ? select(shell, rest.slice(1).join(' ')) : h.range(h.session, 1, shell.count);
  const kept = entries.filter((e) => !/^%save\b/.test(e.src));
  if (!kept.length) throw new MagicError('nothing to save');
  if (fs.existsSync(file) && !opts.a && !opts.f) throw new MagicError(`${rest[0]} exists — use -f to overwrite or -a to append`);
  const text = kept.map((e) => e.src).join('\n') + '\n';
  if (opts.a) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
  shell.print(shell.theme.paint('muted', `${opts.a ? 'appended' : 'saved'} ${kept.length} line${kept.length === 1 ? '' : 's'} to ${path.relative(process.cwd(), file) || file}`));
});

// ── %macro ───────────────────────────────────────────────────────────────────

/** A named piece of history; typing its name alone in a cell runs it. */
export class Macro {
  constructor(source) {
    this.source = source;
  }

  [util.inspect.custom]() {
    const lines = this.source.split('\n');
    return `Macro(${lines.length} line${lines.length === 1 ? '' : 's'}): ${lines[0]}${lines.length > 1 ? ' …' : ''}`;
  }
}

lineMagic(['macro'], {
  doc: 'Name a range of history: %macro setup 1-4, then typing `setup` alone runs those lines again. The macro is a variable, so it can be %store-d.',
  usage: 'name range',
  category,
}, (shell, args) => {
  const { rest } = parseArgs(args);
  const [name, ...range] = rest;
  if (!name || !range.length) throw new MagicError('usage: %macro name range');
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new MagicError(`invalid name ${name}`);
  const entries = select(shell, range.join(' ')).filter((e) => !/^%macro\b/.test(e.src));
  if (!entries.length) throw new MagicError('nothing in that range');
  globalThis[name] = new Macro(entries.map((e) => e.src).join('\n'));
  shell.print(shell.theme.paint('muted', `macro ${name}: ${entries.length} line${entries.length === 1 ? '' : 's'} — type ${name} to run it`));
});

// ── %store ───────────────────────────────────────────────────────────────────

const FN_TAG = '__cinder_function__';

function storeDir(shell) {
  if (!shell.profile) throw new MagicError('%store needs a profile directory (it is off with --no-history in tests)');
  return shell.profile.storeDir;
}

function encode(value) {
  if (typeof value === 'function') return { [FN_TAG]: Function.prototype.toString.call(value) };
  if (value instanceof Macro) return { __cinder_macro__: value.source };
  return value;
}

function decode(value) {
  if (value && typeof value === 'object' && FN_TAG in value) return vm.runInThisContext(`(${value[FN_TAG]})`);
  if (value && typeof value === 'object' && '__cinder_macro__' in value) return new Macro(value.__cinder_macro__);
  return value;
}

/** Restore stored variables into the session; returns their names. */
export function restoreStore(shell, names = null) {
  const dir = storeDir(shell);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.v8'));
  } catch {
    return [];
  }
  const restored = [];
  for (const f of files) {
    const name = f.slice(0, -3);
    if (names && !names.includes(name)) continue;
    try {
      globalThis[name] = decode(v8.deserialize(fs.readFileSync(path.join(dir, f))));
      restored.push(name);
    } catch (e) {
      shell.print(shell.theme.paint('warn', `⚠ can't restore ${name}: ${e.message}`));
    }
  }
  return restored;
}

lineMagic(['store'], {
  doc: 'Keep variables across sessions: %store name… saves them, -r [name…] restores, -d name deletes, -z deletes all, alone lists them. Values are saved with the structured clone algorithm (objects, arrays, Map, Set, Date, typed arrays…); functions are saved as source.',
  usage: '[-r] [-d name] [-z] [name…]',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { r: 'bool', d: 'value', z: 'bool' });
  const dir = storeDir(shell);
  const p = (s, t) => shell.theme.paint(s, t);
  if (opts.z) {
    fs.rmSync(dir, { recursive: true, force: true });
    shell.print(p('muted', 'store cleared'));
    return;
  }
  if (opts.d) {
    const file = path.join(dir, `${opts.d}.v8`);
    if (!fs.existsSync(file)) throw new MagicError(`${opts.d} isn't stored`);
    fs.unlinkSync(file);
    return;
  }
  if (opts.r) {
    const names = restoreStore(shell, rest.length ? rest : null);
    shell.print(p('muted', names.length ? `restored ${names.join(', ')}` : 'nothing stored'));
    return;
  }
  if (!rest.length) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.v8')).sort();
    } catch {
      // nothing yet
    }
    if (!files.length) {
      shell.print(p('faint', 'nothing stored yet'));
      return;
    }
    for (const f of files) {
      let preview = '?';
      try {
        preview = util.inspect(decode(v8.deserialize(fs.readFileSync(path.join(dir, f)))), { depth: 0, breakLength: Infinity }).slice(0, 60);
      } catch {
        // unreadable
      }
      shell.print(`${p('label', f.slice(0, -3).padEnd(16))} ${p('fg', preview)}`);
    }
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const name of rest) {
    if (!(name in globalThis)) throw new MagicError(`${name} is not defined`);
    let data;
    try {
      data = v8.serialize(encode(globalThis[name]));
    } catch (e) {
      throw new MagicError(`can't store ${name}: ${e.message}`);
    }
    fs.writeFileSync(path.join(dir, `${name}.v8`), data);
    shell.print(p('muted', `stored ${name}`));
  }
});

// ── logging ──────────────────────────────────────────────────────────────────

export class Logger {
  constructor(file, { output = false, timestamps = false } = {}) {
    this.file = file;
    this.output = output;
    this.timestamps = timestamps;
    this.active = true;
    fs.appendFileSync(file, `// cinder log started ${new Date().toISOString()}\n`);
  }

  logInput(source) {
    if (!this.active) return;
    const stamp = this.timestamps ? `// ${new Date().toISOString()}\n` : '';
    fs.appendFileSync(this.file, stamp + source + '\n');
  }

  logOutput(text) {
    if (!this.active || !this.output) return;
    fs.appendFileSync(this.file, text.split('\n').map((l) => `//> ${l}`).join('\n') + '\n');
  }
}

lineMagic(['logstart'], {
  doc: 'Log every cell you run to a file (default cinder_log.js, appended). -o also logs results as comments, -t adds timestamps. %logoff / %logon pause and resume, %logstate shows it, %logstop ends it.',
  usage: '[-o] [-t] [file]',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { o: 'bool', t: 'bool' });
  if (shell.logger) throw new MagicError(`already logging to ${shell.logger.file} — %logstop first`);
  const file = path.resolve(rest[0] ?? 'cinder_log.js');
  shell.logger = new Logger(file, { output: opts.o, timestamps: opts.t });
  shell.print(shell.theme.paint('muted', `logging to ${file}${opts.o ? ' (with results)' : ''}`));
});

function needLogger(shell) {
  if (!shell.logger) throw new MagicError('not logging — %logstart first');
  return shell.logger;
}

lineMagic(['logoff'], { doc: 'Pause logging.', category }, (shell) => {
  needLogger(shell).active = false;
});

lineMagic(['logon'], { doc: 'Resume logging.', category }, (shell) => {
  needLogger(shell).active = true;
});

lineMagic(['logstate'], { doc: 'Show where and how cells are logged.', category }, (shell) => {
  const l = shell.logger;
  shell.print(l ? `${l.file} · ${l.active ? 'active' : 'paused'}${l.output ? ' · with results' : ''}${l.timestamps ? ' · timestamps' : ''}` : 'not logging');
});

lineMagic(['logstop'], { doc: 'Stop logging.', category }, (shell) => {
  needLogger(shell);
  shell.logger = null;
});
