// The interactive prompt: a full-width input bar, a context-aware key bar and a mode line, drawn below
// the scrollback and redrawn in place. Finished cells are erased from the frame and printed by the shell.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wordmark } from './banner.js';
import { EditBuffer } from './buffer.js';
import { ICONS, commonPrefix, complete } from './completer.js';
import { runs, styleMap } from './highlight.js';
import { KeyDecoder, keyName } from './keys.js';
import { matchBracket } from './lexer.js';
import { renderSignature, signatureAt } from './signature.js';
import { ExitRequest } from './shell.js';
import { Vi } from './vi.js';
import { charWidth, formatDuration, shortPath, truncate, truncateAnsi, width as textWidth } from './text.js';
import { INDENT, hasPrompts, isComplete, nextIndent, stripPrompts } from './transform.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Terminals only tell Shift+Enter apart from Enter when asked: while the prompt is open we request xterm's
// modifyOtherKeys (level 1), which xterm, iTerm2, WezTerm, Ghostty, kitty and tmux (extended-keys on) honour.
const ENABLE_KEYS = '\x1b[>4;1m\x1b[?2004h';
const DISABLE_KEYS = '\x1b[>4;0m\x1b[?2004l';
const MENU_HEIGHT = 8;

function packageName(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.name ? `${pkg.name}${pkg.version ? '@' + pkg.version : ''}` : null;
  } catch {
    return null;
  }
}

export class Repl {
  constructor(shell, { stdin = process.stdin, stdout = process.stdout } = {}) {
    this.shell = shell;
    this.stdin = stdin;
    this.stdout = stdout;
    this.buffer = new EditBuffer();
    this.menu = null; // {start, items, index, inserted}
    this.search = null; // {query, index, original, list}
    this.histNav = null; // {prefix, index, original, list}
    this.flash = null; // {text, until}
    this.frame = { rows: 0, cursorRow: 0, widths: [] };
    this.shiftEnterWorks = false;
    this.reading = null; // {resolve}
    this.sigMemo = { key: null, value: null };
    this.pkgMemo = { dir: null, name: null };
    this.vi = new Vi(this);
    this.decoder = new KeyDecoder((ev) => this.onKey(ev));
    this.onData = (data) => this.decoder.feed(data);
    this.onResize = () => this.resize();
    this.write = (s) => this.realWrite(s);
    this.realWrite = (s) => this.stdout.write(s);
  }

  get theme() {
    return this.shell.theme;
  }

  get viOn() {
    return this.shell.settings.editingMode === 'vi';
  }

  get box() {
    return this.shell.settings.layout === 'box';
  }

  get cols() {
    return Math.max(20, this.stdout.columns || 80);
  }

  get rows() {
    return Math.max(10, this.stdout.rows || 24);
  }

  // ── banner ────────────────────────────────────────────────────────────────

  banner() {
    if (this.box) return this.boxBanner();
    const t = this.theme;
    const out = [''];
    if (this.cols >= 44) out.push(...wordmark(t, 'CINDER:'));
    else out.push('  ' + t.paint('accent.bold', 'CINDER:'));
    out.push('', '  ' + t.paint('faint', `v${VERSION}`), '');
    const rows = [['Node', process.version]];
    const pkg = packageName(process.cwd());
    if (pkg) rows.push(['Package', pkg]);
    rows.push(['Directory', shortPath(process.cwd())]);
    if (this.shell.profile && this.shell.profile.name !== 'default') rows.push(['Profile', this.shell.profile.name]);
    rows.push(['Theme', t.name]);
    const w = Math.max(...rows.map(([k]) => k.length)) + 2;
    for (const [k, v] of rows) out.push('  ' + t.paint('fg', k.padEnd(w)) + t.paint('label', v));
    out.push('', '');
    this.write(out.join('\n'));
  }

  /** The box layout's compact banner: `✦ cinder v0.2.0`, environment and a few hints. */
  boxBanner() {
    const t = this.theme;
    const name = [...'cinder'].map((c, i) => t.paint(i < 2 ? 'accent.bold' : 'accent2', c)).join('');
    const sep = t.paint('faint', '  ·  ');
    const pkg = packageName(process.cwd());
    const env = [t.paint('faint', 'node ') + t.paint('muted', process.version)];
    if (pkg) env.push(t.paint('muted', pkg));
    env.push(t.paint('muted', shortPath(process.cwd())), t.paint('faint', 'theme ') + t.paint('muted', t.name));
    const hints = [['%help', 'commands'], ['obj?', 'inspect'], ['!cmd', 'shell'], ['ctrl+d', 'exit']];
    this.write(['', `  ${t.paint('accent', '✦ ')}${name}${t.paint('faint', `  v${VERSION}`)}`, '', '    ' + env.join(sep),
      '    ' + hints.map(([k, v]) => t.paint('accent', k) + t.paint('faint', ` ${v}`)).join('  '), '', ''].join('\n'));
  }

