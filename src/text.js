// Terminal text helpers: display width, ANSI stripping, truncation, paths and durations.

import os from 'node:os';
import path from 'node:path';

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f || cp === 0xfe0e ||
    (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Display width of a string that may contain ANSI escapes. */
export function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** Cut plain text to at most `max` columns, ending with … when it was cut. */
export function truncate(s, max) {
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Cut a string containing ANSI escapes to `max` columns, keeping the escapes. */
export function truncateAnsi(s, max, ellipsis = '…') {
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  const limit = max - width(ellipsis);
  while (i < s.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const cw = charWidth(ch);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + ellipsis + '\x1b[0m';
}

export function padEnd(s, cols) {
  const w = width(s);
  return w >= cols ? s : s + ' '.repeat(cols - w);
}

export function shortPath(p) {
  const home = os.homedir();
  if (p === home || p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

export function formatDuration(seconds) {
  if (seconds < 1e-6) return `${(seconds * 1e9).toFixed(0)}ns`;
  if (seconds < 1e-3) return `${(seconds * 1e6).toFixed(1)}µs`;
  if (seconds < 1) return `${(seconds * 1e3).toFixed(1)}ms`;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${Math.round(seconds - m * 60)}s`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
