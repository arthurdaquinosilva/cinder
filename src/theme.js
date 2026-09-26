// Color palettes shared by the input bar, cell chrome, syntax highlighting and util.inspect.

import util from 'node:util';

// The name's color, the same in every theme: purple sets cinder apart from ember, whose accent is orange.
const BRAND = '#b18cff';

export const PALETTES = {
  // Near-black monochrome with a single warm accent.
  void: {
    fg: '#e7e7e7', muted: '#8b8b8b', faint: '#555555', border: '#3b3b3b', surface: '#161616',
    selection: '#2b2b2b', bar: '#24262b', label: '#86c7c0', accent: '#ff8a4c', accent2: '#ffc46b',
    ok: '#7ee2a8', err: '#ff6b6b', warn: '#f2c14e', info: '#7cc4ff',
    keyword: '#ff9e6b', builtin: '#7cc4ff', function: '#e7e7e7', klass: '#ffd08a', string: '#a8d8a0',
    number: '#f5a97f', comment: '#5f5f5f', operator: '#9a9a9a', decorator: '#c9a0ff', brand: BRAND,
  },
  nebula: {
    fg: '#e4e1f5', muted: '#8c87a8', faint: '#56516e', border: '#3a3552', surface: '#15131f',
    selection: '#2a2640', bar: '#262238', label: '#6ee7f9', accent: '#b18cff', accent2: '#6ee7f9',
    ok: '#6ee7b7', err: '#fb7185', warn: '#fcd34d', info: '#6ee7f9',
    keyword: '#c4a5ff', builtin: '#6ee7f9', function: '#f0ecff', klass: '#f9a8d4', string: '#86efac',
    number: '#fda4af', comment: '#5c5776', operator: '#a39fc0', decorator: '#f9a8d4', brand: BRAND,
  },
  matrix: {
    fg: '#d7f5dd', muted: '#7a9a80', faint: '#46604b', border: '#2e4533', surface: '#0f1a12',
    selection: '#1f3324', bar: '#18261c', label: '#5eead4', accent: '#4ade80', accent2: '#a3e635',
    ok: '#4ade80', err: '#f87171', warn: '#facc15', info: '#5eead4',
    keyword: '#4ade80', builtin: '#5eead4', function: '#ecfdf0', klass: '#a3e635', string: '#bef264',
    number: '#fde68a', comment: '#4b6b52', operator: '#8fb396', decorator: '#5eead4', brand: BRAND,
  },
};

export const DEFAULT_THEME = 'void';

// Style names → "modifiers palette-key". `bg:key` sets the background.
const STYLES = {
  fg: 'fg', muted: 'muted', faint: 'faint', border: 'border', label: 'bold label',
  accent: 'accent', 'accent.bold': 'bold accent', accent2: 'accent2', brand: 'brand', 'brand.bold': 'bold brand',
  ok: 'ok', 'ok.bold': 'bold ok', err: 'err', 'err.bold': 'bold err', warn: 'warn', info: 'info',
  'fg.bold': 'bold fg', 'info.bold': 'bold info',
  // syntax
  'syn.keyword': 'keyword', 'syn.builtin': 'builtin', 'syn.function': 'function', 'syn.class': 'bold klass',
  'syn.string': 'string', 'syn.number': 'number', 'syn.comment': 'italic comment', 'syn.operator': 'operator',
  'syn.punct': 'operator', 'syn.regex': 'decorator', 'syn.template': 'accent2', 'syn.constant': 'number',
  'syn.name': 'fg', 'syn.property': 'fg', 'syn.magic': 'bold accent', 'syn.error': 'err',
  // input bar
  'bar.prompt': 'bold accent', 'bar.cont': 'faint', 'bar.count': 'faint', placeholder: 'faint',
  suggestion: 'faint', 'bracket.match': 'bold bg:selection',
  // key bar & mode line
  'keybar.label': 'bold label', 'keybar.key': 'fg', 'keybar.sep': 'faint',
  status: 'muted', 'status.dim': 'faint', 'status.sep': 'faint',
  // signature hints
  'sig.icon': 'accent', 'sig.name': 'bold builtin', 'sig.param': 'muted', 'sig.param.current': 'bold underline accent',
  'sig.type': 'klass', 'sig.type.inferred': 'italic muted', 'sig.return': 'bold klass', 'sig.default': 'faint', 'sig.punct': 'faint',
  // completion menu
  'menu': 'fg bg:surface', 'menu.current': 'bold accent bg:selection', 'menu.meta': 'faint bg:surface',
  'menu.meta.current': 'muted bg:selection', 'menu.icon': 'faint bg:surface',
  'icon.function': 'builtin', 'icon.class': 'klass', 'icon.module': 'decorator', 'icon.keyword': 'keyword',
  'icon.value': 'string', 'icon.magic': 'accent', 'icon.path': 'accent2', 'icon.property': 'muted',
  'search.match': 'bg:selection', 'search.prompt': 'bold accent', selection: 'fg bg:selection',
  // inspect `obj?`
  'inspect.key': 'bold label', 'inspect.head': 'bold accent',
};

