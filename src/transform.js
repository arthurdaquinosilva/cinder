// Source transforms: `%magic`, `%%cell magic`, `!shell`, `obj?`, pasted prompts, and the JS rewrite
// that makes top-level declarations persistent (and re-declarable) between cells.

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { inLiteral, tokenize } from './lexer.js';
import { compile as compileTypeScript, typeScriptMode } from './typescript.js';

export const API = '__cinder__';

// ── pasted prompts ──────────────────────────────────────────────────────────

const NODE_START = /^>( |$)/;
const NODE_LINE = /^(>|\.\.\.+)( |$)/;

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

/** Remove `> ` / `... ` prompts from code copied out of a Node REPL session, dropping output lines. */
export function stripPrompts(text) {
  const lines = dedent(text.replace(/\r\n?/g, '\n').split('\n'));
  const first = lines.find((l) => l.trim()) ?? '';
  if (!NODE_START.test(first)) return text;
  const kept = [];
  for (const line of lines) {
    const m = NODE_LINE.exec(line);
    if (m) kept.push(line.slice(m[0].length));
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

export function hasPrompts(text) {
  const first = dedent(text.split('\n')).find((l) => l.trim()) ?? '';
  return NODE_START.test(first);
}

// ── parsing ─────────────────────────────────────────────────────────────────

const BASE = { ecmaVersion: 'latest', allowHashBang: true, allowAwaitOutsideFunction: true, locations: true };

/** Parse as a script; fall back to module syntax (import/export) when needed. */
export function parse(src) {
  try {
    return acorn.parse(src, { ...BASE, sourceType: 'script' });
  } catch (scriptError) {
    if (/\b(import|export)\b/.test(src)) {
      try {
        return acorn.parse(src, { ...BASE, sourceType: 'module', allowImportExportEverywhere: true });
      } catch {
        // report the script error, it's the more natural one
      }
    }
    throw scriptError;
  }
}

function parsesAsExpression(src) {
  try {
    acorn.parseExpressionAt(src, 0, { ...BASE, sourceType: 'script' });
    const program = acorn.parse(`(${src}\n)`, { ...BASE, sourceType: 'script' });
    return program.body.length === 1 && program.body[0].type === 'ExpressionStatement';
  } catch {
    return false;
  }
}

/** `{a: 1}` typed alone means an object, not a block (like Node's REPL). */
export function wrapObjectLiteral(src) {
  const t = src.trim();
  if (t.startsWith('{') && /\}\s*;?$/.test(t)) {
    const inner = t.replace(/;\s*$/, '');
    if (parsesAsExpression(inner)) return `(${inner})`;
  }
  return src;
}

// ── cell classification ─────────────────────────────────────────────────────

const CELL_MAGIC_RE = /^%%([A-Za-z_][\w-]*)([^\n]*)(?:\n([\s\S]*))?$/;
const LINE_MAGIC_RE = /^([ \t]*)%([A-Za-z_][\w-]*)(.*)$/;
const INSPECT_RE = /^\s*(?:(\?\??)\s*(\S.*?)|(\S.*?)\s*(\?\??))\s*$/;
const WILDCARD_RE = /^\s*\??([\w$.]*\*[\w$.*]*)\?\s*$/;

/**
 * What kind of cell is this?
 *   {kind: 'cellmagic', name, args, body} · {kind: 'magic', name, args} · {kind: 'shell', cmd}
 *   {kind: 'inspect', expr, level} · {kind: 'psearch', pattern} · {kind: 'js', source}
 * `isDefined(name)` decides whether `!name …` means negation (name exists) or a shell command.
 */
export function classify(source, isDefined = () => false) {
  const src = source.replace(/^\n+/, '').trimEnd();
  let m;
  if ((m = CELL_MAGIC_RE.exec(src))) return { kind: 'cellmagic', name: m[1], args: m[2].trim(), body: m[3] ?? '' };
  if (!src.includes('\n')) {
    if ((m = LINE_MAGIC_RE.exec(src))) return { kind: 'magic', name: m[2], args: m[3].trim() };
    if (isShell(src, isDefined)) return { kind: 'shell', cmd: src.trim().slice(1).trim() };
    if ((m = WILDCARD_RE.exec(src))) return { kind: 'psearch', pattern: m[1] };
    if ((m = INSPECT_RE.exec(src)) && !isValid(src)) {
      const expr = (m[2] ?? m[3]).trim();
      const level = (m[1] ?? m[4]).length;
      if (expr && parsesAsExpression(expr)) return { kind: 'inspect', expr, level };
    }
  }
  return { kind: 'js', source: src };
}

function isValid(src) {
  try {
    parse(src);
    return true;
  } catch {
    return false;
  }
}

/** `!cmd`: a shell command unless it reads as JavaScript negation of something that exists. */
export function isShell(line, isDefined = () => false) {
  const t = line.trim();
  if (!t.startsWith('!') || t.startsWith('!=') || t.length < 2) return false;
  const rest = t.slice(1).replace(/^!/, '');
  if (!/^[\w./~$-]/.test(rest)) return false;
  if (!isValid(t)) return true;
  const first = /^[A-Za-z_$][\w$]*/.exec(rest);
  return !first || !isDefined(first[0]);
}

// ── completeness (smart Enter) ──────────────────────────────────────────────

/** Replace `%magic` lines inside JS with calls into the shell (same line, so positions hold). */
export function transformMagicLines(src) {
  if (!/^[ \t]*%/m.test(src)) return src;
  const lines = src.split('\n');
  let offset = 0;
  const out = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    const m = LINE_MAGIC_RE.exec(line);
    if (!m || inLiteral(src, start + m[1].length)) return line;
    return `${m[1]}await ${API}.magic(${JSON.stringify(m[2])}, ${JSON.stringify(m[3].trim())});`;
  });
  return out.join('\n');
}

