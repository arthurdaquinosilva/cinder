// A small, forgiving JavaScript lexer for highlighting half-typed code. It never throws:
// unterminated strings, templates and comments simply run to the end of the input.

export const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'as',
]);

// TypeScript: reserved words that are always keywords, words that are keywords before a name
// (`type User =`, `x is string`), and the primitive types (after `:`, `|`, `&`, `as`, `<`).
const TS_KEYWORDS = new Set(['interface', 'enum', 'implements', 'private', 'public', 'protected']);
const TS_CONTEXTUAL = new Set(['type', 'namespace', 'declare', 'abstract', 'readonly', 'keyof', 'satisfies', 'infer', 'is', 'asserts', 'override', 'unique', 'module']);
const TS_TYPES = new Set(['number', 'string', 'boolean', 'any', 'unknown', 'never', 'object', 'bigint', 'symbol', 'undefined', 'null', 'void']);
const TYPE_CONTEXT = new Set([':', '|', '&', '<', ',', 'as', 'satisfies', 'keyof', 'extends', '=>', '[']);

export const CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);

export const BUILTINS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'Reflect', 'Proxy', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Atomics', 'globalThis', 'require', 'module', 'exports',
  'process', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'performance', 'crypto', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Iterator',
]);

// Tokens after which `/` starts a regular expression rather than a division.
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

