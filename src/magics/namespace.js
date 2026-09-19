// Namespace & inspection magics.

import fs from 'node:fs';
import { fileLabel, psearch, renderInspect, renderValue } from '../display.js';
import { highlight } from '../highlight.js';
import { functionLocation } from '../locate.js';
import { functionInfo, renderSignature } from '../signature.js';
import { describe } from '../introspect.js';
import { stripAnsi, truncate } from '../text.js';
import { MagicError, lineMagic, parseArgs } from './registry.js';

const category = 'namespace';

lineMagic(['who'], { doc: 'List the variables you defined in this session.', category }, (shell) => {
  const names = Object.keys(shell.userVars()).sort();
  shell.print(names.length ? names.join('  ') : shell.theme.paint('faint', 'no variables yet'));
});

lineMagic(['whos'], { doc: 'Your variables as a table: name, type and value.', category }, (shell) => {
  const vars = shell.userVars();
  const names = Object.keys(vars).sort();
  if (!names.length) {
    shell.print(shell.theme.paint('faint', 'no variables yet'));
    return;
  }
  const p = (s, t) => shell.theme.paint(s, t);
  const nameW = Math.min(24, Math.max(8, ...names.map((n) => n.length)) + 2);
  const types = names.map((n) => describe(vars[n]));
  const typeW = Math.min(28, Math.max(6, ...types.map((t) => t.length)) + 2);
  const valueW = Math.max(10, shell.width - nameW - typeW - 6);
  const rows = [p('accent.bold', 'name'.padEnd(nameW) + 'type'.padEnd(typeW) + 'value')];
  names.forEach((n, i) => {
    let v;
    try {
      v = stripAnsi(renderValue(vars[n], { theme: shell.theme, width: 1000, depth: 0, colors: false })).replace(/\s*\n\s*/g, ' ');
    } catch {
      v = '?';
    }
    rows.push(p('label', truncate(n, nameW - 1).padEnd(nameW)) + p('muted', truncate(types[i], typeW - 1).padEnd(typeW)) + p('fg', truncate(v, valueW)));
  });
  shell.print(rows.join('\n'));
});

lineMagic(['reset'], {
  doc: 'Delete your variables and the result history (_, _N, Out). Asks you to confirm with -f.',
  usage: '[-f]',
  category,
}, (shell, args) => {
  const { opts } = parseArgs(args, { f: 'bool' });
  const names = Object.keys(shell.userVars());
  if (!opts.f) {
    shell.print(shell.theme.paint('warn', `this deletes ${names.length} variable${names.length === 1 ? '' : 's'} and the output history — run %reset -f to do it`));
    return;
  }
  for (const n of names) shell.deleteVar(n);
  for (const k of Object.keys(shell.Out)) {
    delete shell.Out[k];
    delete globalThis[`_${k}`];
  }
  shell.lastValue = undefined;
  shell.print(shell.theme.paint('muted', `deleted ${names.length} variable${names.length === 1 ? '' : 's'}`));
});

lineMagic(['del', 'xdel'], { doc: 'Delete a variable, including references to it in Out and _N.', usage: 'name…', category }, (shell, args) => {
  const { rest } = parseArgs(args);
  if (!rest.length) throw new MagicError('usage: %del name');
  for (const name of rest) {
    if (!Object.prototype.hasOwnProperty.call(globalThis, name)) throw new MagicError(`${name} is not defined`);
    const value = globalThis[name];
    shell.deleteVar(name);
    for (const [k, v] of Object.entries(shell.Out)) {
      if (v === value) {
        delete shell.Out[k];
        delete globalThis[`_${k}`];
      }
    }
    if (shell.lastValue === value) shell.lastValue = undefined;
  }
});

lineMagic(['pinfo', 'inspect'], { doc: 'Inspect an object, like obj? (add -s for the source, like obj??).', usage: '[-s] expr', category }, (shell, args) => {
  const { opts, rest } = parseArgs(args, { s: 'bool' });
  const expr = rest.join(' ');
  if (!expr) throw new MagicError('usage: %pinfo expr');
  shell.print(renderInspect(expr, shell.evalSimple(expr), opts.s ? 2 : 1, { theme: shell.theme, width: shell.width - 2, sources: shell.In }));
});

