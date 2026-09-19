// Signature hints: `ƒ greet(name: string, times = 1: number) → string` for the call under the cursor.
// Parameters come from the function's own source; types from JSDoc in cells, from defaults, from the value
// being passed, and for V8 built-ins (which have no JS source) from a small table.

import * as acorn from 'acorn';
import { tokenize } from './lexer.js';
import { isClass, resolveExpr } from './introspect.js';
import { width as textWidth } from './text.js';

const OPTS = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true };

// V8 built-ins print as `function max() { [native code] }`, so their parameters are listed here.
const NATIVE = {
  'JSON.stringify': ['value: any, replacer?: Function | string[], space?: string | number', 'string'],
  'JSON.parse': ['text: string, reviver?: Function', 'any'],
  'Object.keys': ['o: object', 'string[]'],
  'Object.values': ['o: object', 'any[]'],
  'Object.entries': ['o: object', '[string, any][]'],
  'Object.fromEntries': ['entries: Iterable<[key, value]>', 'object'],
  'Object.assign': ['target: object, ...sources: object[]', 'object'],
  'Object.freeze': ['o: T', 'Readonly<T>'],
  'Object.create': ['proto: object | null, properties?: PropertyDescriptorMap', 'object'],
  'Object.defineProperty': ['o: object, key: PropertyKey, attributes: PropertyDescriptor', 'object'],
  'Object.getPrototypeOf': ['o: any', 'object | null'],
  'Object.groupBy': ['items: Iterable<T>, callbackfn: (item: T, index: number) => key', 'object'],
  'Array.from': ['items: Iterable<T> | ArrayLike<T>, mapfn?: (v: T, k: number) => U, thisArg?: any', 'U[]'],
  'Array.of': ['...items: T[]', 'T[]'],
  'Array.isArray': ['arg: any', 'boolean'],
  'Promise.all': ['values: Iterable<T | PromiseLike<T>>', 'Promise<T[]>'],
  'Promise.allSettled': ['values: Iterable<T | PromiseLike<T>>', 'Promise<PromiseSettledResult<T>[]>'],
  'Promise.race': ['values: Iterable<T | PromiseLike<T>>', 'Promise<T>'],
  'Promise.any': ['values: Iterable<T | PromiseLike<T>>', 'Promise<T>'],
  'Promise.resolve': ['value?: T', 'Promise<T>'],
  'Promise.reject': ['reason?: any', 'Promise<never>'],
  'Math.max': ['...values: number[]', 'number'],
  'Math.min': ['...values: number[]', 'number'],
  'Math.round': ['x: number', 'number'],
  'Math.floor': ['x: number', 'number'],
  'Math.ceil': ['x: number', 'number'],
  'Math.abs': ['x: number', 'number'],
  'Math.pow': ['x: number, y: number', 'number'],
  'Math.sqrt': ['x: number', 'number'],
  'Math.random': ['', 'number'],
  'Math.trunc': ['x: number', 'number'],
  'Math.sign': ['x: number', 'number'],
  'Math.log': ['x: number', 'number'],
  'Math.hypot': ['...values: number[]', 'number'],
  'Number.parseInt': ['string: string, radix?: number', 'number'],
  'Number.parseFloat': ['string: string', 'number'],
  'Number.isInteger': ['number: unknown', 'boolean'],
  parseInt: ['string: string, radix?: number', 'number'],
  parseFloat: ['string: string', 'number'],
  isNaN: ['number: number', 'boolean'],
  structuredClone: ['value: T, options?: StructuredSerializeOptions', 'T'],
  queueMicrotask: ['callback: () => void', 'void'],
  'console.log': ['...data: any[]', 'void'],
  'console.error': ['...data: any[]', 'void'],
  'console.warn': ['...data: any[]', 'void'],
  'console.info': ['...data: any[]', 'void'],
  'console.table': ['tabularData: any, properties?: string[]', 'void'],
  'console.dir': ['item: any, options?: InspectOptions', 'void'],
  'console.time': ['label?: string', 'void'],
  'console.timeEnd': ['label?: string', 'void'],
  'console.assert': ['condition: boolean, ...data: any[]', 'void'],
  // prototype methods, matched by name when the receiver is an array or string
  'Array#map': ['callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any', 'U[]'],
  'Array#filter': ['predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any', 'T[]'],
  'Array#forEach': ['callbackfn: (value: T, index: number, array: T[]) => void, thisArg?: any', 'void'],
  'Array#find': ['predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any', 'T | undefined'],
  'Array#findIndex': ['predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any', 'number'],
  'Array#findLast': ['predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any', 'T | undefined'],
  'Array#some': ['predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any', 'boolean'],
  'Array#every': ['predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any', 'boolean'],
  'Array#reduce': ['callbackfn: (previous: U, current: T, index: number, array: T[]) => U, initialValue?: U', 'U'],
  'Array#reduceRight': ['callbackfn: (previous: U, current: T, index: number, array: T[]) => U, initialValue?: U', 'U'],
  'Array#flatMap': ['callback: (value: T, index: number, array: T[]) => U | U[], thisArg?: any', 'U[]'],
  'Array#flat': ['depth?: number', 'any[]'],
  'Array#push': ['...items: T[]', 'number'],
  'Array#unshift': ['...items: T[]', 'number'],
  'Array#pop': ['', 'T | undefined'],
  'Array#shift': ['', 'T | undefined'],
  'Array#slice': ['start?: number, end?: number', 'T[]'],
  'Array#splice': ['start: number, deleteCount?: number, ...items: T[]', 'T[]'],
  'Array#concat': ['...items: (T | T[])[]', 'T[]'],
  'Array#join': ['separator?: string', 'string'],
  'Array#includes': ['searchElement: T, fromIndex?: number', 'boolean'],
  'Array#indexOf': ['searchElement: T, fromIndex?: number', 'number'],
  'Array#sort': ['compareFn?: (a: T, b: T) => number', 'T[]'],
  'Array#toSorted': ['compareFn?: (a: T, b: T) => number', 'T[]'],
  'Array#fill': ['value: T, start?: number, end?: number', 'T[]'],
  'Array#at': ['index: number', 'T | undefined'],
  'Array#reverse': ['', 'T[]'],
  'Array#entries': ['', 'ArrayIterator<[number, T]>'],
  'String#split': ['separator: string | RegExp, limit?: number', 'string[]'],
  'String#replace': ['pattern: string | RegExp, replacement: string | Function', 'string'],
  'String#replaceAll': ['pattern: string | RegExp, replacement: string | Function', 'string'],
  'String#slice': ['start?: number, end?: number', 'string'],
  'String#substring': ['start: number, end?: number', 'string'],
  'String#indexOf': ['searchString: string, position?: number', 'number'],
  'String#includes': ['searchString: string, position?: number', 'boolean'],
  'String#startsWith': ['searchString: string, position?: number', 'boolean'],
  'String#endsWith': ['searchString: string, endPosition?: number', 'boolean'],
  'String#padStart': ['maxLength: number, fillString?: string', 'string'],
  'String#padEnd': ['maxLength: number, fillString?: string', 'string'],
  'String#repeat': ['count: number', 'string'],
  'String#match': ['regexp: string | RegExp', 'RegExpMatchArray | null'],
  'String#matchAll': ['regexp: RegExp', 'RegExpStringIterator'],
  'String#trim': ['', 'string'],
  'String#toUpperCase': ['', 'string'],
  'String#toLowerCase': ['', 'string'],
  'String#at': ['index: number', 'string | undefined'],
  'String#charAt': ['pos: number', 'string'],
  'Map#get': ['key: K', 'V | undefined'],
  'Map#set': ['key: K, value: V', 'Map<K, V>'],
  'Map#has': ['key: K', 'boolean'],
  'Map#delete': ['key: K', 'boolean'],
  'Set#add': ['value: T', 'Set<T>'],
  'Set#has': ['value: T', 'boolean'],
  'Set#delete': ['value: T', 'boolean'],
  'Promise#then': ['onfulfilled?: (value: T) => U, onrejected?: (reason: any) => U', 'Promise<U>'],
  'Promise#catch': ['onrejected?: (reason: any) => U', 'Promise<T | U>'],
  'Promise#finally': ['onfinally?: () => void', 'Promise<T>'],
};

