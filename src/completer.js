// Completion from live objects: globals, properties of `a.b.`, module names in require()/import, file
// paths in strings and magic arguments, and magic names.

import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { BUILTINS, CONSTANTS, KEYWORDS, inLiteral, tokenize } from './lexer.js';
import { describe, isClass, kindOf, listProperties, resolveExpr } from './introspect.js';
import { CELL_MAGICS, LINE_MAGICS } from './magics/index.js';

export const ICONS = {
  function: 'ƒ', class: '◇', module: '▣', keyword: '⌘', value: '●', property: '◦', path: '⌁', magic: '✦',
};

const PATH_MAGICS = new Set(['run', 'cd', 'load', 'edit', 'ed', 'save', 'writefile', 'file', 'bookmark', 'ls', 'll', 'la', 'cat', 'rm', 'cp', 'mv', 'mkdir', 'rmdir']);
// String.prototype's old HTML helpers (`"x".bold()` → "<b>x</b>") — deprecated, and noise in the menu.
const HTML_STRING_METHODS = new Set(['anchor', 'big', 'blink', 'bold', 'fixed', 'fontcolor', 'fontsize', 'italics', 'link', 'small', 'strike', 'sub', 'sup']);
const JS_KEYWORDS = [...KEYWORDS, ...CONSTANTS].filter((k) => !['get', 'set', 'as', 'of', 'from', 'static'].includes(k));

function item(text, kind, meta = '', display = text) {
  return { text, kind, meta, display };
}

/** Short type text for the menu without running getters. */
function metaFor(owner, name) {
  let d;
  try {
    d = Object.getOwnPropertyDescriptor(owner, name);
  } catch {
    return ['value', ''];
  }
  if (!d) return ['value', ''];
  if (!('value' in d)) return ['property', d.get ? 'getter' : 'setter'];
  const v = d.value;
  const kind = kindOf(v);
  let meta = '';
  if (typeof v === 'function') meta = isClass(v) ? 'class' : 'function';
  else {
    meta = describe(v);
    if (meta.length > 24) meta = meta.slice(0, 23) + '…';
  }
  return [kind, meta];
}

function rank(items, prefix) {
  const exact = items.filter((c) => c.text.startsWith(prefix));
  const pool = exact.length ? exact : items.filter((c) => c.text.toLowerCase().startsWith(prefix.toLowerCase()));
  const seen = new Set();
  return pool.filter((c) => !seen.has(c.text) && seen.add(c.text));
}

function pathItems(fragment, { quoted = false, onlyDirs = false } = {}) {
  const expanded = fragment.replace(/^~(?=$|\/)/, os.homedir());
  const dirPart = expanded.endsWith('/') ? expanded : path.dirname(expanded);
  const base = expanded.endsWith('/') ? '' : path.basename(expanded);
  const dir = path.resolve(dirPart || '.');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const shownDir = fragment.endsWith('/') ? fragment : fragment.includes('/') ? fragment.slice(0, fragment.lastIndexOf('/') + 1) : '';
  return entries
    .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
    .filter((e) => !onlyDirs || e.isDirectory())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((e) => {
      const name = shownDir + e.name + (e.isDirectory() ? '/' : '');
      const text = !quoted && /\s/.test(name) ? name.replace(/(\s)/g, '\\$1') : name;
      return item(text, 'path', e.isDirectory() ? 'dir' : '', e.name + (e.isDirectory() ? '/' : ''));
    });
}