  // ── reading a cell ────────────────────────────────────────────────────────

  /** Show the prompt and resolve with the submitted text, or null on Ctrl+D. */
  read() {
    const initial = this.shell.nextInput;
    this.shell.nextInput = '';
    this.buffer.reset(initial);
    this.menu = this.search = this.histNav = this.flash = null;
    this.vi.mode = 'insert';
    this.vi.clear();
    return new Promise((resolve) => {
      this.reading = { resolve };
      this.attach();
      this.draw();
    });
  }

  attach() {
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', this.onData);
    this.stdin.resume();
    this.stdout.on('resize', this.onResize);
    this.realWrite(ENABLE_KEYS);
    // Output from timers and promises while you type goes above the prompt.
    this.savedWrites = [process.stdout.write, process.stderr.write];
    const plain = this.savedWrites[0];
    this.realWrite = (s) => plain.call(process.stdout, s);
    const above = (chunk, encoding, cb) => {
      this.printAbove(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      const done = typeof encoding === 'function' ? encoding : cb;
      if (done) process.nextTick(done);
      return true;
    };
    process.stdout.write = above;
    process.stderr.write = above;
    this.shell.onBackgroundOutput = (s) => this.printAbove(s);
  }

  detach() {
    this.stdin.off('data', this.onData);
    this.stdout.off('resize', this.onResize);
    if (this.savedWrites) [process.stdout.write, process.stderr.write] = this.savedWrites;
    this.savedWrites = null;
    this.shell.onBackgroundOutput = null;
    this.realWrite(DISABLE_KEYS + (this.viOn ? '\x1b[0 q' : ''));
    this.realWrite = (s) => this.stdout.write(s);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  finish(result) {
    this.erase();
    this.detach();
    const r = this.reading;
    this.reading = null;
    r?.resolve(result);
  }

  printAbove(text) {
    if (!text) return;
    this.erase();
    this.realWrite(text.endsWith('\n') ? text : text + '\n');
    if (this.reading) this.draw();
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  onKey(ev) {
    if (!this.reading) return;
    try {
      this.handleKey(ev);
    } catch (e) {
      this.flash = { text: `internal error: ${e.message}`, until: Date.now() + 5000 };
    }
    if (this.reading) this.draw();
  }

  handleKey(ev) {
    if (ev.name === 'paste') {
      if (this.viOn && this.vi.mode !== 'insert') this.vi.toInsert();
      return this.paste(ev.text);
    }
    if (this.search) return this.searchKey(ev);
    if (this.viOn) {
      const vi = this.vi;
      if (vi.mode !== 'insert') {
        this.flash = null;
        this.menu = null;
        return vi.key(ev);
      }
      if (vi.recording && !vi.replaying) vi.recording.push(ev);
      if (ev.name === 'escape' && !ev.meta && !ev.ctrl) {
        // Esc closes the menu and leaves insert mode in one go
        if (this.menu) this.cancelMenu();
        return vi.toNormal();
      }
    }
    return this.handleInsert(ev);
  }

  /** Keys in emacs mode and in vi's insert mode. */
  handleInsert(ev) {
    const b = this.buffer;
    const k = keyName(ev);
    if (k !== 'up' && k !== 'down' && k !== 'ctrl+p' && k !== 'ctrl+n') b.goalCol = undefined;
    this.flash = null;

    switch (k) {
      case 'return':
        return this.enter();
      case 'shift+return':
      case 'alt+return':
      case 'ctrl+alt+return':
      case 'ctrl+j':
        if (ev.seq?.startsWith('\x1b[')) this.shiftEnterWorks = true;
        this.menu = null;
        return this.newline();
      case 'tab':
        return ev.shift ? this.shiftTab() : this.tab();
      case 'shift+tab':
        return this.shiftTab();
      case 'escape':
        if (this.menu) this.cancelMenu();
        return undefined;
      case 'backspace':
      case 'ctrl+h':
        return this.backspace();
      case 'alt+backspace':
      case 'ctrl+w':
        this.edited();
        return b.killWordBack();
      case 'delete':
        this.edited();
        return b.deleteForward();
      case 'ctrl+d':
        if (!b.text) return this.finish(null);
        this.edited();
        return b.deleteForward();
      case 'left':
      case 'ctrl+b':
        this.moved();
        return b.left();
      case 'right':
      case 'ctrl+f':
        if (this.acceptSuggestion()) return undefined;
        this.moved();
        return b.right();
      case 'alt+left':
      case 'ctrl+left':
      case 'alt+b':
        this.moved();
        return b.wordLeft();
      case 'alt+right':
      case 'ctrl+right':
      case 'alt+f':
        this.moved();
        return b.wordRight();
      case 'home':
      case 'ctrl+a':
        this.moved();
        return b.home();
      case 'end':
      case 'ctrl+e':
        if (this.acceptSuggestion()) return undefined;
        this.moved();
        return b.end();
      case 'up':
      case 'ctrl+p':
        return this.up();
      case 'down':
      case 'ctrl+n':
        return this.down();
      case 'pageup':
        return this.menu ? this.moveMenu(-MENU_HEIGHT) : undefined;
      case 'pagedown':
        return this.menu ? this.moveMenu(MENU_HEIGHT) : undefined;
      case 'ctrl+k':
        this.edited();
        return b.killToEnd();
      case 'ctrl+u':
        this.edited();
        return b.killToStart();
      case 'alt+d':
        this.edited();
        return b.killWordForward();
      case 'ctrl+y':
        this.edited();
        return b.yank();
      case 'ctrl+_':
      case 'ctrl+/':
        this.edited();
        return b.undo();
      case 'ctrl+c':
        if (b.text) {
          b.reset();
          this.edited();
        } else this.flashFor('press ctrl+d to exit', 2500);
        return undefined;
      case 'ctrl+l':
        this.frame = { rows: 0, cursorRow: 0, widths: [] };
        return this.realWrite('\x1b[2J\x1b[3J\x1b[H');
      case 'ctrl+o':
      case 'f2':
        return this.openEditor();
      case 'ctrl+r':
        return this.startSearch();
      case 'ctrl+z':
        return this.suspend();
      default:
        if (ev.text && !ev.ctrl && !ev.meta) return this.type(ev.text);
        return undefined;
    }
  }

  edited() {
    this.histNav = null;
    this.menu = null;
  }

  moved() {
    this.menu = null;
    this.histNav = null;
  }

  flashFor(text, ms) {
    this.flash = { text, until: Date.now() + ms };
    setTimeout(() => this.reading && this.draw(), ms + 50).unref?.();
  }

  type(ch) {
    const b = this.buffer;
    this.histNav = null;
    // a closing bracket typed in indentation dedents one level
    if ('})]'.includes(ch) && b.beforeCursor.length && !b.beforeCursor.trim()) b.dedent(INDENT.length);
    b.insert(ch);
    if (/[\p{L}\p{N}_$.%/-]/u.test(ch)) this.completeWhileTyping();
    else this.menu = null;
  }

  paste(text) {
    let data = text.replace(/\r\n?/g, '\n');
    if (hasPrompts(data)) data = stripPrompts(data);
    this.edited();
    this.buffer.insert(data, null);
  }

  enter() {
    const b = this.buffer;
    if (this.menu && this.menu.index >= 0) {
      this.menu = null;
      return;
    }
    this.menu = null;
    const text = b.text;
    const atEnd = !text.slice(b.cursor).trim();
    if ((atEnd || !text.includes('\n')) && isComplete(text)) return this.submit();
    // Run an unfinished cell anyway with Enter on two blank lines (to see the syntax error).
    if (atEnd && /\n[ \t]*\n[ \t]*$/.test(text) && text.trim()) return this.submit();
    return this.newline();
  }

  newline() {
    const b = this.buffer;
    this.histNav = null;
    const before = b.beforeCursor;
    if (!before.trim() && before.length) {
      // don't leave trailing indentation on blank lines
      b.snapshot(null);
      b.set(b.text.slice(0, b.lineStart) + b.text.slice(b.cursor), b.lineStart);
    }
    b.insert('\n' + nextIndent(before), null);
  }

  submit() {
    const text = this.buffer.text.replace(/\s+$/, '');
    this.finish(text);
  }

  backspace() {
    const b = this.buffer;
    const before = b.beforeCursor;
    this.histNav = null;
    if (before.length && !before.trim() && !before.includes('\t')) b.deleteBack(before.length % INDENT.length || INDENT.length);
    else b.deleteBack();
    if (this.menu) this.completeWhileTyping();
  }

  tab() {
    const b = this.buffer;
    if (this.menu) return this.moveMenu(1);
    if (!b.beforeCursor.trim()) {
      b.insert(INDENT, null);
      return undefined;
    }
    const res = this.completions();
    if (!res || !res.items.length) return undefined;
    const typed = b.text.slice(res.start, b.cursor);
    if (res.items.length === 1) {
      b.snapshot(null);
      b.set(b.text.slice(0, res.start) + res.items[0].text + b.text.slice(b.cursor), res.start + res.items[0].text.length);
      return undefined;
    }
    const common = commonPrefix(res.items);
    if (common.length > typed.length) {
      b.snapshot(null);
      b.set(b.text.slice(0, res.start) + common + b.text.slice(b.cursor), res.start + common.length);
      this.menu = { start: res.start, items: res.items, index: -1, inserted: common.length };
      return undefined;
    }
    this.menu = { start: res.start, items: res.items, index: -1, inserted: typed.length };
    return this.moveMenu(1);
  }

  shiftTab() {
    if (this.menu) return this.moveMenu(-1);
    this.buffer.dedent(INDENT.length);
    return undefined;
  }

  completions() {
    try {
      return complete(this.buffer.text, this.buffer.cursor, this.shell);
    } catch {
      return null;
    }
  }

  completeWhileTyping() {
    const res = this.completions();
    const typed = res ? this.buffer.text.slice(res.start, this.buffer.cursor) : '';
    // plain names wait for two characters; after `.`, `%` or inside a path, show right away
    const tooEarly = res && typed.length < 2 && !/[.%/'"`]/.test(this.buffer.text[res.start - 1] ?? '');
    if (!res || tooEarly || !res.items.length || (res.items.length === 1 && res.items[0].text === typed)) {
      this.menu = null;
      return;
    }
    this.menu = { start: res.start, items: res.items, index: -1, inserted: typed.length, typed };
  }

  /** Select another item, writing it into the buffer as prompt_toolkit does. */
  moveMenu(delta) {
    const m = this.menu;
    const b = this.buffer;
    if (m.typed === undefined) m.typed = b.text.slice(m.start, m.start + m.inserted);
    const n = m.items.length;
    let i = m.index + delta;
    if (m.index === -1 && delta < 0) i = n - 1;
    i = ((i % n) + n) % n;
    if (Math.abs(delta) > 1) i = Math.max(0, Math.min(n - 1, m.index + delta));
    m.index = i;
    const text = m.items[i].text;
    b.set(b.text.slice(0, m.start) + text + b.text.slice(m.start + m.inserted), m.start + text.length);
    m.inserted = text.length;
  }

  cancelMenu() {
    const m = this.menu;
    const b = this.buffer;
    if (m.index >= 0 && m.typed !== undefined) {
      b.set(b.text.slice(0, m.start) + m.typed + b.text.slice(m.start + m.inserted), m.start + m.typed.length);
    }
    this.menu = null;
  }

  up() {
    const b = this.buffer;
    // an untouched menu (shown while typing) doesn't capture ↑: history does
    if (this.menu && this.menu.index >= 0) return this.moveMenu(-1);
    this.menu = null;
    if (b.isMultiline && !b.onFirstLine && !this.histNav) return b.up();
    return this.historyStep(1);
  }

  down() {
    const b = this.buffer;
    if (this.menu) return this.moveMenu(1);
    if (b.isMultiline && !b.onLastLine && !this.histNav) return b.down();
    if (this.histNav) return this.historyStep(-1);
    return undefined;
  }

  /** Walk history entries that start with what you had typed. +1 older, -1 newer. */
  historyStep(dir) {
    const b = this.buffer;
    if (!this.histNav) {
      if (dir < 0) return undefined;
      this.histNav = { prefix: b.text, index: -1, original: b.text, list: this.shell.history.recentInputs() };
    }
    const h = this.histNav;
    let i = h.index;
    for (;;) {
      i += dir;
      if (i < 0) {
        b.set(h.original);
        this.histNav = null;
        return undefined;
      }
      if (i >= h.list.length) return undefined;
      const entry = h.list[i];
      if (entry.startsWith(h.prefix) && entry !== b.text) break;
    }
    h.index = i;
    b.set(h.list[i]);
    return undefined;
  }

  suggestion() {
    const b = this.buffer;
    if (!b.text || b.cursor !== b.text.length || this.menu || this.search || this.histNav) return '';
    if (this.viOn && this.vi.mode !== 'insert') return '';
    for (const entry of this.shell.history.recentInputs(2000)) {
      if (entry.length > b.text.length && entry.startsWith(b.text)) return entry.slice(b.text.length);
    }
    return '';
  }

  acceptSuggestion() {
    const s = this.suggestion();
    if (!s) return false;
    this.buffer.insert(s, null);
    return true;
  }

  // ── history search (Ctrl+R) ───────────────────────────────────────────────

  startSearch() {
    this.menu = null;
    this.search = { query: '', index: -1, original: this.buffer.text, list: this.shell.history.recentInputs(), failed: false };
  }

  findMatch(from, dir) {
    const s = this.search;
    if (!s.query) return -1;
    for (let i = from + dir; i >= 0 && i < s.list.length; i += dir) if (s.list[i].includes(s.query)) return i;
    return -1;
  }

  showMatch() {
    const s = this.search;
    if (s.index >= 0) {
      const entry = s.list[s.index];
      this.buffer.set(entry, entry.indexOf(s.query));
    } else if (!s.query) this.buffer.set(s.original);
  }

  searchKey(ev) {
    const s = this.search;
    const k = keyName(ev);
    if (k === 'escape' || k === 'ctrl+g' || k === 'ctrl+c') {
      this.buffer.set(s.original);
      this.search = null;
      return;
    }
    if (k === 'ctrl+r' || k === 'ctrl+s') {
      const i = this.findMatch(s.index, k === 'ctrl+r' ? 1 : -1);
      if (i !== -1) s.index = i;
      s.failed = i === -1;
      this.showMatch();
      return;
    }
    if (k === 'backspace') {
      s.query = s.query.slice(0, -1);
      s.index = this.findMatch(-1, 1);
      s.failed = s.query && s.index === -1;
      this.showMatch();
      return;
    }
    if (ev.text && !ev.ctrl && !ev.meta) {
      s.query += ev.text;
      const i = this.findMatch(Math.max(-1, s.index - 1), 1);
      s.failed = i === -1;
      if (i !== -1) s.index = i;
      this.showMatch();
      return;
    }
    // any other key accepts the match and then does its usual job
    this.search = null;
    if (k !== 'return') this.handleKey(ev);
  }

  // ── editor, suspend, resize ───────────────────────────────────────────────

  openEditor() {
    const file = path.join(os.tmpdir(), `cinder-${process.pid}.js`);
    fs.writeFileSync(file, this.buffer.text);
    this.erase();
    this.detach();
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const r = spawnSync(`${editor} ${JSON.stringify(file)}`, { stdio: 'inherit', shell: true });
    let text = this.buffer.text;
    try {
      text = fs.readFileSync(file, 'utf8').replace(/\s+$/, '');
      fs.unlinkSync(file);
    } catch {
      // keep what we had
    }
    this.buffer.snapshot(null);
    this.buffer.set(text);
    this.attach();
    if (r.error || r.status) this.flashFor(`editor ${editor} failed`, 4000);
  }

  suspend() {
    this.erase();
    this.detach();
    process.once('SIGCONT', () => {
      this.attach();
      this.draw();
    });
    process.kill(process.pid, 'SIGTSTP');
  }

  resize() {
    // Lines of the old frame may have wrapped at the new width: work out where its top is now.
    const cols = this.cols;
    let up = 0;
    for (let i = 0; i < this.frame.cursorRow; i++) up += Math.max(1, Math.ceil((this.frame.widths[i] || 1) / cols));
    this.frame.cursorRow = up;
    this.draw();
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  erase() {
    if (!this.frame.rows) return;
    const up = this.frame.cursorRow;
    this.realWrite((up ? `\x1b[${up}A` : '') + '\r\x1b[J');
    this.frame = { rows: 0, cursorRow: 0, widths: [] };
  }

  draw() {
    const { lines, cursorRow, cursorCol } = this.render();
    let out = '\x1b[?2026h\x1b[?25l';
    if (this.frame.rows && this.frame.cursorRow) out += `\x1b[${this.frame.cursorRow}A`;
    out += '\r\x1b[J' + lines.join('\r\n');
    const up = lines.length - 1 - cursorRow;
    if (up > 0) out += `\x1b[${up}A`;
    out += '\r' + (cursorCol > 0 ? `\x1b[${cursorCol}C` : '');
    if (this.viOn) out += { insert: '\x1b[6 q', replace: '\x1b[4 q' }[this.vi.mode] ?? '\x1b[2 q'; // bar · underline · block
    out += '\x1b[?25h\x1b[?2026l';
    this.realWrite(out);
    this.frame = { rows: lines.length, cursorRow, widths: lines.map((l) => textWidth(l)) };
  }

  /** Build the frame: {lines, cursorRow, cursorCol}. Two layouts: block (a filled bar) and box (a rounded box). */
  render() {
    const t = this.theme;
    const W = this.cols;
    const box = this.box;
    const B = box ? (style, text) => t.paint(style ?? 'fg', text) : (style, text) => t.paint(style ?? 'fg', text, 'bar');
    const b = this.buffer;
    const text = b.text;
    const counter = box ? '' : `  [${this.shell.count + 1}]`;
    const textW = Math.max(8, W - 4 - 2 - counter.length);

    // wrap logical lines into visual rows: [{row, start, end}] with absolute indexes
    const rowsV = [];
    let offset = 0;
    for (const [row, line] of text.split('\n').entries()) {
      let start = 0;
      let w = 0;
      for (let i = 0; i < line.length; ) {
        const ch = String.fromCodePoint(line.codePointAt(i));
        const cw = charWidth(ch);
        if (w + cw > textW) {
          rowsV.push({ row, start: offset + start, end: offset + i, wrapped: start > 0 });
          start = i;
          w = 0;
        }
        w += cw;
        i += ch.length;
      }
      rowsV.push({ row, start: offset + start, end: offset + line.length, wrapped: start > 0, last: true });
      offset += line.length + 1;
    }
    let curV = rowsV.findIndex((r) => b.cursor >= r.start && (b.cursor < r.end || (b.cursor === r.end && r.last)));
    if (curV === -1) curV = rowsV.length - 1;
    const cur = rowsV[curV];
    const curCol = textWidth(text.slice(cur.start, b.cursor));

    // viewport
    const maxRows = Math.max(3, Math.min(16, this.rows - 10));
    let top = 0;
    if (rowsV.length > maxRows) top = Math.min(Math.max(0, curV - Math.floor(maxRows / 2)), rowsV.length - maxRows);
    const visible = rowsV.slice(top, top + maxRows);

    // per-character styles
    const styles = styleMap(text);
    const pair = matchBracket(text, b.cursor) ?? (b.cursor > 0 ? matchBracket(text, b.cursor - 1) : null);
    const special = new Map();
    if (pair) for (const i of pair) special.set(i, 'bracket.match');
    if (this.search?.query && this.search.index >= 0) {
      const at = text.indexOf(this.search.query);
      for (let i = at; at >= 0 && i < at + this.search.query.length; i++) special.set(i, 'search.match');
    }
    const sel = this.viOn ? this.vi.selection() : null;
    if (sel) for (let i = sel[0]; i < sel[1]; i++) special.set(i, 'selection');
    const suggestion = this.suggestion();

    const border = (ch) => t.paint(text ? 'faint' : 'border', ch);
    const lines = [box ? this.boxTop(W) : B('fg', ' '.repeat(W))];
    visible.forEach((r, k) => {
      const first = r.row === 0 && !r.wrapped;
      let prefix;
      if (r.wrapped) prefix = B('bar.cont', '  ');
      else prefix = first ? B('bar.prompt', box ? '❯ ' : '> ') : B('bar.cont', '· ');
      let body = '';
      const seg = text.slice(r.start, r.end);
      if (special.size) {
        for (let i = r.start; i < r.end; i++) {
          const sp = special.get(i);
          body += sp ? t.paint(sp, text[i]) : B(styles[i], text[i]);
        }
      } else {
        for (const [style, chunk] of runs(seg, styles, r.start)) body += B(style, chunk);
      }
      let used = textWidth(seg);
      if (!text && k === 0) {
        const hint = truncate('Type JavaScript…  %help for help', textW);
        body += B('placeholder', hint);
        used += textWidth(hint);
      }
      if (suggestion && r.end === text.length && r.last) {
        const firstLine = suggestion.split('\n')[0] + (suggestion.includes('\n') ? ' …' : '');
        const shown = truncate(firstLine, Math.max(0, textW - used));
        body += B('suggestion', shown);
        used += textWidth(shown);
      }
      const fill = B('fg', ' '.repeat(Math.max(0, textW - used)));
      if (box) lines.push(border('│') + ' ' + prefix + body + fill + ' ' + border('│'));
      else {
        const right = top + k === 0 ? B('bar.count', counter) : B('fg', ' '.repeat(counter.length));
        lines.push(B('fg', '  ') + prefix + body + fill + right + B('fg', '  '));
      }
    });
    if (rowsV.length > maxRows) {
      const more = truncate(`  ${top} above · ${rowsV.length - top - visible.length} below`, W - 4).padEnd(W - 4);
      lines.push(box ? border('│') + ' ' + t.paint('faint', more) + ' ' + border('│') : B('fg', '  ') + B('bar.cont', more) + B('fg', '  '));
    }
    lines.push(box ? border('╰' + '─'.repeat(W - 2) + '╯') : B('fg', ' '.repeat(W)));
    const cursorRow = 1 + (curV - top);
    let cursorCol = 4 + curCol;

    const below = [];
    let searchRow = -1;
    if (this.search) {
      const s = this.search;
      searchRow = lines.length;
      const label = s.failed ? 'failing search ↑ ' : 'search ↑ ';
      below.push('  ' + t.paint('search.prompt', label) + t.paint('fg', s.query));
    }
    if (this.menu) below.push(...this.renderMenu(4 + textWidth(text.slice(cur.start, Math.max(cur.start, this.menu.start)))));
    if (box) below.push('', this.statusLine());
    else below.push('', this.keybar(), '', this.modeline());
    for (const l of below) lines.push(truncateAnsi(l, W - 1));
    if (searchRow >= 0) {
      return { lines, cursorRow: searchRow, cursorCol: 2 + textWidth(this.search.failed ? 'failing search ↑ ' : 'search ↑ ') + textWidth(this.search.query) };
    }
    cursorCol = Math.min(cursorCol, W - 1);
    return { lines, cursorRow, cursorCol };
  }

  /** `╭─ In [4] ─────────── NORMAL · 3 lines ─╮` */
  boxTop(W) {
    const t = this.theme;
    const b = this.buffer;
    const style = b.text ? 'faint' : 'border';
    const title = t.paint(style, '╭─ ') + t.paint('accent.bold', `In [${this.shell.count + 1}]`) + t.paint(style, ' ');
    const tags = [];
    if (this.viOn) tags.push(this.vi.label());
    const n = b.text.split('\n').length;
    if (n > 1) tags.push(`${n} lines`);
    const right = tags.length ? t.paint('faint', ` ${tags.join(' · ')} `) + t.paint(style, '─╮') : t.paint(style, '╮');
    const fill = Math.max(0, W - textWidth(title) - textWidth(right));
    return title + t.paint(style, '─'.repeat(fill)) + right;
  }

  /** The box layout's single status line: environment (or the signature) left, key hints right. */
  statusLine() {
    const t = this.theme;
    const width = this.cols - 2;
    let left;
    const sig = this.signature();
    if (this.flash && Date.now() < this.flash.until) left = t.paint('warn', this.flash.text);
    else if (sig) left = renderSignature(sig, width, t);
    else left = t.paint('accent', '● ') + this.modeline().trimStart();
    const hints = this.hints();
    const render = (hs) => hs.map(([k, label]) => t.paint('fg', k) + (label ? t.paint('faint', ` ${label}`) : '')).join(t.paint('faint', '   '));
    const leftW = textWidth(left);
    if (leftW > width) return ' ' + truncateAnsi(left, width);
    while (hints.length && leftW + 4 + textWidth(render(hints)) > width) hints.pop();
    const right = render(hints);
    return ' ' + left + ' '.repeat(Math.max(1, width - leftW - textWidth(right))) + right;
  }

  hints() {
    if (this.search) return [['⏎', 'accept'], ['ctrl+r', 'older'], ['esc', 'cancel']];
    if (this.menu) return [['tab', 'next'], ['⏎', 'accept'], ['esc', 'close']];
    const text = this.buffer.text;
    if (this.viOn && this.vi.mode !== 'insert') return [['i', 'insert'], ['⏎', 'run'], ['u', 'undo'], ['/', 'history']];
    if (text.trim() && !isComplete(text)) return [['⏎', 'newline'], ['⏎ on 2 blank lines', 'run'], ['ctrl+o', 'editor']];
    if (!text) return [['%help', ''], ['obj?', 'inspect'], ['ctrl+d', 'exit'], ['ctrl+r', 'history']];
    return [['⏎', 'run'], [this.shiftEnterWorks ? 'shift+⏎' : 'alt+⏎', 'newline'], ['ctrl+o', 'editor']];
  }

  renderMenu(anchor) {
    const t = this.theme;
    const m = this.menu;
    const W = this.cols;
    const n = m.items.length;
    const height = Math.min(MENU_HEIGHT, n, Math.max(3, this.rows - 12));
    const sel = m.index;
    let top = 0;
    if (sel >= height) top = sel - height + 1;
    const view = m.items.slice(top, top + height);
    const nameW = Math.min(32, Math.max(...m.items.slice(0, 200).map((i) => textWidth(i.display))));
    const metaW = Math.min(22, Math.max(0, ...m.items.slice(0, 200).map((i) => textWidth(i.meta ?? ''))));
    const rowW = 3 + nameW + (metaW ? 2 + metaW : 0) + 1 + (n > height ? 1 : 0);
    const x = Math.max(0, Math.min(anchor - 2, W - rowW - 1));
    const thumbAt = n > height ? Math.floor((top / Math.max(1, n - height)) * (height - 1)) : -1;
    return view.map((it, k) => {
      const current = top + k === sel;
      const bg = current ? 'menu.current' : 'menu';
      const icon = t.paint(current ? 'menu.current' : `icon.${it.kind}`, ` ${ICONS[it.kind] ?? '●'} `, current ? undefined : 'surface');
      const name = t.paint(bg, truncate(it.display, nameW).padEnd(nameW));
      const meta = metaW ? t.paint(current ? 'menu.meta.current' : 'menu.meta', '  ' + truncate(it.meta ?? '', metaW).padEnd(metaW)) : '';
      const scroll = n > height ? t.paint('menu.meta', k === thumbAt ? '▐' : ' ') : '';
      return ' '.repeat(x) + icon + name + meta + t.paint(bg, ' ') + scroll;
    });
  }

  keybarItems() {
    if (this.search) return [['ACCEPT', 'Enter'], ['OLDER', 'Ctrl+R'], ['NEWER', 'Ctrl+S'], ['CANCEL', 'Esc']];
    if (this.menu) return [['NEXT', 'Tab'], ['ACCEPT', 'Enter'], ['CLOSE', 'Esc']];
    const text = this.buffer.text;
    const items = [];
    if (this.viOn) {
      const mode = this.vi.mode;
      if (mode === 'visual' || mode === 'vline') return [['DELETE', 'd'], ['YANK', 'y'], ['CHANGE', 'c'], ['INDENT', '> <'], ['CANCEL', 'Esc']];
      if (mode === 'insert') items.push(['NORMAL MODE', 'Esc']);
      else items.push(['INSERT MODE', 'i']);
    }
    if (text.trim() && !isComplete(text)) {
      if (text.trimStart().startsWith('%%')) items.push(['NEWLINE', 'Enter'], ['RUN', 'Enter on a blank line']);
      else items.push(['NEWLINE', 'Enter'], ['RUN ANYWAY', 'Enter on 2 blank lines']);
    } else {
      items.push(['RUN', 'Enter'], ['NEWLINE', this.shiftEnterWorks ? 'Shift+Enter' : 'Alt+Enter']);
    }
    items.push(['EXIT', 'Ctrl+D'], ['EDITOR', 'Ctrl+O'], ['SHELL', '!cmd'], ['HELP', '%help']);
    return items; // least important last: dropped first on narrow terminals
  }

  keybar() {
    const t = this.theme;
    const width = this.cols - 4;
    const sig = this.signature();
    if (sig) return '  ' + renderSignature(sig, width, t);
    const items = this.keybarItems();
    const render = (entries) => '  ' + entries.map(([label, k]) => t.paint('keybar.label', label) + t.paint('keybar.key', `: ${k}`)).join(t.paint('keybar.sep', '  |  '));
    while (items.length > 1 && textWidth(render(items)) > width + 2) items.pop();
    return render(items);
  }

  signature() {
    const b = this.buffer;
    if (!b.text.includes('(') || this.search) return null;
    const key = `${b.text}\u0000${b.cursor}`;
    if (this.sigMemo.key === key) return this.sigMemo.value;
    let value = null;
    try {
      value = signatureAt(b.text, b.cursor, this.shell.In);
    } catch {
      value = null;
    }
    this.sigMemo = { key, value };
    return value;
  }

  modeline() {
    const t = this.theme;
    const sep = t.paint('status.sep', '  ·  ');
    const mode = this.viOn && !this.box ? t.paint('label', `[${this.vi.label()}]`) + '  ' : '  ';
    if (this.flash && Date.now() < this.flash.until) return mode + t.paint('warn', this.flash.text);
    const parts = [t.paint('status', `node ${process.version}`)];
    const dir = process.cwd();
    if (this.pkgMemo.dir !== dir) this.pkgMemo = { dir, name: packageName(dir) };
    if (this.pkgMemo.name) parts.push(t.paint('status', this.pkgMemo.name));
    parts.push(t.paint('status', shortPath(dir)));
    const sh = this.shell;
    if (sh.lastDuration !== null) {
      parts.push((sh.lastOk ? t.paint('ok', '✓ ') : t.paint('err', '✗ ')) + t.paint('status', formatDuration(sh.lastDuration)));
    }
    if (sh.theme.name !== 'void') parts.push(t.paint('status.dim', sh.theme.name));
    if (sh.settings.autoreload) parts.push(t.paint('status.dim', 'autoreload'));
    return mode + parts.join(sep);
  }

  // ── main loop ─────────────────────────────────────────────────────────────

  async run() {
    const shell = this.shell;
    this.banner();
    const onSigint = () => shell.interrupt();
    process.on('SIGINT', onSigint);
    let code = 0;
    try {
      for (;;) {
        const text = await this.read();
        if (text === null) break;
        try {
          await shell.runCell(text);
        } catch (e) {
          if (e instanceof ExitRequest) {
            code = typeof e.code === 'number' ? e.code : 0;
            break;
          }
          throw e;
        }
      }
    } finally {
      process.off('SIGINT', onSigint);
      shell.close();
    }
    this.write(this.theme.paint('faint', '  goodbye ✦') + '\n');
    return code;
  }
}