/** Parse 'a: T, b?: U, ...c: V[]' from the table. Splits on top-level commas only. */
function parseNativeParams(spec) {
  if (!spec) return [];
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of spec) {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch) && !(ch === '>' && cur.endsWith('='))) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map((p) => {
    const m = /^(\.\.\.)?([\w$]+)(\?)?(?::\s*(.*))?$/.exec(p);
    if (!m) return { name: p };
    return { name: (m[1] ?? '') + m[2], optional: !!m[3], type: m[4], rest: !!m[1] };
  });
}

function literalType(node) {
  if (!node) return null;
  switch (node.type) {
    case 'Literal':
      if (node.regex) return 'RegExp';
      if (node.value === null) return 'null';
      if (typeof node.bigint === 'string') return 'bigint';
      return typeof node.value;
    case 'TemplateLiteral': return 'string';
    case 'ArrayExpression': return 'Array';
    case 'ObjectExpression': return 'object';
    case 'ArrowFunctionExpression':
    case 'FunctionExpression': return 'Function';
    case 'NewExpression': return node.callee.type === 'Identifier' ? node.callee.name : null;
    case 'UnaryExpression': return node.operator === '-' || node.operator === '+' ? 'number' : node.operator === '!' ? 'boolean' : null;
    case 'Identifier': return node.name === 'undefined' ? 'undefined' : null;
    default: return null;
  }
}