/** Is the cell ready to run? False while a block, bracket, template or comment is still open. */
export function isComplete(source) {
  const src = source.trimEnd();
  if (!src.trim()) return true;
  const t = src.trimStart();
  if (t.startsWith('%%')) return /\n[ \t]*$/.test(source) && source.includes('\n');
  const lines = src.split('\n');
  const last = lines[lines.length - 1];
  if (last.endsWith('\\') && !inLiteral(src, src.length)) return false;
  if (!src.includes('\n')) {
    if (LINE_MAGIC_RE.test(src)) return true;
    if (src.trim().startsWith('!') && isShell(src)) return true;
    if (INSPECT_RE.test(src) && classify(src).kind !== 'js') return true;
  }
  const code = wrapObjectLiteral(transformMagicLines(src));
  try {
    parse(code);
    return true;
  } catch (e) {
    const msg = String(e.message);
    if (/Unterminated (template|comment)/.test(msg)) return false;
    // strings and regexes can't span lines, so those are errors; otherwise only an unexpected end of input
    // means "keep typing" — any other error should run and be shown
    const jsIncomplete = !/Unterminated/.test(msg) && (e.pos ?? 0) >= code.trimEnd().length;
    if (typeScriptMode() !== 'off') {
      // TypeScript: `interface User {` fails early for JavaScript but is simply unfinished
      try {
        compileTypeScript(code);
        return true;
      } catch (te) {
        if (te.incomplete || /\beof\b|<eof>/i.test(te.message) || (!jsIncomplete && looksUnfinished(code))) return false;
      }
    }
    return !jsIncomplete;
  }
}

/** Unclosed brackets, or a line ending in an operator that needs more: `{`, `(`, `=`, `,`, `=>`, `|`… */
function looksUnfinished(code) {
  const toks = tokenize(code).filter((t) => t.type !== 'space' && t.type !== 'comment');
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const t of toks) {
    if (t.type !== 'punct') continue;
    if ('([{'.includes(t.value)) stack.push(t.value);
    else if (pairs[t.value]) {
      if (stack.pop() !== pairs[t.value]) return false; // mismatched: a real error
    }
  }
  if (stack.length) return true;
  const last = toks.at(-1);
  return !!last && last.type === 'punct' && ['=', ',', ':', '=>', '|', '&', '?', '.', '+', '-', '*', '/', '&&', '||', '??'].includes(last.value);
}

const INDENT = '  ';

