// General magics: help, settings, themes, error display.

import { spawnSync } from 'node:child_process';
import { SETTINGS, Settings } from '../config.js';
import { renderValue } from '../display.js';
import { themeNames } from '../theme.js';
import { truncate, width as textWidth } from '../text.js';
import { CATEGORIES, CELL_MAGICS, LINE_MAGICS, MagicError, closest, lineMagic, splitArgs } from './registry.js';

export const KEYS = [
  ['Enter', 'run the cell (adds a newline while a block is unfinished)'],
  ['Shift+Enter · Alt+Enter · Ctrl+J', 'insert a newline'],
  ['Tab / Shift+Tab', 'complete · indent / dedent'],
  ['→ or Ctrl+E at the end', 'accept the grey suggestion from history'],
  ['↑ ↓ · Ctrl+R', 'history (matching what you typed) · search history'],
  ['Ctrl+O', 'edit the cell in $EDITOR'],
  ['Ctrl+C · Ctrl+D', 'clear input / interrupt · exit'],
  ['Ctrl+L', 'clear the screen'],
  ['Ctrl+A/E · Alt+B/F · Ctrl+W/K/U', 'line start/end · word left/right · delete word/to end/to start'],
  ['Esc (vi mode: --vi or %vi)', 'normal mode — hjkl w b e, d c y, iw i( i", v V, u Ctrl+R, .'],
];

export const SYNTAX = [
  ['obj? · obj??', 'inspect: type, signature, keys, value · plus the source'],
  ['Math.*round*?', 'search names with wildcards'],
  ['!cmd', 'run a shell command (when the name after ! isn’t one of your variables)'],
  ['$name · ${expr}', 'insert JS values into shell commands'],
  ['%magic args', 'line magic; %%magic on the first line makes a cell magic'],
  ['cd .. · pwd · ls', 'magics without % (automagic), when the line isn’t JavaScript'],
  ['\\alpha Tab', 'unicode: α, π, ∑, →…'],
  ['await · import', 'top-level await, and import statements (loaded with import())'],
  ['x: number · enum · <T>', 'TypeScript works in cells, %run file.ts and imported .ts files'],
  ['_ · _N · Out · In', 'last result · result N · all results · all inputs'],
  ['_error', 'the last error'],
  ['fs, path, os…', 'built-in modules are globals, loaded on first use'],
];

function table(shell, rows, keyStyle = 'accent') {
  const p = (s, t) => shell.theme.paint(s, t);
  const w = Math.min(34, Math.max(...rows.map(([k]) => textWidth(k))) + 2);
  return rows.map(([k, v]) => '  ' + p(keyStyle, k.padEnd(w)) + p('fg', truncate(v, Math.max(20, shell.width - w - 6)))).join('\n');
}

function usageOf(spec) {
  const prefix = spec.kind === 'cell' ? '%%' : '%';
  return `${prefix}${spec.name}${spec.usage ? ' ' + spec.usage : ''}`;
}

export function magicHelp(shell, name) {
  const p = (s, t) => shell.theme.paint(s, t);
  const clean = name.replace(/^%+/, '');
  const specs = [];
  if (!name.startsWith('%%') && LINE_MAGICS[clean]) specs.push(LINE_MAGICS[clean]);
  if (CELL_MAGICS[clean]) specs.push(CELL_MAGICS[clean]);
  if (!specs.length) {
    const close = closest(clean, [...Object.keys(LINE_MAGICS), ...Object.keys(CELL_MAGICS)]);
    throw new MagicError(`no magic named ${clean}${close ? ` — did you mean %${close}?` : ''}`);
  }
  return specs.map((s) => `${p('accent.bold', usageOf(s))}\n  ${p('fg', s.doc)}${s.aliasOf ? p('faint', `  (alias of %${s.aliasOf})`) : ''}`).join('\n\n');
}