function parseFunction(src) {
  const attempts = [`(${src})`, `({${src}})`, `(class { ${src} })`];
  for (const text of attempts) {
    try {
      const ast = acorn.parse(text, OPTS);
      let node = ast.body[0]?.expression;
      if (node?.type === 'ObjectExpression') node = node.properties[0]?.value;
      else if (node?.type === 'ClassExpression' && text.startsWith('(class {')) node = node.body.body[0]?.value;
      if (node) return { node, text };
    } catch {
      // try the next shape
    }
  }
  return null;
}

function returnsOf(fnNode) {
  if (fnNode.async && fnNode.generator) return ['AsyncGenerator', true];
  if (fnNode.generator) return ['Generator', true];
  let type = null;
  if (fnNode.expression) {
    type = literalType(fnNode.body);
  } else {
    const found = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(visit);
      if (n !== fnNode.body && /Function/.test(n.type)) return;
      if (n.type === 'ReturnStatement') found.push(n.argument ? literalType(n.argument) ?? '?' : 'undefined');
      for (const k of Object.keys(n)) if (k !== 'loc' && typeof n[k] === 'object') visit(n[k]);
    };
    visit(fnNode.body);
    const kinds = [...new Set(found.length ? found : ['undefined'])];
    type = kinds.includes('?') ? null : kinds.join(' | ');
  }
  if (fnNode.async) return [type && type !== 'undefined' ? `Promise<${type}>` : 'Promise', true];
  return [type, true];
}

/** Read `@param {type} name` and `@returns {type}` from JSDoc text. */
export function parseJSDoc(doc) {
  const params = {};
  let returns = null;
  for (const m of doc.matchAll(/@param\s+\{([^}]+)\}\s+\[?([\w$.]+)/g)) params[m[2]] = m[1];
  const r = /@returns?\s+\{([^}]+)\}/.exec(doc);
  if (r) returns = r[1];
  const summary = doc.replace(/^\/\*\*|\*\/$/g, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).filter((l) => !l.startsWith('@')).join(' ').trim();
  return { params, returns, summary };
}

