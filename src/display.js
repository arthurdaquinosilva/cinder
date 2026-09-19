// Rendering values, errors and `obj?` inspections.

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { highlight } from './highlight.js';
import { describe, isClass, listProperties } from './introspect.js';
import { functionLocation } from './locate.js';
import { originalPosition } from './typescript.js';
import { functionInfo, renderSignature } from './signature.js';
import { shortPath, truncate } from './text.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OWN_DIRS = [path.join(ROOT, 'src') + path.sep, path.join(ROOT, 'bin') + path.sep];

export const CELL_FILE_RE = /\[cell (\d+)\]/;

export function cellFilename(n, cwd = process.cwd()) {
  return path.join(cwd, `[cell ${n}]`);
}

/**
 * A copy of `value` where non-integer numbers print with `digits` decimals. Arrays, plain objects, Maps and
 * Sets are copied (to `depth`); anything else is left as it is.
 */
export function withPrecision(value, digits, depth = 6, seen = new Map()) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) || !Number.isFinite(value)) return value;
    const text = value.toFixed(digits);
    return { [util.inspect.custom]: (_d, opts) => opts.stylize(text, 'number') };
  }
  if (value === null || typeof value !== 'object' || depth < 0) return value;
  if (seen.has(value)) return seen.get(value);
  const next = (v) => withPrecision(v, digits, depth - 1, seen);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const v of value) out.push(next(v));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(k, next(v));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(next(v));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = Object.create(proto);
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = next(v);
  return out;
}

export function renderValue(value, { theme, width = 80, depth = 4, colors = true, precision = '' }) {
  if (precision !== '' && precision !== undefined) value = withPrecision(value, Number(precision));
  return util.inspect(value, {
    colors: colors && theme.color,
    depth,
    breakLength: Math.max(40, width - 4),
    maxArrayLength: 100,
    maxStringLength: 10_000,
    compact: 3,
    sorted: false,
    getters: false,
    showProxy: false,
  });
}

// ── errors ────────────────────────────────────────────────────────────────────

const FRAME_RE = /^\s*at (async )?(?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/;

export function parseStack(stack = '') {
  const frames = [];
  for (const line of String(stack).split('\n')) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    frames.push({ async: !!m[1], fn: m[2] ?? '', file: m[3], line: +m[4], col: +m[5], raw: line.trim() });
  }
  return frames;
}

