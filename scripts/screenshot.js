#!/usr/bin/env node
// Record docs/assets/cover.svg (the start screen) and docs/assets/demo.svg (a short session) from a real
// cinder session: it runs in an isolated tmux server, the screen is captured with its colors, and the
// ANSI output is converted to SVG. Needs tmux.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const socket = `cinder-shot-${process.pid}`;
const COLS = 100;
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cinder-shot-')));
const demoDir = path.join(home, 'my-app');
fs.mkdirSync(demoDir);
fs.writeFileSync(path.join(demoDir, 'package.json'), JSON.stringify({ name: 'my-app', version: '1.0.0' }));

const tmux = (...args) => execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(re, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(tmux('capture-pane', '-p', '-t', 'shot'))) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${re}`);
}

async function type(text, { enter = true, wait = /╰─ [✓✗]/ } = {}) {
  const before = tmux('capture-pane', '-p', '-t', 'shot').match(/╰─ /g)?.length ?? 0;
  for (const ch of text) {
    tmux('send-keys', '-t', 'shot', '-l', ch);
    await sleep(8);
  }
  if (!enter) return;
  tmux('send-keys', '-t', 'shot', 'Enter');
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const n = tmux('capture-pane', '-p', '-S', '-200', '-t', 'shot').match(/╰─ [✓✗]/g)?.length ?? 0;
    if (n > before || !wait) break;
    await sleep(50);
  }
  await sleep(150);
}

// ── ANSI → SVG ────────────────────────────────────────────────────────────────

const PALETTE16 = ['#1c1c1c', '#ff6b6b', '#7ee2a8', '#f2c14e', '#7cc4ff', '#c9a0ff', '#86c7c0', '#e7e7e7'];
const BG = '#101012';
const FG = '#e7e7e7';

function color256(n) {
  if (n < 8) return PALETTE16[n];
  if (n < 16) return PALETTE16[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
}

const PLAIN = { fg: null, bg: null, bold: false, italic: false, underline: false };

/**
 * Parse one captured line into cells: [{ch, fg, bg, bold, italic, underline}]. tmux writes styles as changes
 * from the previous cell, even across lines, so the style state is carried from line to line.
 */
function parseLine(line, state) {
  const cells = [];
  let st = state.current;
  const re = /\x1b\[([0-9;:]*)m|([\s\S])/gu;
  let m;
  while ((m = re.exec(line))) {
    if (m[2] !== undefined) {
      cells.push({ ch: m[2], ...st });
      if (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/.test(m[2])) cells.push({ ch: '', ...st });
      continue;
    }
    const p = (m[1] || '0').split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) st = PLAIN;
      else if (c === 1) st = { ...st, bold: true };
      else if (c === 3) st = { ...st, italic: true };
      else if (c === 4) st = { ...st, underline: true };
      else if (c === 22) st = { ...st, bold: false };
      else if (c === 23) st = { ...st, italic: false };
      else if (c === 24) st = { ...st, underline: false };
      else if (c === 39) st = { ...st, fg: null };
      else if (c === 49) st = { ...st, bg: null };
      else if (c >= 30 && c <= 37) st = { ...st, fg: PALETTE16[c - 30] };
      else if (c >= 90 && c <= 97) st = { ...st, fg: PALETTE16[c - 90] };
      else if (c >= 40 && c <= 47) st = { ...st, bg: PALETTE16[c - 40] };
      else if ((c === 38 || c === 48) && p[i + 1] === 2) {
        const rgb = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
        st = { ...st, [c === 38 ? 'fg' : 'bg']: rgb };
        i += 4;
      } else if ((c === 38 || c === 48) && p[i + 1] === 5) {
        st = { ...st, [c === 38 ? 'fg' : 'bg']: color256(p[i + 2]) };
        i += 2;
      }
    }
  }
  state.current = st;
  return cells;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toSVG(ansi, title) {
  const state = { current: PLAIN };
  const lines = ansi.replace(/\n+$/, '').split('\n').map((l) => parseLine(l, state));
  while (lines.length && !lines.at(-1).some((c) => c.ch.trim() || c.bg)) lines.pop();
  const cw = 8.43;
  const lh = 19;
  const pad = 18;
  const top = 44;
  const width = Math.ceil(COLS * cw + pad * 2);
  const height = Math.ceil(top + lines.length * lh + pad);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">`,
    `<style>text{font-family:'SF Mono',Menlo,Monaco,'DejaVu Sans Mono',Consolas,monospace;font-size:14px;white-space:pre;fill:${FG}}.b{font-weight:bold}.i{font-style:italic}.u{text-decoration:underline}</style>`,
    `<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>`,
    ...['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<circle cx="${22 + i * 20}" cy="20" r="6" fill="${c}"/>`),
    `<text x="${width / 2}" y="25" text-anchor="middle" style="fill:#6b6b6b;font-size:12px">${esc(title)}</text>`,
  ];
  lines.forEach((cells, row) => {
    const y = top + row * lh;
    // backgrounds, merged into runs
    for (let i = 0; i < cells.length; ) {
      const bg = cells[i].bg;
      let j = i;
      while (j < cells.length && cells[j].bg === bg) j++;
      if (bg) out.push(`<rect x="${(pad + i * cw).toFixed(1)}" y="${y}" width="${((j - i) * cw + 0.6).toFixed(1)}" height="${lh}" fill="${bg}"/>`);
      i = j;
    }
    // text runs with the same style; each run is placed at its column
    const spans = [];
    for (let i = 0; i < cells.length; ) {
      const c = cells[i];
      let j = i;
      let text = '';
      while (j < cells.length && cells[j].fg === c.fg && cells[j].bold === c.bold && cells[j].italic === c.italic && cells[j].underline === c.underline) {
        text += cells[j].ch;
        j++;
      }
      if (text.trim()) {
        const cls = [c.bold && 'b', c.italic && 'i', c.underline && 'u'].filter(Boolean).join(' ');
        // block characters are drawn as rectangles so the pixel wordmark has no gaps
        if (/^[▀▄█ ]+$/.test(text)) {
          [...text].forEach((ch, k) => {
            const x = (pad + (i + k) * cw).toFixed(1);
            const fill = c.fg ?? FG;
            if (ch === '█') out.push(`<rect x="${x}" y="${y}" width="${(cw + 0.3).toFixed(1)}" height="${lh}" fill="${fill}"/>`);
            if (ch === '▀') out.push(`<rect x="${x}" y="${y}" width="${(cw + 0.3).toFixed(1)}" height="${lh / 2}" fill="${fill}"/>`);
            if (ch === '▄') out.push(`<rect x="${x}" y="${y + lh / 2}" width="${(cw + 0.3).toFixed(1)}" height="${lh / 2}" fill="${fill}"/>`);
          });
        } else {
          spans.push(`<tspan x="${(pad + i * cw).toFixed(1)}"${c.fg ? ` style="fill:${c.fg}"` : ''}${cls ? ` class="${cls}"` : ''}>${esc(text)}</tspan>`);
        }
      }
      i = j;
    }
    if (spans.length) out.push(`<text y="${y + 14}">${spans.join('')}</text>`);
  });
  out.push('</svg>');
  return out.join('\n') + '\n';
}