const PUNCT_RE = /(?:>>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\*\*|<<|>>|[{}()[\];,<>+\-*/%&|^!~?:=.@#])/y;
const NUMBER_RE = /(?:0[xX][\da-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/y;
const CALL_RE = /\s*\(/y;
const MAGIC_RE = /%%?[\w-]*/y;
const IDENT_RE = /[\p{ID_Start}$_\\][\p{ID_Continue}$‌‍\\]*/uy;

/**
 * Split `src` into tokens `{type, value, start, end}`. Types: comment, string, template, number, regex,
 * keyword, constant, builtin, class, function, property, name, punct, space, magic, other.
 */
export function tokenize(src) {
  const tokens = [];
  const braceStack = []; // for template `${ … }`: 'tpl' marks a brace that resumes a template
  let i = 0;
  let prev = null; // last significant token

  const push = (type, start, end) => {
    const tok = { type, value: src.slice(start, end), start, end };
    tokens.push(tok);
    if (type !== 'space' && type !== 'comment') prev = tok;
    return tok;
  };

  const regexAllowed = () => {
    if (!prev) return true;
    if (prev.type === 'keyword') return REGEX_AFTER_KEYWORD.has(prev.value);
    if (prev.type === 'punct') return ![')', ']', '}', '++', '--'].includes(prev.value);
    return false;
  };

  // Scan template text from `start` (at the opening ` or the } ending a substitution) to the closing ` or `${`.
  const scanTemplate = (start) => {
    let j = start + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { push('template', start, j + 1); return j + 1; }
      if (c === '$' && src[j + 1] === '{') {
        push('template', start, j + 2);
        braceStack.push('tpl');
        return j + 2;
      }
      j++;
    }
    push('template', start, src.length);
    return src.length;
  };

  // `%magic` and `!shell` lines are highlighted as commands, not JS.
  const lineStart = (pos) => pos === 0 || src[pos - 1] === '\n';

  while (i < src.length) {
    const c = src[i];
    const at = (re) => {
      re.lastIndex = i;
      return re.exec(src);
    };
    const callFollows = (pos) => {
      CALL_RE.lastIndex = pos;
      return CALL_RE.test(src);
    };

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1;
      while (j < src.length && /[ \t\n\r]/.test(src[j])) j++;
      push('space', i, j);
      i = j;
      continue;
    }
    if (c === '%' && lineStart(i)) {
      const m = at(MAGIC_RE);
      push('magic', i, i + m[0].length);
      const eol = src.indexOf('\n', i);
      const end = eol === -1 ? src.length : eol;
      if (end > i + m[0].length) push('other', i + m[0].length, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const eol = src.indexOf('\n', i);
      const end = eol === -1 ? src.length : eol;
      push('comment', i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      push('comment', i, end);
      i = end;
      continue;
    }
    if (c === '#' && src[i + 1] === '!' && i === 0) {
      const eol = src.indexOf('\n');
      const end = eol === -1 ? src.length : eol;
      push('comment', 0, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const end = Math.min(src[j] === c ? j + 1 : j, src.length);
      push('string', i, end);
      i = end;
      continue;
    }
    if (c === '`') {
      i = scanTemplate(i);
      continue;
    }
    if (c === '}' && braceStack.length && braceStack[braceStack.length - 1] === 'tpl') {
      braceStack.pop();
      i = scanTemplate(i);
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      if (src[j] === '/') {
        j++;
        while (j < src.length && /[a-z]/.test(src[j])) j++;
        push('regex', i, j);
        i = j;
        continue;
      }
      // not a regex after all: fall through to punctuation
    }
    let m;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      m = at(NUMBER_RE);
      if (m) {
        push('number', i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    if ((m = at(IDENT_RE))) {
      const word = m[0];
      const end = i + word.length;
      const afterDot = prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.');
      let type;
      const nameFollows = () => {
        IDENT_RE.lastIndex = end;
        let k = end;
        while (src[k] === ' ') k++;
        IDENT_RE.lastIndex = k;
        return k > end && IDENT_RE.test(src);
      };
      if (afterDot) type = callFollows(end) ? 'function' : 'property';
      else if (TS_TYPES.has(word) && prev && TYPE_CONTEXT.has(prev.value) && !['undefined', 'null', 'void'].includes(word)) type = 'class';
      else if (CONSTANTS.has(word)) type = 'constant';
      else if (KEYWORDS.has(word) || TS_KEYWORDS.has(word)) type = 'keyword';
      else if (TS_CONTEXTUAL.has(word) && nameFollows()) type = 'keyword';
      else if (callFollows(end) && !BUILTINS.has(word)) type = /^[A-Z]/.test(word) ? 'class' : 'function';
      else if (BUILTINS.has(word)) type = 'builtin';
      else if (/^[A-Z][a-z]/.test(word) || (prev && prev.value === 'new') || (prev && prev.value === 'class') || (prev && prev.value === 'extends')) type = 'class';
      else if (prev && prev.value === 'function') type = 'function';
      else type = 'name';
      push(type, i, end);
      i = end;
      continue;
    }
    if ((m = at(PUNCT_RE))) {
      const v = m[0];
      if (v === '{') braceStack.push('{');
      else if (v === '}') braceStack.pop();
      push('punct', i, i + v.length);
      i += v.length;
      continue;
    }
    const ch = String.fromCodePoint(src.codePointAt(i));
    push('other', i, i + ch.length);
    i += ch.length;
  }
  return tokens;
}

/** True when `pos` is inside a string, template text, comment or regex. */
export function inLiteral(src, pos) {
  for (const t of tokenize(src)) {
    if (t.start >= pos) break;
    if (['string', 'template', 'comment', 'regex'].includes(t.type) && pos > t.start && pos < t.end) return t;
    if (pos === t.end && t.end === src.length && ['string', 'template', 'comment'].includes(t.type)) {
      const v = t.value;
      const closed = (t.type === 'string' && v.length > 1 && v[v.length - 1] === v[0])
        || (t.type === 'template' && v.length > 1 && (v.endsWith('`') || v.endsWith('${')))
        || (t.type === 'comment' && (v.startsWith('//') ? false : v.endsWith('*/') && v.length > 3));
      if (!closed) return t;
    }
  }
  return null;
}

const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/** Positions of the bracket at/before the cursor and its partner, or null. */
export function matchBracket(src, cursor) {
  const toks = tokenize(src).filter((t) => t.type === 'punct' && (PAIRS[t.value] || CLOSERS[t.value]));
  const at = toks.find((t) => t.start === cursor) ?? toks.find((t) => t.end === cursor);
  if (!at) return null;
  if (PAIRS[at.value]) {
    let depth = 0;
    for (const t of toks.filter((t) => t.start >= at.start)) {
      if (PAIRS[t.value]) depth++;
      else if (--depth === 0) return t.value === PAIRS[at.value] ? [at.start, t.start] : null;
    }
  } else {
    let depth = 0;
    for (const t of toks.filter((t) => t.start <= at.start).reverse()) {
      if (CLOSERS[t.value]) depth++;
      else if (--depth === 0) return PAIRS[t.value] === at.value ? [t.start, at.start] : null;
    }
  }
  return null;
}
