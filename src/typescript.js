// TypeScript: types, interfaces, generics, enums, namespaces and parameter properties in cells, in files run
// with %run, and in .ts files you import or require.
//
// Node (22.13+) ships a TypeScript compiler, `module.stripTypeScriptTypes`. Its strip mode blanks out type
// syntax and keeps every position, so errors point at the right line and column. Code that needs real code
// generation (enum, namespace, constructor(private x)) goes through its transform mode instead, with a source
// map to put errors back on your lines. On older Node the `typescript` package is used when the project has it.

import fs from 'node:fs';
import module, { createRequire } from 'node:module';
import path from 'node:path';

const nodeCompiler = typeof module.stripTypeScriptTypes === 'function' ? module.stripTypeScriptTypes : null;

/** A TypeScript syntax error; `incomplete` means the code simply isn't finished yet (smart Enter). */
export class TypeScriptError extends SyntaxError {
  constructor(message, { incomplete = false } = {}) {
    super(message);
    this.name = 'SyntaxError';
    this.typescript = true;
    this.incomplete = incomplete;
  }
}

let mode = 'auto'; // auto · always · off

export function setTypeScriptMode(value) {
  mode = value;
}

export function typeScriptMode() {
  return mode;
}

/** The typescript package from the current project, if it has one. */
function typescriptPackage() {
  try {
    return createRequire(path.join(process.cwd(), '[cinder]'))('typescript');
  } catch {
    return null;
  }
}

export function available() {
  return Boolean(nodeCompiler || typescriptPackage());
}

/** Does this look like TypeScript? Decides whose syntax error to show when neither parser accepts the code. */
export function looksLikeTypeScript(source) {
  return /\b(interface|enum|namespace|declare|implements|readonly|abstract|satisfies|keyof)\s|\btype\s+[A-Za-z_$][\w$]*\s*[<=]|\bas\s+(const\b|[A-Za-z_{[(])|\b(let|const|var)\s+[\w$]+\s*[!?]?:|[\w$)]\s*\)\s*:\s*[\w{[(]|\(\s*[\w$]+\??\s*:\s*[\w{[(]|<[A-Z][\w$]*(,\s*[\w$]+)*>\s*\(|[\w$)\]]!\.|\b(private|public|protected)\s+[\w$]+/.test(source);
}

function sourceMapFrom(code) {
  const m = /\/\/# sourceMappingURL=data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code);
  if (!m) return { code, map: null };
  let map = null;
  try {
    map = new module.SourceMap(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')));
  } catch {
    map = null;
  }
  return { code: code.slice(0, m.index).trimEnd() + '\n', map };
}

function withNode(source, filename) {
  try {
    return { code: nodeCompiler(source, { mode: 'strip' }), map: null };
  } catch (e) {
    if (!/not supported in strip-only mode/.test(e.message)) throw toError(e);
  }
  try {
    return sourceMapFrom(nodeCompiler(source, { mode: 'transform', sourceMap: true, sourceUrl: filename }));
  } catch (e) {
    throw toError(e);
  }
}

function toError(e) {
  const message = String(e.message).split('\n')[0];
  return new TypeScriptError(message, { incomplete: /Unexpected eof/i.test(message) });
}

function withPackage(ts, source, filename) {
  const out = ts.transpileModule(source, {
    fileName: path.basename(filename || 'cell.ts'),
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      inlineSourceMap: true,
      isolatedModules: true,
      useDefineForClassFields: true,
    },
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const d = errors[0];
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const atEnd = d.start !== undefined && d.start >= source.trimEnd().length;
    throw new TypeScriptError(message, { incomplete: atEnd && /expected/i.test(message) });
  }
  return sourceMapFrom(out.outputText);
}

/**
 * Compile TypeScript to JavaScript: {code, map}. `map` (a module.SourceMap) is set when positions moved.
 * Throws TypeScriptError for invalid code, or when no compiler is available.
 */
export function compile(source, filename = '[cell].ts') {
  if (nodeCompiler) return withNode(source, filename);
  const ts = typescriptPackage();
  if (ts) return withPackage(ts, source, filename);
  throw new TypeScriptError(`TypeScript needs Node 22.13 or newer (you have ${process.version}), or the typescript package in this project (npm i -D typescript)`);
}

/** Map a 1-based line/column in compiled code back to the TypeScript source. */
export function originalPosition(map, line, column) {
  if (!map) return { line, column };
  const entry = map.findEntry(line - 1, Math.max(0, column - 1));
  if (!entry || entry.originalLine === undefined) return { line, column };
  return { line: entry.originalLine + 1, column: entry.originalColumn + 1 };
}

// ── imported .ts files ───────────────────────────────────────────────────────

let hooked = false;

function formatOf(file, source) {
  if (file.endsWith('.mts')) return 'module';
  if (file.endsWith('.cts')) return 'commonjs';
  let dir = path.dirname(file);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.type === 'module') return 'module';
      if (pkg.type === 'commonjs') return 'commonjs';
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return /^\s*(import|export)\b/m.test(source) ? 'module' : 'commonjs';
}

/**
 * Compile .ts/.mts/.cts files you import or require (outside node_modules) with enums and namespaces
 * allowed, and map their stack traces back to the TypeScript. Needs module.registerHooks (Node 22.15+).
 */
export function installLoader() {
  if (hooked || !nodeCompiler || typeof module.registerHooks !== 'function') return false;
  hooked = true;
  process.setSourceMapsEnabled?.(true);
  module.registerHooks({
    load(url, context, nextLoad) {
      if (mode === 'off' || !/\.(c|m)?ts$/.test(url) || !url.startsWith('file:') || url.includes('/node_modules/')) {
        return nextLoad(url, context);
      }
      const file = new URL(url).pathname;
      const source = fs.readFileSync(decodeURIComponent(file), 'utf8');
      let code;
      try {
        code = nodeCompiler(source, { mode: 'transform', sourceMap: true, sourceUrl: url });
      } catch (e) {
        const err = toError(e);
        err.message = `${path.basename(file)}: ${err.message}`;
        throw err;
      }
      return { format: formatOf(decodeURIComponent(file), source), source: code, shortCircuit: true };
    },
  });
  return true;
}