function isInternal(frame) {
  const file = frame.file.replace(/^file:\/\//, '');
  return (
    file.startsWith('node:') || OWN_DIRS.some((d) => file.startsWith(d)) || file === 'native' || file === '<anonymous>'
    || file.includes('/node_modules/acorn')
  );
}

/**
 * `sources` maps a filename (cells are `<cwd>/[cell N]`) to {source, col1}. Modes: minimal (one line), plain (the standard stack),
 * context (source around your frames, the default) and verbose (every frame, the cause chain and extra fields).
 */
export function renderError(error, { theme, sources = new Map(), mode = 'context', width = 80 }) {
  const p = (s, t) => theme.paint(s, t);
  if (!(error instanceof Error) && !(error && typeof error === 'object' && 'stack' in error)) {
    return `${p('err.bold', '✗ Uncaught ')}${renderValue(error, { theme, width, depth: 2 })}`;
  }
  const name = error.name || error.constructor?.name || 'Error';
  let message = String(error.message ?? '');
  const lines = [];

  // acorn syntax errors carry the position on the error itself
  if (error.loc && error.file !== undefined && name === 'SyntaxError') {
    message = message.replace(/\s*\(\d+:\d+\)$/, '');
    lines.push(p('err.bold', `✗ ${name}`) + p('fg', `: ${message}`));
    if (mode !== 'minimal') lines.push(...sourceContext(sources.get(error.file)?.source, error.loc.line, error.loc.column, fileLabel(error.file), theme));
    return lines.join('\n');
  }

  if (error.typescript) {
    return p('err.bold', `✗ ${name}`) + p('faint', ' (TypeScript)') + p('fg', `: ${message}`);
  }

  const header = p('err.bold', `✗ ${name}`) + (message ? p('fg', `: ${message}`) : '');
  if (mode === 'minimal') return header.split('\n')[0];
  if (mode === 'plain') return p('err', relabel(String(error.stack ?? `${name}: ${message}`)));

  lines.push(header);
  const extras = errorExtras(error);
  if (extras) lines.push(p('faint', '  ' + extras));

  const frames = parseStack(error.stack);
  const shown = mode === 'verbose' ? frames : frames.filter((f) => !isInternal(f));
  let contexts = 0;
  for (const f of shown.slice(0, mode === 'verbose' ? 30 : 8)) {
    const known = sources.get(f.file);
    if (known) {
      // back to the code you wrote: undo the async wrapper's shift on line 1, then TypeScript's source map
      const col = f.line === 1 ? f.col - known.col1 : f.col;
      ({ line: f.line, column: f.col } = originalPosition(known.map, f.line, col));
    }
    const where = fileLabel(f.file);
    const fn = f.fn && f.fn !== '<anonymous>' && !(known && /^(async )?<?anonymous>?$/.test(f.fn)) ? f.fn : '';
    lines.push(p('faint', '  at ') + (fn ? p('info', fn.replace(/^Object\./, '')) + p('faint', ' · ') : '') + p('muted', `${where}:${f.line}`));
    const withContext = mode === 'verbose' || contexts < 3;
    if (!withContext) continue;
    if (known) {
      lines.push(...sourceContext(known.source, f.line, f.col - 1, null, theme, 4));
      contexts++;
    } else if (!isInternal(f)) {
      const file = f.file.replace(/^file:\/\//, '');
      try {
        if (!file.includes('node_modules') || mode === 'verbose') {
          lines.push(...sourceContext(fs.readFileSync(file, 'utf8'), f.line, f.col - 1, null, theme, 4));
          contexts++;
        }
      } catch {
        // no source on disk
      }
    }
  }
  if (!shown.length && frames.length && mode !== 'verbose') lines.push(p('faint', '  (only internal frames — %xmode verbose shows them)'));

  let cause = error.cause;
  let depth = 0;
  while (cause !== undefined && depth < 4) {
    lines.push(p('warn', '  caused by ') + (cause instanceof Error ? p('fg', `${cause.name}: ${cause.message}`) : renderValue(cause, { theme, width, depth: 1 })));
    cause = cause instanceof Error ? cause.cause : undefined;
    depth++;
  }
  if (error instanceof AggregateError) {
    for (const e of error.errors.slice(0, 5)) lines.push(p('warn', '  · ') + p('fg', e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  }
  return lines.join('\n');
}

function errorExtras(error) {
  const skip = new Set(['stack', 'message', 'name', 'cause', 'errors', 'cell']);
  const parts = [];
  for (const key of Object.keys(error)) {
    if (skip.has(key)) continue;
    let v;
    try {
      v = util.inspect(error[key], { depth: 0, breakLength: Infinity });
    } catch {
      continue;
    }
    parts.push(`${key}: ${truncate(v, 60)}`);
  }
  return parts.join(' · ');
}

/** `cell 3` for cells, `[eval]` for other code typed into cinder, a short path for files. */
export function fileLabel(file) {
  const cell = CELL_FILE_RE.exec(file);
  if (cell) return `cell ${cell[1]}`;
  const base = path.basename(file);
  if (/^\[.*\]$/.test(base)) return base;
  return shortPath(file.replace(/^file:\/\//, ''));
}

/** Rewrite cell file paths in a stack to `cell N`. */
export function relabel(stack) {
  return stack.replace(/(?:[^\s(]*\/)?\[cell (\d+)\]/g, 'cell $1');
}

function sourceContext(source, line, col, label, theme, indent = 2) {
  if (!source) return [];
  const all = source.split('\n');
  const out = [];
  const pad = ' '.repeat(indent);
  const from = Math.max(1, line - 1);
  const to = Math.min(all.length, line + 1);
  const gutter = String(to).length;
  for (let n = from; n <= to; n++) {
    const text = all[n - 1] ?? '';
    const mark = n === line ? theme.paint('err.bold', '❱') : ' ';
    out.push(`${pad}${mark} ${theme.paint(n === line ? 'muted' : 'faint', String(n).padStart(gutter))} ${theme.paint('border', '│')} ${n === line ? highlight(text, theme) : theme.paint('faint', text)}`);
    if (n === line && col >= 0 && col <= text.length) {
      out.push(`${pad}  ${' '.repeat(gutter)} ${theme.paint('border', '│')} ${' '.repeat(col)}${theme.paint('err.bold', '^')}${label ? theme.paint('faint', '  ' + label) : ''}`);
    }
  }
  return out;
}

// ── obj? ──────────────────────────────────────────────────────────────────────

/** `obj?` shows type, signature and value; `obj??` adds the source of functions and classes. */
export function renderInspect(expr, value, level, { theme, width = 80, sources = [] }) {
  const p = (s, t) => theme.paint(s, t);
  const rows = [];
  const row = (key, val) => rows.push([key, val]);
  row('type', p('fg', describe(value)));

  if (typeof value === 'function') {
    const info = functionInfo(value, expr, sources);
    if (info) {
      row('signature', renderSignature(info, width - 14, theme));
      if (info.summary) row('doc', p('fg', info.summary));
    }
    const loc = functionLocation(value);
    if (loc) row('file', p('muted', `${fileLabel(loc.file)}:${loc.line}`));
    if (isClass(value) && value.prototype) {
      const methods = Object.getOwnPropertyNames(value.prototype).filter((n) => n !== 'constructor');
      if (methods.length) row('methods', p('muted', truncate(methods.join(', '), width - 14)));
      const statics = Object.getOwnPropertyNames(value).filter((n) => !['length', 'name', 'prototype'].includes(n));
      if (statics.length) row('static', p('muted', truncate(statics.join(', '), width - 14)));
    }
    const proto = Object.getPrototypeOf(value);
    if (isClass(value) && proto && proto !== Function.prototype) row('extends', p('fg', proto.name || '(anonymous)'));
  } else if (value !== null && typeof value === 'object') {
    const chain = [];
    let proto = Object.getPrototypeOf(value);
    while (proto && chain.length < 6) {
      chain.push(proto.constructor?.name ?? '?');
      proto = Object.getPrototypeOf(proto);
    }
    if (chain.length) row('prototype', p('fg', chain.join(' → ')));
    const own = Object.keys(value);
    if (own.length) row('keys', p('muted', truncate(own.join(', '), width - 14)));
    const methods = listProperties(value)
      .filter((x) => x.depth > 0 && x.owner !== Object.prototype)
      .filter((x) => {
        try {
          return typeof x.owner[x.name] === 'function';
        } catch {
          return false;
        }
      })
      .map((x) => x.name);
    if (methods.length) row('methods', p('muted', truncate(methods.join(', '), width - 14)));
  }

  const lines = [p('inspect.head', expr)];
  for (const [k, v] of rows) lines.push(`  ${p('inspect.key', k.padEnd(10))} ${v}`);
  if (typeof value !== 'function' || level < 2) {
    const shown = renderValue(value, { theme, width: width - 2, depth: level > 1 ? 4 : 1 });
    const valueLines = shown.split('\n');
    const limit = level > 1 ? 200 : 12;
    lines.push(`  ${p('inspect.key', 'value'.padEnd(10))} ${valueLines[0]}`);
    for (const l of valueLines.slice(1, limit)) lines.push(`  ${' '.repeat(11)}${l}`);
    if (valueLines.length > limit) lines.push(`  ${' '.repeat(11)}${p('faint', `… ${valueLines.length - limit} more lines (${expr}?? shows more)`)}`);
  }
  if (level > 1 && typeof value === 'function') {
    let src = '';
    try {
      src = Function.prototype.toString.call(value);
    } catch {
      // not available
    }
    lines.push(`  ${p('inspect.key', 'source')}`);
    if (/\[native code\]/.test(src)) lines.push(`    ${p('faint', 'native code — no JavaScript source')}`);
    else for (const l of src.split('\n')) lines.push(`    ${highlight(l, theme)}`);
  }
  return lines.join('\n');
}

/** Names on globalThis (and deeper, via dots) matching a wildcard pattern like `Math.*sin*`. */
export function psearch(pattern, scope = globalThis) {
  const parts = pattern.split('.');
  let objects = [['', scope]];
  for (let i = 0; i < parts.length; i++) {
    const re = new RegExp('^' + parts[i].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const next = [];
    for (const [prefix, obj] of objects) {
      if (obj === null || obj === undefined) continue;
      const names = i === 0 && obj === globalThis
        ? Object.getOwnPropertyNames(globalThis)
        : listProperties(obj).map((x) => x.name);
      for (const name of names) {
        if (!re.test(name)) continue;
        let v;
        try {
          v = obj[name];
        } catch {
          continue;
        }
        next.push([prefix ? `${prefix}.${name}` : name, v]);
      }
    }
    objects = next;
  }
  return objects.map(([name]) => name).sort();
}