const MODIFIERS = { bold: '1', dim: '2', italic: '3', underline: '4', blink: '5', inverse: '7' };

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Nearest xterm-256 color, for terminals without 24-bit color.
function rgbTo256([r, g, b]) {
  const level = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const steps = [0, 95, 135, 175, 215, 255];
  const cube = 16 + 36 * cr + 6 * cg + cb;
  const cubeDist = (steps[cr] - r) ** 2 + (steps[cg] - g) ** 2 + (steps[cb] - b) ** 2;
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const greyDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return greyDist < cubeDist ? 232 + grey : cube;
}

export function colorDepth(stream = process.stdout) {
  if ('NO_COLOR' in process.env && process.env.NO_COLOR !== '') return 1;
  if (process.env.FORCE_COLOR === '0') return 1;
  if (process.env.FORCE_COLOR || process.env.CINDER_FORCE_COLOR) return 24;
  if (!stream.isTTY) return 1;
  const depth = stream.getColorDepth?.() ?? 8;
  return depth >= 24 ? 24 : depth >= 8 ? 8 : depth > 1 ? 8 : 1;
}

export class Theme {
  constructor(name = DEFAULT_THEME, depth = colorDepth()) {
    this.name = PALETTES[name] ? name : DEFAULT_THEME;
    this.p = PALETTES[this.name];
    this.depth = depth;
    this.codes = {};
    for (const [key, spec] of Object.entries(STYLES)) this.codes[key] = this.compile(spec);
  }

  get color() {
    return this.depth > 1;
  }

  colorCode(hex, bg = false) {
    const rgb = hexToRgb(hex);
    if (this.depth >= 24) return `${bg ? 48 : 38};2;${rgb.join(';')}`;
    return `${bg ? 48 : 38};5;${rgbTo256(rgb)}`;
  }

  /** "bold accent bg:bar" → SGR parameter string ("1;38;2;…"). */
  compile(spec) {
    if (!this.color) return '';
    const parts = [];
    for (const word of spec.split(/\s+/).filter(Boolean)) {
      if (MODIFIERS[word]) parts.push(MODIFIERS[word]);
      else if (word.startsWith('bg:')) parts.push(this.colorCode(this.p[word.slice(3)] ?? word.slice(3), true));
      else if (this.p[word]) parts.push(this.colorCode(this.p[word]));
      else if (word.startsWith('#')) parts.push(this.colorCode(word));
    }
    return parts.join(';');
  }

  /** Wrap text in a named style. `bg` (a palette key) adds a background that survives the reset. */
  paint(style, text, bg) {
    if (!this.color || text === '') return text;
    let code = this.codes[style] ?? this.compile(style);
    if (bg) code = [code, this.colorCode(this.p[bg] ?? bg, true)].filter(Boolean).join(';');
    return code ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  /** Start a background that later text keeps until a full reset. */
  bg(key) {
    return this.color ? `\x1b[${this.colorCode(this.p[key] ?? key, true)}m` : '';
  }

  /** Point util.inspect's color table at this palette. */
  installInspectColors() {
    const colors = util.inspect.colors;
    const styles = util.inspect.styles;
    const map = {
      number: 'number', bigint: 'number', boolean: 'keyword', undefined: 'faint', null: 'faint',
      string: 'string', symbol: 'decorator', date: 'klass', regexp: 'decorator', special: 'builtin',
      module: 'decorator',
    };
    for (const [kind, key] of Object.entries(map)) {
      const name = `cinder_${kind}`;
      const code = this.depth >= 24 ? `38;2;${hexToRgb(this.p[key]).join(';')}` : `38;5;${rgbTo256(hexToRgb(this.p[key]))}`;
      colors[name] = [code, 39];
      styles[kind] = name;
    }
  }
}

export function themeNames() {
  return Object.keys(PALETTES);
}