function packageNames() {
  const names = new Set();
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    const nm = path.join(dir, 'node_modules');
    try {
      for (const e of fs.readdirSync(nm)) {
        if (e.startsWith('.')) continue;
        if (e.startsWith('@')) {
          try {
            for (const sub of fs.readdirSync(path.join(nm, e))) names.add(`${e}/${sub}`);
          } catch {
            // unreadable scope
          }
        } else names.add(e);
      }
    } catch {
      // no node_modules here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...names].sort();
}

function moduleItems(fragment) {
  if (fragment.startsWith('.') || fragment.startsWith('/') || fragment.startsWith('~')) return pathItems(fragment, { quoted: true });
  const builtins = builtinModules.filter((m) => !m.startsWith('_')).map((m) => item(`node:${m}`, 'module', 'built-in'));
  const pkgs = packageNames().map((m) => item(m, 'module', 'package'));
  const plain = builtinModules.filter((m) => !m.startsWith('_')).map((m) => item(m, 'module', 'built-in'));
  return rank([...pkgs, ...builtins, ...plain], fragment);
}

// `\alpha` Tab → α. Greek letters are valid in JavaScript names; the rest is handy in strings.
const GREEK = 'alpha α beta β gamma γ delta δ epsilon ε zeta ζ eta η theta θ iota ι kappa κ lambda λ mu μ nu ν xi ξ '
  + 'omicron ο pi π rho ρ sigma σ tau τ upsilon υ phi φ chi χ psi ψ omega ω Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ '
  + 'Pi Π Sigma Σ Phi Φ Psi Ψ Omega Ω';
const SYMBOLS = 'infty ∞ sum ∑ prod ∏ int ∫ partial ∂ nabla ∇ sqrt √ pm ± mp ∓ times × div ÷ cdot · le ≤ ge ≥ ne ≠ '
  + 'approx ≈ equiv ≡ in ∈ notin ∉ subset ⊂ supset ⊃ cup ∪ cap ∩ emptyset ∅ forall ∀ exists ∃ neg ¬ wedge ∧ vee ∨ '
  + 'to → rightarrow → leftarrow ← Rightarrow ⇒ leftrightarrow ↔ uparrow ↑ downarrow ↓ degree ° ell ℓ hbar ℏ '
  + 'check ✓ cross ✗ bullet • dots … euro € pounds £ yen ¥ copyright © deg °';
export const UNICODE = Object.fromEntries(
  [GREEK, SYMBOLS].flatMap((list) => {
    const words = list.split(' ');
    const pairs = [];
    for (let i = 0; i + 1 < words.length; i += 2) pairs.push([words[i], words[i + 1]]);
    return pairs;
  }),
);

/** Completions for the text around the cursor. Returns {start, items} or null. */
export function complete(text, cursor, shell) {
  const before = text.slice(0, cursor);
  const uni = /\\([A-Za-z]{2,})$/.exec(before); // two letters, so string escapes like "\n" stay quiet
  if (uni) {
    const items = Object.entries(UNICODE)
      .filter(([name]) => name.startsWith(uni[1]))
      .map(([name, ch]) => item(ch, 'keyword', `\\${name}`, `${ch}  \\${name}`));
    if (items.length) return { start: cursor - uni[0].length, items };
  }
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);

  // magics: %name, %%name
  let m = /^(\s*)(%%?)([\w-]*)$/.exec(line);
  if (m && (m[2] === '%' || lineStart === 0)) {
    const table = m[2] === '%%' ? CELL_MAGICS : { ...LINE_MAGICS, ...Object.fromEntries(Object.keys(shell?.aliases ?? {}).map((a) => [a, { doc: `alias: ${shell.aliases[a]}` }])) };
    const items = Object.entries(table).map(([name, spec]) => item(name, 'magic', (spec.doc ?? '').split(/(?<=\.)\s/)[0].slice(0, 40)));
    return { start: cursor - m[3].length, items: rank(items, m[3]) };
  }
  // paths after %run, %cd … and in !shell commands
  m = /^\s*%%?([\w-]+)\s+(?:-\w+\s+)*(.*)$/.exec(line);
  if (m && PATH_MAGICS.has(m[1])) {
    const frag = /(?:[^\s\\]|\\.)*$/.exec(m[2])[0];
    return { start: cursor - frag.length, items: pathItems(frag.replace(/\\(.)/g, '$1'), { onlyDirs: m[1] === 'cd' }) };
  }
  if (/^\s*!/.test(line) && /\s/.test(line.trim())) {
    const frag = /(?:[^\s\\]|\\.)*$/.exec(line)[0];
    return { start: cursor - frag.length, items: pathItems(frag.replace(/\\(.)/g, '$1')) };
  }

  // inside a string: module names for require()/import, else paths when it looks like one
  const lit = inLiteral(text, cursor);
  if (lit) {
    if (lit.type !== 'string' && lit.type !== 'template') return null;
    const content = text.slice(lit.start + 1, cursor);
    const head = text.slice(0, lit.start);
    if (/(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|^\s*import\s+)$/.test(head)) {
      return { start: cursor - content.length, items: moduleItems(content) };
    }
    const keyOf = /([\w$.]+)\s*\[\s*$/.exec(head);
    if (keyOf) {
      const { found, value } = resolveExpr(keyOf[1]);
      if (found && value && typeof value === 'object') {
        const keys = value instanceof Map ? [...value.keys()].filter((k) => typeof k === 'string') : Object.keys(value);
        return { start: cursor - content.length, items: rank(keys.map((k) => item(k, 'property', 'key')), content) };
      }
    }
    if (/^(\.{1,2}\/|\/|~\/)/.test(content)) return { start: cursor - content.length, items: pathItems(content, { quoted: true }) };
    return null;
  }

  // member access: expr.prefix
  const toks = tokenize(before).filter((t) => t.type !== 'space' && t.type !== 'comment');
  const last = toks[toks.length - 1];
  let prefix = '';
  let idx = toks.length - 1;
  if (last && ['name', 'builtin', 'class', 'function', 'property', 'constant', 'keyword'].includes(last.type) && last.end === cursor) {
    prefix = last.value;
    idx--;
  } else if (last && last.end !== cursor && !(last.type === 'punct' && (last.value === '.' || last.value === '?.'))) {
    // cursor after whitespace or an operator: offer names only after an operator, never mid-air
    if (!(last.type === 'punct' && last.value !== ')' && last.value !== ']')) return null;
  }
  const dot = toks[idx];
  if (dot && dot.type === 'punct' && (dot.value === '.' || dot.value === '?.') && dot.end === (prefix ? cursor - prefix.length : cursor)) {
    const obj = receiverOf(toks, idx, before);
    if (!obj.found) return null;
    const props = listProperties(obj.value)
      .filter((p) => !/^\d+$/.test(p.name))
      .map((p) => {
        const [kind, meta] = metaFor(p.owner, p.name);
        return { ...item(p.name, kind, meta), depth: p.depth, own: p.depth === 0 };
      })
      .filter((p) => !/^[^\p{L}_$]|[^\p{L}\p{N}_$]/u.test(p.text)); // only names you can type after a dot
    const ranked = rank(props.filter((p) => !(typeof obj.value === 'string' && HTML_STRING_METHODS.has(p.text))), prefix);
    ranked.sort((a, b) => (a.text.startsWith('_') - b.text.startsWith('_')) || (a.depth - b.depth) || a.text.localeCompare(b.text));
    return { start: cursor - prefix.length, items: ranked };
  }

  if (!prefix) return null;
  // a plain name: your variables, then globals, keywords
  const userNames = new Set(Object.keys(shell?.userVars?.() ?? {}));
  const globals = Object.getOwnPropertyNames(globalThis)
    .filter((n) => !/^_i?\d+$/.test(n) && n !== '__cinder__')
    .map((n) => {
      const [kind, meta] = metaFor(globalThis, n);
      return { ...item(n, kind, meta), user: userNames.has(n) };
    });
  const keywords = JS_KEYWORDS.map((k) => item(k, 'keyword', 'keyword'));
  let items = rank([...globals, ...keywords], prefix);
  items.sort((a, b) => (b.user ?? false) - (a.user ?? false) || (BUILTINS.has(b.text) - BUILTINS.has(a.text)) || a.text.length - b.text.length || a.text.localeCompare(b.text));
  if (items.length === 1 && items[0].text === prefix) items = [];
  return { start: cursor - prefix.length, items };
}

/** The value left of a `.` token: a resolvable member chain, or a literal's prototype. */
function receiverOf(toks, dotIdx, before) {
  const prev = toks[dotIdx - 1];
  if (!prev) return { found: false };
  if (prev.type === 'string' || prev.type === 'template') return { found: true, value: '' };
  if (prev.type === 'regex') return { found: true, value: /x/ };
  if (prev.type === 'number') return /\./.test(prev.value) || /^\d+$/.test(prev.value) ? { found: false } : { found: true, value: 0 };
  if (prev.type === 'punct' && prev.value === ']') {
    // an array literal `[1, 2].`, or an index `a[0].`
    let depth = 0;
    let j = dotIdx - 1;
    for (; j >= 0; j--) {
      if (toks[j].value === ']') depth++;
      else if (toks[j].value === '[' && --depth === 0) break;
    }
    const opener = toks[j - 1];
    if (!opener || (opener.type === 'punct' && ![')', ']'].includes(opener.value))) return { found: true, value: [] };
  }
  if (prev.type === 'punct' && prev.value === '}') {
    return { found: false };
  }
  // walk back over a member chain
  let j = dotIdx - 1;
  let start = null;
  while (j >= 0) {
    const t = toks[j];
    if (['name', 'builtin', 'class', 'function', 'property', 'constant', 'keyword'].includes(t.type)) {
      start = t.start;
      const p = toks[j - 1];
      if (p && p.type === 'punct' && (p.value === '.' || p.value === '?.')) {
        j -= 2;
        continue;
      }
      break;
    }
    if (t.type === 'punct' && t.value === ']' && toks[j - 1] && (toks[j - 1].type === 'string' || toks[j - 1].type === 'number') && toks[j - 2]?.value === '[') {
      j -= 3;
      continue;
    }
    break;
  }
  if (start === null) return { found: false };
  return resolveExpr(before.slice(start, toks[dotIdx].start));
}

/** Longest prefix shared by every completion. */
export function commonPrefix(items) {
  if (!items.length) return '';
  let p = items[0].text;
  for (const it of items) {
    while (!it.text.startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}
