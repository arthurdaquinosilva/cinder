// Syntax highlighting built on the forgiving lexer.

import { tokenize } from './lexer.js';

const TOKEN_STYLE = {
  comment: 'syn.comment', string: 'syn.string', template: 'syn.template', number: 'syn.number',
  regex: 'syn.regex', keyword: 'syn.keyword', constant: 'syn.constant', builtin: 'syn.builtin',
  class: 'syn.class', function: 'syn.function', property: 'syn.property', name: 'syn.name',
  punct: 'syn.punct', magic: 'syn.magic', other: 'syn.name', space: null,
};

/** One style name (or null) per UTF-16 index of `src`. */
export function styleMap(src) {
  const styles = new Array(src.length).fill(null);
  const trimmed = src.trimStart();
  if (trimmed.startsWith('!') && !trimmed.startsWith('!=')) {
    // shell escape: `!` in the accent colour, the command plain
    const at = src.indexOf('!');
    styles[at] = 'syn.magic';
    return styles;
  }
  for (const t of tokenize(src)) {
    const style = TOKEN_STYLE[t.type];
    for (let i = t.start; i < t.end; i++) styles[i] = style;
  }
  return styles;
}

/** Group a line's characters into runs of the same style: [[style, text], …]. */
export function runs(text, styles, offset = 0) {
  const out = [];
  let cur = null;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const s = styles[offset + i] ?? null;
    if (s !== cur && buf) {
      out.push([cur, buf]);
      buf = '';
    }
    cur = s;
    buf += text[i];
  }
  if (buf) out.push([cur, buf]);
  return out;
}

/** Highlight source as an ANSI string (used for echoing finished cells). */
export function highlight(src, theme) {
  const styles = styleMap(src);
  return runs(src, styles).map(([s, t]) => (s ? theme.paint(s, t) : theme.paint('fg', t))).join('');
}