lineMagic(['psearch'], { doc: 'Search names with wildcards, like Math.*round*? — e.g. %psearch *Array*.', usage: 'pattern', category }, (shell, args) => {
  const pattern = args.trim();
  if (!pattern) throw new MagicError('usage: %psearch pattern');
  const names = psearch(pattern.includes('*') ? pattern : `*${pattern}*`);
  shell.print(names.length ? names.join('\n') : shell.theme.paint('faint', `nothing matches ${pattern}`));
});

lineMagic(['who_ls'], { doc: 'Your variable names, returned as a sorted array.', category }, (shell) => Object.keys(shell.userVars()).sort());

lineMagic(['reset_selective'], {
  doc: 'Delete the variables whose names match a regular expression (confirm with -f).',
  usage: '[-f] regex',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { f: 'bool' });
  if (!rest.length) throw new MagicError('usage: %reset_selective [-f] regex');
  let re;
  try {
    re = new RegExp(rest.join(' '));
  } catch (e) {
    throw new MagicError(`bad pattern: ${e.message}`);
  }
  const names = Object.keys(shell.userVars()).filter((n) => re.test(n));
  if (!opts.f) {
    shell.print(shell.theme.paint('warn', `this deletes ${names.join(', ') || 'nothing'} — run %reset_selective -f ${rest.join(' ')} to do it`));
    return;
  }
  for (const n of names) shell.deleteVar(n);
  shell.print(shell.theme.paint('muted', `deleted ${names.length} variable${names.length === 1 ? '' : 's'}`));
});

function fnArg(shell, args, magic) {
  const expr = args.trim();
  if (!expr) throw new MagicError(`usage: %${magic} expr`);
  const value = shell.evalSimple(expr);
  if (typeof value !== 'function') throw new MagicError(`${expr} is not a function or class`);
  return [expr, value];
}

lineMagic(['pdef'], { doc: 'The signature of a function or class.', usage: 'expr', category }, (shell, args) => {
  const [expr, fn] = fnArg(shell, args, 'pdef');
  shell.print(renderSignature(functionInfo(fn, expr, shell.In), shell.width - 2, shell.theme));
});

lineMagic(['pdoc'], { doc: 'The JSDoc comment of a function defined in one of your cells.', usage: 'expr', category }, (shell, args) => {
  const [expr, fn] = fnArg(shell, args, 'pdoc');
  const info = functionInfo(fn, expr, shell.In);
  const p = (s, t) => shell.theme.paint(s, t);
  if (!info.summary && !info.params.some((x) => x.type && !x.inferred)) {
    shell.print(p('faint', `no JSDoc for ${expr}`));
    return;
  }
  const lines = [];
  if (info.summary) lines.push(p('fg', info.summary));
  for (const x of info.params) if (x.type && !x.inferred) lines.push(`  ${p('label', x.name)} ${p('sig.type', x.type)}`);
  if (info.returns && !info.returnsInferred) lines.push(`  ${p('muted', 'returns')} ${p('sig.return', info.returns)}`);
  shell.print(lines.join('\n'));
});

lineMagic(['psource'], { doc: 'The source of a function or class, highlighted.', usage: 'expr', category }, (shell, args) => {
  const [, fn] = fnArg(shell, args, 'psource');
  const src = Function.prototype.toString.call(fn);
  if (/\[native code\]/.test(src)) throw new MagicError('native code — no JavaScript source');
  shell.print(highlight(src, shell.theme));
});

lineMagic(['pfile'], {
  doc: 'Where a function or class was defined, and the file around it (cells show as cell N).',
  usage: 'expr',
  category,
}, (shell, args) => {
  const [expr, fn] = fnArg(shell, args, 'pfile');
  const loc = functionLocation(fn);
  if (!loc) throw new MagicError(`no location for ${expr} (built-in or bound function)`);
  const p = (s, t) => shell.theme.paint(s, t);
  shell.print(p('inspect.head', `${fileLabel(loc.file)}:${loc.line}`));
  let source = shell.sources.get(loc.file)?.source;
  if (!source) {
    try {
      source = fs.readFileSync(loc.file, 'utf8');
    } catch {
      return;
    }
  }
  const all = source.split('\n');
  const from = Math.max(1, loc.line - 2);
  const to = Math.min(all.length, loc.line + 12);
  const gutter = String(to).length;
  for (let n = from; n <= to; n++) shell.print(`${p(n === loc.line ? 'accent' : 'faint', String(n).padStart(gutter))} ${p('border', '│')} ${highlight(all[n - 1], shell.theme)}`);
});