lineMagic(['help', 'quickref'], { doc: 'Keys, syntax and every magic; %help name explains one magic.', usage: '[name]' }, (shell, args) => {
  const p = (s, t) => shell.theme.paint(s, t);
  if (args.trim()) {
    shell.print(magicHelp(shell, args.trim()));
    return;
  }
  const out = [p('fg.bold', 'Keys'), table(shell, KEYS, 'label'), '', p('fg.bold', 'Syntax'), table(shell, SYNTAX), ''];
  const groups = {};
  for (const spec of [...Object.values(LINE_MAGICS), ...Object.values(CELL_MAGICS)]) {
    if (spec.aliasOf) continue;
    (groups[spec.category] ??= []).push(spec);
  }
  for (const [key, label] of Object.entries(CATEGORIES)) {
    if (!groups[key]) continue;
    out.push(p('fg.bold', `Magics · ${label}`));
    out.push(table(shell, groups[key].map((s) => [(s.kind === 'cell' ? '%%' : '%') + s.name, s.doc.split(/(?<=\.)\s/)[0]])));
    out.push('');
  }
  out.push(p('faint', '  %help name for options · docs: https://github.com/arthurdaquinosilva/cinder'));
  shell.print(out.join('\n'));
});

lineMagic(['config'], {
  doc: 'Show or change settings for this session: %config, %config name, %config name=value. Save them in config.json to keep them.',
  usage: '[name[=value]]',
}, (shell, args) => {
  const p = (s, t) => shell.theme.paint(s, t);
  const text = args.trim();
  const fmt = (v) => JSON.stringify(v);
  if (!text) {
    const rows = Object.keys(SETTINGS).map((k) => [k, `${fmt(shell.settings[k])}  ${p('faint', '· ' + SETTINGS[k].doc)}`]);
    shell.print(table(shell, rows, 'label'));
    if (shell.profile) shell.print(p('faint', `  file: ${shell.profile.configFile}`));
    return;
  }
  const m = /^([\w.]+)\s*(?:=\s*(.*))?$/.exec(text);
  if (!m) throw new MagicError('usage: %config name=value');
  const [, name, value] = m;
  if (!(name in SETTINGS)) {
    const close = closest(name, Settings.names());
    throw new MagicError(`unknown setting ${name}${close ? ` — did you mean ${close}?` : ''}`);
  }
  if (value === undefined) {
    shell.print(`${p('label', name)} = ${fmt(shell.settings[name])}  ${p('faint', SETTINGS[name].doc)}`);
    return;
  }
  try {
    const set = shell.setSetting(name, value);
    shell.print(`${p('label', name)} = ${fmt(set)}`);
  } catch (e) {
    throw new MagicError(e.message);
  }
});

lineMagic(['theme'], { doc: `Switch the color theme (${themeNames().join(', ')}); without an argument, list them.`, usage: '[name]' }, (shell, args) => {
  const name = args.trim();
  if (!name) {
    shell.print(themeNames().map((t) => (t === shell.theme.name ? shell.theme.paint('accent.bold', `● ${t}`) : `  ${t}`)).join('\n'));
    return;
  }
  try {
    shell.setSetting('theme', name);
  } catch (e) {
    throw new MagicError(e.message);
  }
  shell.print(shell.theme.paint('accent', `theme ${name}`));
});

lineMagic(['xmode'], {
  doc: 'How errors are shown: minimal (one line), plain (the standard stack), context (your code around each frame, the default) or verbose (every frame, causes and extra fields).',
  usage: '[minimal|plain|context|verbose]',
}, (shell, args) => {
  const mode = args.trim();
  if (!mode) {
    shell.print(`xmode = ${shell.settings.xmode}`);
    return;
  }
  try {
    shell.setSetting('xmode', mode);
  } catch (e) {
    throw new MagicError(e.message);
  }
  shell.print(`xmode = ${shell.settings.xmode}`);
});

lineMagic(['editmode', 'vi'], {
  doc: 'Key bindings for the input: %editmode vi or %editmode emacs (%vi switches to vi). Without an argument, show the current one.',
  usage: '[vi|emacs]',
}, (shell, args) => {
  const mode = args.trim() || (shell.currentMagic === 'vi' ? 'vi' : '');
  if (mode) {
    try {
      shell.setSetting('editingMode', mode);
    } catch (e) {
      throw new MagicError(e.message);
    }
  }
  shell.print(`editing mode: ${shell.settings.editingMode}`);
});

