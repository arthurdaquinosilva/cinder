// Looking at live objects: resolving `a.b['c']` chains without calling anything, listing properties,
// and describing values for the cell footer.

import { tokenize } from './lexer.js';

/** Split a member chain like `a.b["c"][0]` into ['a', 'b', 'c', '0'], or null if it isn't one. */
export function splitChain(expr) {
  const toks = tokenize(expr.trim()).filter((t) => t.type !== 'space');
  const parts = [];
  let i = 0;
  const identTypes = new Set(['name', 'builtin', 'class', 'function', 'property', 'constant', 'keyword']);
  if (!toks.length || !identTypes.has(toks[0].type)) return null;
  parts.push(toks[i++].value);
  while (i < toks.length) {
    const t = toks[i];
    if (t.type === 'punct' && (t.value === '.' || t.value === '?.') && toks[i + 1] && identTypes.has(toks[i + 1].type)) {
      parts.push(toks[i + 1].value);
      i += 2;
    } else if (t.type === 'punct' && t.value === '[' && toks[i + 2]?.value === ']'
        && (toks[i + 1].type === 'string' || toks[i + 1].type === 'number')) {
      const lit = toks[i + 1].value;
      parts.push(toks[i + 1].type === 'string' ? lit.slice(1, -1) : lit);
      i += 3;
    } else {
      return null;
    }
  }
  return parts;
}

/** Look up a chain of property names starting from the global scope. Returns {found, value}. */
export function resolveChain(parts, scope = globalThis) {
  if (!parts?.length) return { found: false };
  const [root, ...rest] = parts;
  let value;
  try {
    if (root === 'this') value = scope;
    else if (!(root in scope)) return { found: false };
    else value = scope[root];
    for (const p of rest) {
      if (value === null || value === undefined) return { found: false };
      value = value[p];
    }
    return { found: true, value };
  } catch {
    return { found: false };
  }
}

export function resolveExpr(expr, scope = globalThis) {
  return resolveChain(splitChain(expr), scope);
}

const HIDDEN = new Set(['constructor', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

/** Property names reachable on `value`, own ones first. Returns [{name, owner, depth}]. */
export function listProperties(value) {
  const seen = new Set();
  const out = [];
  if (value === null || value === undefined) return out;
  let obj = typeof value === 'object' || typeof value === 'function' ? value : Object(value);
  let depth = 0;
  while (obj && depth < 20) {
    let names = [];
    try {
      names = Object.getOwnPropertyNames(obj);
    } catch {
      break;
    }
    for (const name of names) {
      if (seen.has(name) || HIDDEN.has(name)) continue;
      if (/^\d+$/.test(name) && names.length > 50) continue; // skip array indexes of big arrays
      seen.add(name);
      out.push({ name, owner: obj, depth });
    }
    try {
      obj = Object.getPrototypeOf(obj);
    } catch {
      break;
    }
    depth++;
  }
  return out;
}

/** The kind of a value, for completion icons: function, class, module, value, property. */
export function kindOf(value) {
  if (typeof value === 'function') return isClass(value) ? 'class' : 'function';
  if (value && typeof value === 'object' && value[Symbol.toStringTag] === 'Module') return 'module';
  return 'value';
}

export function isClass(fn) {
  if (typeof fn !== 'function') return false;
  try {
    const src = Function.prototype.toString.call(fn);
    if (/^class[\s{]/.test(src)) return true;
    // Built-in constructors: capitalised with a real prototype (Map, Date, Promise…)
    return /\[native code\]/.test(src) && /^[A-Z]/.test(fn.name) && !!fn.prototype && Object.getOwnPropertyNames(fn.prototype).length > 1;
  } catch {
    return false;
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A short type/size hint for the cell footer, e.g. 'Array · 3 items'. */
export function describe(value) {
  try {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return `string · ${plural(value.length, 'char')}`;
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol' || t === 'undefined') return t;
    if (t === 'function') {
      if (isClass(value)) return `class${value.name ? ' ' + value.name : ''}`;
      const src = Function.prototype.toString.call(value);
      const prefix = /^async\s/.test(src) ? 'async ' : '';
      const star = /^(async\s+)?function\s*\*/.test(src) ? '*' : '';
      return `${prefix}function${star}${value.name ? ' ' + value.name : ''}`;
    }
    const name = value.constructor?.name ?? 'Object';
    if (Buffer.isBuffer(value)) return `Buffer · ${plural(value.length, 'byte')}`;
    if (Array.isArray(value)) return `${name} · ${plural(value.length, 'item')}`;
    if (ArrayBuffer.isView(value) && 'length' in value) return `${name} · ${plural(value.length, 'item')}`;
    if (value instanceof ArrayBuffer) return `ArrayBuffer · ${plural(value.byteLength, 'byte')}`;
    if (value instanceof Map || value instanceof Set) return `${name} · ${plural(value.size, 'entry').replace('entrys', 'entries')}`;
    if (value instanceof Error) return name;
    if (value instanceof Date || value instanceof RegExp || value instanceof Promise) return name;
    if (value[Symbol.toStringTag] === 'Module') return `module · ${plural(Object.keys(value).length, 'export')}`;
    if (name === 'Object' || Object.getPrototypeOf(value) === null) return `Object · ${plural(Object.keys(value).length, 'key')}`;
    return name;
  } catch {
    return typeof value;
  }
}