/** Indentation for the line after `line`: keep it, and add a level after an opening bracket. */
export function nextIndent(line) {
  const indent = /^[ \t]*/.exec(line)[0];
  const code = line.replace(/\/\/.*$/, '').trimEnd();
  if (/[{([]$/.test(code) || /=>$/.test(code)) return indent + INDENT;
  if (/^\s*(case\b.*|default\s*):$/.test(code)) return indent + INDENT;
  return indent;
}

export { INDENT };

// ── the JS rewrite ──────────────────────────────────────────────────────────

function boundNames(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern': for (const p of pattern.properties) boundNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const el of pattern.elements) boundNames(el, out); break;
    case 'RestElement': boundNames(pattern.argument, out); break;
    case 'AssignmentPattern': boundNames(pattern.left, out); break;
  }
  return out;
}

/** Does `await` (or `for await`) appear outside any function? */
export function hasTopLevelAwait(ast) {
  let found = false;
  const skip = () => {};
  walk.recursive(ast, null, {
    AwaitExpression() { found = true; },
    ForOfStatement(node, st, c) {
      if (node.await) found = true;
      c(node.left, st); c(node.right, st); c(node.body, st);
    },
    FunctionDeclaration: skip,
    FunctionExpression: skip,
    ArrowFunctionExpression: skip,
    MethodDefinition(node, st, c) { if (node.computed) c(node.key, st); },
    PropertyDefinition(node, st, c) { if (node.computed) c(node.key, st); },
    StaticBlock: skip,
  });
  return found;
}

function importReplacement(node) {
  const spec = JSON.stringify(node.source.value);
  const load = `await import(${spec})`;
  const names = [];
  const props = [];
  let namespace = null;
  for (const s of node.specifiers) {
    names.push(s.local.name);
    if (s.type === 'ImportNamespaceSpecifier') namespace = s.local.name;
    else if (s.type === 'ImportDefaultSpecifier') props.push(`default: ${s.local.name}`);
    else {
      const imported = s.imported.type === 'Literal' ? JSON.stringify(s.imported.value) : s.imported.name;
      props.push(imported === s.local.name ? imported : `${imported}: ${s.local.name}`);
    }
  }
  let code;
  if (!node.specifiers.length) code = `${load};`;
  else if (namespace && props.length) code = `${namespace} = ${load}; void ({${props.join(', ')}} = ${namespace});`;
  else if (namespace) code = `${namespace} = ${load};`;
  else code = `void ({${props.join(', ')}} = ${load});`;
  return { code, names };
}

/**
 * Rewrite a JS cell for execution in the main context.
 *
 * Sync cells stay a script: top-level `let`/`const` become `var` and classes become `var X = class X`, so
 * they persist as globals and can be declared again. Cells with top-level `await` or `import` run inside
 * an async function; their declarations are hoisted to globals and turned into assignments, and the last
 * expression is returned. Line numbers never change; `col1` is how far line 1 moved right.
 *
 * With `meta`, `import.meta` reads `__cinder__.meta` (files run with %run).
 *
 * Returns {code, async, shows, names, col1}. Throws acorn's SyntaxError for invalid code.
 */
export function rewrite(source, { meta = null, interactivity = 'last_expr' } = {}) {
  const src = wrapObjectLiteral(source);
  const ast = parse(src);
  const body = ast.body;
  const isAsync = hasTopLevelAwait(ast) || body.some((n) => n.type === 'ImportDeclaration');
  // Trailing `var x;` (no value) doesn't hide the expression before it — TypeScript's transform puts the
  // declarations for enums and namespaces there.
  let lastIndex = body.length - 1;
  while (lastIndex > 0 && body[lastIndex].type === 'VariableDeclaration' && body[lastIndex].kind === 'var' && body[lastIndex].declarations.every((d) => !d.init)) lastIndex--;
  const last = body[lastIndex];
  // a lone "string" is a directive to acorn, a value to us
  let shows = interactivity !== 'none' && !!last && last.type === 'ExpressionStatement';
  // last_expr_or_assign: `const total = …` at the end shows total
  let showName = null;
  if (interactivity === 'last_expr_or_assign' && last?.type === 'VariableDeclaration' && last.declarations.length === 1 && last.declarations[0].id.type === 'Identifier') {
    showName = last.declarations[0].id.name;
    shows = true;
  }
  const edits = []; // [start, end, text]
  const names = new Set();
  const functionNames = [];

  const keepLines = (start, end) => '\n'.repeat((src.slice(start, end).match(/\n/g) ?? []).length);

  const declare = (node, exported) => {
    const start = exported ? exported.start : node.start;
    if (node.type === 'VariableDeclaration') {
      const declared = node.declarations.flatMap((d) => boundNames(d.id));
      declared.forEach((n) => names.add(n));
      if (!isAsync) {
        edits.push([start, node.declarations[0].start, 'var ']);
        return;
      }
      edits.push([start, node.declarations[0].start, 'void (']);
      for (const d of node.declarations) {
        if (!d.init && d.id.type === 'Identifier') {
          edits.push([d.id.end, d.id.end, node.kind === 'var' ? ` = ${d.id.name}` : ' = undefined']);
        }
      }
      const lastDecl = node.declarations[node.declarations.length - 1];
      edits.push([lastDecl.end, lastDecl.end, ')']);
    } else if (node.type === 'ClassDeclaration') {
      names.add(node.id.name);
      edits.push([start, node.start, isAsync ? `${node.id.name} = ` : `var ${node.id.name} = `]);
      edits.push([node.end, node.end, ';']);
    } else if (node.type === 'FunctionDeclaration') {
      names.add(node.id.name);
      functionNames.push(node.id.name);
      if (exported) edits.push([start, node.start, '']);
    }
  };

  for (const node of body) {
    switch (node.type) {
      case 'VariableDeclaration':
      case 'ClassDeclaration':
      case 'FunctionDeclaration':
        declare(node, null);
        break;
      case 'ImportDeclaration': {
        const { code, names: imported } = importReplacement(node);
        imported.forEach((n) => names.add(n));
        edits.push([node.start, node.end, code + keepLines(node.start, node.end)]);
        break;
      }
      case 'ExportNamedDeclaration':
        if (node.declaration) declare(node.declaration, node);
        else edits.push([node.start, node.end, keepLines(node.start, node.end)]);
        break;
      case 'ExportDefaultDeclaration':
        if (node.declaration.type.endsWith('Declaration') && node.declaration.id) declare(node.declaration, node);
        else edits.push([node.start, node.declaration.start, '']);
        break;
      case 'ExportAllDeclaration':
        edits.push([node.start, node.end, keepLines(node.start, node.end)]);
        break;
    }
  }

  if (meta) {
    walk.simple(ast, {
      MetaProperty(node) {
        if (node.meta.name === 'import') edits.push([node.start, node.end, `${API}.meta`]);
      },
    });
  }

  // interactivity 'all': every top-level expression is shown, not only the last
  if (interactivity === 'all') {
    for (const node of body.slice(0, lastIndex)) {
      if (node.type !== 'ExpressionStatement') continue;
      edits.push([node.expression.start, node.expression.start, `${API}.show(`]);
      edits.push([node.expression.end, node.expression.end, ')']);
    }
  }

  if (isAsync && shows && !showName) {
    const expr = last.expression;
    edits.push([expr.start, expr.start, 'return (']);
    edits.push([expr.end, expr.end, ')']);
  }

  // Apply from the end backwards; edits at the same spot go in reverse order so they read in push order.
  let code = src;
  const ordered = edits.map((e, i) => [...e, i]).sort((a, b) => b[0] - a[0] || b[3] - a[3]);
  for (const [start, end, text] of ordered) code = code.slice(0, start) + text + code.slice(end);

  let col1 = 0;
  if (isAsync) {
    const hoisted = names.size ? `var ${[...names].join(', ')}; ` : '';
    const exportFns = functionNames.map((n) => `globalThis.${n} = ${n}; `).join('');
    const prefix = `${hoisted}(async () => { ${exportFns}`;
    col1 = prefix.length;
    code = `${prefix}${code}\n${showName ? `return ${showName}\n` : ''}})()`;
  } else if (showName) {
    code += `\n;${showName}`;
  }
  return { code, async: isAsync, shows, names: [...names], col1 };
}