/** Find the JSDoc comment written just before `function name` / `name =` in any cell source. */
export function findJSDoc(name, sources) {
  const re = new RegExp(`(/\\*\\*(?:(?!\\*/)[\\s\\S])*\\*/)\\s*(?:export\\s+)?(?:(?:async\\s+)?function\\s*\\*?\\s*${name}\\b|(?:const|let|var)\\s+${name}\\s*=|class\\s+${name}\\b)`);
  for (let i = sources.length - 1; i >= 0; i--) {
    const m = re.exec(sources[i] ?? '');
    if (m) return parseJSDoc(m[1]);
  }
  return null;
}

// ── TypeScript signatures, read from the cell that defined the function ─────────

/** Split at top-level commas, ignoring ones inside brackets, generics and strings. */
function splitTop(text, sep = ',') {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c) && !(c === '>' && text[i - 1] === '=')) depth--;
    else if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The text between the bracket at `open` and its partner, or null. */
function balanced(text, open) {
  const pairs = { '(': ')', '<': '>' };
  const close = pairs[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === close && !(close === '>' && text[i - 1] === '=')) {
      if (--depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function tsParam(text) {
  let t = text.replace(/^(public|private|protected|readonly|override)\s+/g, '').replace(/^(readonly)\s+/, '');
  const rest = t.startsWith('...');
  if (rest) t = t.slice(3);
  const [beforeDefault, def] = (() => {
    const parts = splitTop(t, '=');
    return parts.length > 1 ? [parts[0], parts.slice(1).join('=')] : [t, undefined];
  })();
  const colon = splitTop(beforeDefault, ':');
  let name = colon[0].trim();
  const optional = name.endsWith('?');
  if (optional) name = name.slice(0, -1);
  const type = colon.length > 1 ? colon.slice(1).join(':').trim() : undefined;
  return { name: (rest ? '...' : '') + name, type, optional: optional || def !== undefined ? optional : false, def: def?.trim(), inferred: false };
}

/** Find `name`'s TypeScript signature in the cells: function name<T>(…): R, const name = <T>(…): R =>, class name. */
export function findTsSignature(name, sources) {
  const esc = name.replace(/[$]/g, '\\$');
  const patterns = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${esc}\\s*(?=[<(])`),
    new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?=[<(])`),
    new RegExp(`\\bclass\\s+${esc}\\b[^{]*\\{[\\s\\S]*?\\bconstructor\\s*(?=\\()`),
  ];
  for (let s = sources.length - 1; s >= 0; s--) {
    const src = sources[s] ?? '';
    if (!/[:<]/.test(src)) continue;
    for (const re of patterns) {
      const m = re.exec(src);
      if (!m) continue;
      let at = m.index + m[0].length;
      let generics = '';
      if (src[at] === '<') {
        const g = balanced(src, at);
        if (!g) continue;
        generics = `<${g.inner.trim()}>`;
        at = g.end;
        while (src[at] === ' ') at++;
      }
      if (src[at] !== '(') continue;
      const p = balanced(src, at);
      if (!p) continue;
      const params = splitTop(p.inner).map(tsParam);
      const ret = /^\s*:\s*([^{=]+?)\s*(?:=>|\{)/.exec(src.slice(p.end));
      const typed = params.some((x) => x.type) || ret || generics;
      if (!typed) return null; // plain JavaScript: nothing to add
      return { generics, params, returns: ret ? ret[1].trim() : null };
    }
  }
  return null;
}

/**
 * Describe a function: {name, params: [{name, type, inferred, def, rest, optional}], returns, returnsInferred, native}.
 * `qualified` is the expression it was reached by (e.g. 'Math.max'), used for the built-in table.
 */
export function functionInfo(fn, qualified = fn?.name ?? '', sources = [], receiver) {
  if (typeof fn !== 'function') return null;
  const name = fn.name || qualified.split('.').pop() || 'anonymous';
  let src = '';
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    // proxies and friends
  }
  if (!src || /\{\s*\[native code\]\s*\}\s*$/.test(src)) {
    let key = qualified;
    if (!NATIVE[key] && receiver !== undefined) {
      const proto = Array.isArray(receiver) ? 'Array' : typeof receiver === 'string' ? 'String'
        : receiver instanceof Map ? 'Map' : receiver instanceof Set ? 'Set' : receiver instanceof Promise ? 'Promise' : '';
      key = `${proto}#${qualified.split('.').pop()}`;
    }
    if (!NATIVE[key]) key = qualified.split('.').pop();
    const entry = NATIVE[key];
    if (entry) return { name, params: parseNativeParams(entry[0]), returns: entry[1], returnsInferred: false, native: true };
    const params = Array.from({ length: fn.length }, (_, i) => ({ name: `arg${i}` }));
    return { name, params, returns: null, native: true, unknown: fn.length === 0 };
  }
  const parsed = parseFunction(src);
  if (!parsed) return { name, params: [], returns: null };
  let { node, text } = parsed;
  const cls = node.type === 'ClassExpression' || isClass(fn);
  if (node.type === 'ClassExpression') {
    const ctor = node.body.body.find((m) => m.kind === 'constructor');
    if (!ctor) {
      return { name, params: [], returns: name, returnsInferred: true, isClass: true };
    }
    node = ctor.value;
  }
  const doc = findJSDoc(name, sources);
  const params = (node.params ?? []).map((p) => {
    const out = {};
    let target = p;
    if (p.type === 'RestElement') {
      out.rest = true;
      target = p.argument;
    }
    if (target.type === 'AssignmentPattern') {
      out.def = text.slice(target.right.start, target.right.end);
      const t = literalType(target.right);
      if (t) {
        out.type = t;
        out.inferred = true;
      }
      target = target.left;
    }
    out.name = (out.rest ? '...' : '') + (target.type === 'Identifier' ? target.name : text.slice(target.start, target.end));
    const bare = target.type === 'Identifier' ? target.name : null;
    if (bare && doc?.params[bare]) {
      out.type = doc.params[bare];
      out.inferred = false;
    }
    return out;
  });
  let returns = null;
  let returnsInferred = true;
  if (cls) returns = name;
  else if (doc?.returns) [returns, returnsInferred] = [doc.returns, false];
  else [returns] = returnsOf(node);
  const info = { name, params, returns, returnsInferred, isClass: cls, summary: doc?.summary };
  // written in TypeScript? its declared types win
  const tsSig = findTsSignature(name, sources);
  if (tsSig && tsSig.params.length === params.length) {
    info.params = tsSig.params.map((p, i) => ({ ...params[i], ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) }));
    if (tsSig.returns && !cls) [info.returns, info.returnsInferred] = [tsSig.returns, false];
    info.generics = tsSig.generics;
  }
  return info;
}

/**
 * Find the call around the cursor: the callee expression, which argument the cursor is in, and the text
 * of that argument so far. Returns null when the cursor isn't inside a call's parentheses.
 */
export function callAt(text, cursor) {
  const before = text.slice(0, cursor);
  const toks = tokenize(before).filter((t) => t.type !== 'space' && t.type !== 'comment');
  const stack = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') stack.push({ tok: t, i, commas: [] });
    else if ((t.value === ')' || t.value === ']' || t.value === '}') && stack.length) stack.pop();
    else if (t.value === ',' && stack.length) stack[stack.length - 1].commas.push(t);
  }
  for (let s = stack.length - 1; s >= 0; s--) {
    const frame = stack[s];
    if (frame.tok.value !== '(') continue;
    // walk back over a member chain: a.b.c( or a?.b(
    let j = frame.i - 1;
    let start = null;
    while (j >= 0) {
      const t = toks[j];
      if (['name', 'builtin', 'class', 'function', 'property', 'constant'].includes(t.type)) {
        start = t.start;
        const p = toks[j - 1];
        if (p && p.type === 'punct' && (p.value === '.' || p.value === '?.')) {
          j -= 2;
          continue;
        }
        break;
      }
      if (t.type === 'punct' && t.value === ']' ) break;
      break;
    }
    if (start === null) {
      if (s === stack.length - 1) return null; // e.g. `(1 + ` — grouping parens
      continue;
    }
    const callee = before.slice(start, frame.tok.start).trim();
    if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(callee)) return null;
    const isNew = toks[j - 1]?.value === 'new';
    const lastComma = frame.commas[frame.commas.length - 1];
    const argStart = lastComma ? lastComma.end : frame.tok.end;
    return { callee, index: frame.commas.length, arg: before.slice(argStart).trim(), isNew };
  }
  return null;
}

