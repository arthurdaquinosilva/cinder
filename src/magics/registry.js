// Magic registry: the tables, registration helpers and the option parser magics share.

/** An error raised by a magic, shown as a one-line message instead of a stack trace. */
export class MagicError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MagicError';
  }
}

export const LINE_MAGICS = {};
export const CELL_MAGICS = {};

export const CATEGORIES = {
  core: 'general',
  namespace: 'namespace & inspection',
  execution: 'running & timing',
  history: 'history & session',
  osm: 'shell & files',
};

/** Register a line magic: `lineMagic(['cd'], {doc, usage, category}, fn)`; fn(shell, args). */
export function lineMagic(names, { doc, usage = '', category = 'core' }, fn) {
  for (const name of names) LINE_MAGICS[name] = { name, fn, doc, usage, category, kind: 'line', aliasOf: name === names[0] ? null : names[0] };
}

/** Register a cell magic; fn(shell, args, body). */
export function cellMagic(names, { doc, usage = '', category = 'core' }, fn) {
  for (const name of names) CELL_MAGICS[name] = { name, fn, doc, usage, category, kind: 'cell', aliasOf: name === names[0] ? null : names[0] };
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

export function closest(name, candidates) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const dist = distance(name, c);
    if (dist < bestD) [best, bestD] = [c, dist];
  }
  return bestD <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

export function lookupMagic(table, name, prefix) {
  const spec = table[name];
  if (spec) return spec;
  const close = closest(name, Object.keys(table));
  throw new MagicError(`unknown magic ${prefix}${name}${close ? ` — did you mean ${prefix}${close}?` : ''}`);
}

/** Split an argument string like a shell does: quotes group words, backslashes escape. */
export function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new MagicError('unterminated quote in arguments');
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Parse options. `spec` maps a flag letter (or a long name, used as --name) to 'bool' or 'value':
 * {n: 'value', q: 'bool', bg: 'bool'}.
 * Returns {opts, rest}: flags before the first positional (or `--`) are options; the rest is kept as is.
 */
export function parseArgs(argString, spec = {}) {
  const words = splitArgs(argString);
  const opts = {};
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === '--') {
      i++;
      break;
    }
    if (w.startsWith('--')) {
      const [name, inline] = w.slice(2).split(/=(.*)/s);
      const kind = spec[name];
      if (!kind) throw new MagicError(`unknown option --${name}`);
      if (kind === 'bool') opts[name] = true;
      else {
        const value = inline ?? words[++i];
        if (value === undefined) throw new MagicError(`option --${name} needs a value`);
        opts[name] = value;
      }
      i++;
      continue;
    }
    if (!/^-[A-Za-z]/.test(w) || /^-\d/.test(w)) break;
    let j = 1;
    for (; j < w.length; j++) {
      const flag = w[j];
      const kind = spec[flag];
      if (!kind) throw new MagicError(`unknown option -${flag}`);
      if (kind === 'bool') opts[flag] = true;
      else {
        const value = w.slice(j + 1) || words[++i];
        if (value === undefined) throw new MagicError(`option -${flag} needs a value`);
        opts[flag] = value;
        break;
      }
    }
    i++;
  }
  return { opts, rest: words.slice(i) };
}