// ── the session ──────────────────────────────────────────────────────────────

async function main() {
  if (spawnSync('tmux', ['-V']).status !== 0) throw new Error('tmux is needed to record screenshots');
  const env = ['-e', `XDG_DATA_HOME=${home}/data`, '-e', `XDG_CONFIG_HOME=${home}/config`, '-e', 'COLORTERM=truecolor', '-e', `HOME=${home}`];
  const cmd = `/bin/sh -c 'trap : INT; cd "${demoDir}" && "${process.execPath}" "${root}/bin/cinder.js"; sleep 30'`;

  // cover: the start screen
  tmux('new-session', '-d', '-s', 'shot', '-x', String(COLS), '-y', '24', ...env, cmd);
  await waitFor(/Type JavaScript/);
  await sleep(300);
  const assets = path.join(root, 'docs', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'cover.svg'), toSVG(tmux('capture-pane', '-p', '-e', '-N', '-t', 'shot'), 'cinder'));
  tmux('kill-server');

  // demo: a few cells and a signature hint
  tmux('new-session', '-d', '-s', 'shot', '-x', String(COLS), '-y', '44', ...env, cmd);
  await waitFor(/Type JavaScript/);
  tmux('send-keys', '-t', 'shot', 'C-l');
  await sleep(200);
  await type('const langs = [{ name: "js", year: 1995 }, { name: "ts", year: 2012 }, { name: "go", year: 2009 }]');
  await type('langs.toSorted((a, b) => a.year - b.year).map((l) => l.name)');
  await type('import { createHash } from "node:crypto"');
  await type('createHash("sha256").update("cinder").digest("hex").slice(0, 12)');
  await type('%timeit JSON.parse(JSON.stringify(langs))');
  await type('function greet(name, times = 1) { return `hi ${name}! `.repeat(times) }');
  await type('greet("Ada", ', { enter: false });
  await sleep(400);
  fs.writeFileSync(path.join(assets, 'demo.svg'), toSVG(tmux('capture-pane', '-p', '-e', '-N', '-t', 'shot'), 'cinder — ~/my-app'));
  tmux('kill-server');
  console.log('wrote docs/assets/cover.svg and docs/assets/demo.svg');
}

main().catch((e) => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  console.error(e.message);
  process.exit(1);
});