/** Type of the argument being typed, from its literal text: `"Arthur"` → string. */
export function argType(argText) {
  if (!argText) return null;
  try {
    const node = acorn.parseExpressionAt(argText, 0, OPTS);
    if (node.end !== argText.length) return null;
    return literalType(node);
  } catch {
    return null;
  }
}

/** Signature for the call at the cursor, or null. */
export function signatureAt(text, cursor, sources = []) {
  const call = callAt(text, cursor);
  if (!call) return null;
  const { found, value } = resolveExpr(call.callee);
  if (!found || typeof value !== 'function') return null;
  let receiver;
  if (call.callee.includes('.')) {
    const owner = resolveExpr(call.callee.slice(0, call.callee.lastIndexOf('.')).replace(/\?$/, ''));
    if (owner.found) receiver = owner.value;
  }
  const info = functionInfo(value, call.callee, sources, receiver);
  if (!info) return null;
  info.index = call.index;
  const p = info.params;
  const restAt = p.findIndex((x) => x.rest);
  if (restAt !== -1 && call.index > restAt) info.index = restAt;
  const current = p[info.index];
  if (current && !current.type) {
    const t = argType(call.arg);
    if (t) {
      info.params = p.map((x, i) => (i === info.index ? { ...x, type: t, inferred: true } : x));
    }
  }
  return info;
}