lineMagic(['layout'], { doc: 'Switch the prompt layout: block (full-width input bar) or box (rounded box, like ember\'s classic look).', usage: '[block|box]' }, (shell, args) => {
  if (args.trim()) {
    try {
      shell.setSetting('layout', args.trim());
    } catch (e) {
      throw new MagicError(e.message);
    }
  }
  shell.print(`layout: ${shell.settings.layout}`);
});

lineMagic(['depth'], { doc: 'How many levels deep results are printed (default 4; Infinity for everything).', usage: '[n]' }, (shell, args) => {
  const v = args.trim();
  if (v) {
    try {
      shell.setSetting('depth', v === 'Infinity' ? Infinity : v);
    } catch (e) {
      throw new MagicError(e.message);
    }
  }
  shell.print(`depth = ${shell.settings.depth}`);
});

lineMagic(['clear', 'cls'], { doc: 'Clear the screen (also Ctrl+L).' }, (shell) => {
  shell.write('\x1b[2J\x1b[3J\x1b[H');
  shell.suppressFooter = true;
});

lineMagic(['exit', 'quit'], { doc: 'Leave cinder (also Ctrl+D, exit or .exit).', usage: '[code]' }, async (shell, args) => {
  const { ExitRequest } = await import('../shell.js');
  const [code] = splitArgs(args);
  throw new ExitRequest(code ? Number(code) : 0);
});

lineMagic(['lsmagic'], { doc: 'List every line and cell magic.' }, (shell) => {
  const p = (s, t) => shell.theme.paint(s, t);
  const names = (table, prefix) => {
    const lines = [''];
    for (const n of Object.keys(table).sort()) {
      const word = prefix + n;
      if (lines.at(-1) && lines.at(-1).length + word.length + 2 > shell.width - 4) lines.push('');
      lines[lines.length - 1] += (lines.at(-1) ? '  ' : '') + word;
    }
    return lines.join('\n');
  };
  shell.print(`${p('fg.bold', 'Line magics')}\n${names(LINE_MAGICS, '%')}\n\n${p('fg.bold', 'Cell magics')}\n${names(CELL_MAGICS, '%%')}`);
});

lineMagic(['precision'], {
  doc: 'Digits after the decimal point for printed numbers: %precision 3. Alone, back to how JavaScript prints them. Only the display changes, not the values.',
  usage: '[digits]',
}, (shell, args) => {
  try {
    shell.setSetting('precision', args.trim());
  } catch (e) {
    throw new MagicError(e.message);
  }
  shell.print(shell.settings.precision === '' ? 'precision: as JavaScript prints numbers' : `precision: ${shell.settings.precision} digits`);
});

lineMagic(['automagic'], { doc: 'Run magics without the % prefix (cd .., pwd, ls): %automagic on/off, or alone to toggle.', usage: '[on|off]' }, (shell, args) => {
  const v = args.trim() || String(!shell.settings.automagic);
  try {
    shell.setSetting('automagic', v);
  } catch (e) {
    throw new MagicError(e.message);
  }
  shell.print(`automagic ${shell.settings.automagic ? 'on' : 'off'}`);
});

lineMagic(['page'], {
  doc: 'Show a value in full (every level, every item) in your pager ($PAGER, or less). Default: the last result.',
  usage: '[expr]',
}, (shell, args) => {
  const value = args.trim() ? shell.evalSimple(args.trim()) : shell.lastValue;
  const text = renderValue(value, { theme: shell.theme, width: shell.width, depth: Infinity, precision: shell.settings.precision })
    .replace(/\n?$/, '\n');
  if (!process.stdout.isTTY) {
    shell.print(text);
    return;
  }
  shell.spinner.pause(true);
  const pager = process.env.PAGER || 'less -R';
  const r = spawnSync(pager, { input: text, stdio: ['pipe', 'inherit', 'inherit'], shell: true });
  shell.spinner.pause(false);
  if (r.error || r.status) shell.print(text);
});