/** Render as wide as fits: full → no defaults → params windowed around the cursor. */
export function renderSignature(info, width, theme) {
  const n = info.params.length;
  const current = info.index !== undefined && info.index < n ? info.index : null;
  const paint = (s, t) => theme.paint(s, t);

  const param = (p, isCurrent, showDefaults) => {
    let out = paint(isCurrent ? 'sig.param.current' : 'sig.param', p.name + (p.optional ? '?' : ''));
    if (p.type) out += paint('sig.punct', ': ') + paint(p.inferred ? 'sig.type.inferred' : 'sig.type', p.type);
    if (showDefaults && p.def !== undefined) out += paint('sig.punct', ' = ') + paint('sig.default', p.def.length > 24 ? p.def.slice(0, 23) + '…' : p.def);
    return out;
  };

  const attempt = (showDefaults, window) => {
    let out = paint('sig.icon', info.isClass ? '◇ ' : 'ƒ ') + paint('sig.name', info.name) + (info.generics ? paint('sig.type', info.generics) : '') + paint('sig.punct', '(');
    let lo = 0;
    let hi = n;
    if (window !== null) {
      const center = current ?? 0;
      lo = Math.max(0, center - window);
      hi = Math.min(n, center + window + 1);
    }
    if (window !== null && lo > 0) out += paint('sig.punct', '…, ');
    if (info.unknown) out += paint('sig.param', '…');
    for (let i = lo; i < hi; i++) {
      if (i > lo) out += paint('sig.punct', ', ');
      out += param(info.params[i], i === current, showDefaults);
    }
    if (window !== null && hi < n) out += paint('sig.punct', ', …');
    out += paint('sig.punct', ')');
    if (info.returns) out += paint('sig.punct', ' → ') + paint(info.returnsInferred ? 'sig.type.inferred' : 'sig.return', info.returns);
    return out;
  };

  let out = '';
  for (const [showDefaults, window] of [[true, null], [false, null], [false, 2], [false, 1], [false, 0]]) {
    out = attempt(showDefaults, window);
    if (textWidth(out) <= width) return out;
  }
  return out;
}
