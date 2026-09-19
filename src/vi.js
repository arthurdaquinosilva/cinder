// vi key bindings for the input: normal, insert, replace and visual modes, with counts, operators
// (d c y > <), motions, text objects, registers, undo/redo and `.` to repeat the last change.
// Insert mode keeps the usual editing keys; the Repl hands every other mode's keys to Vi.key().

import { INDENT } from './transform.js';

const WORD = /[\p{L}\p{N}_$]/u;
const PAIRS = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };

function cls(c, big) {
  if (c === undefined || /\s/.test(c)) return 0;
  if (big) return 1;
  return WORD.test(c) ? 1 : 2;
}

// ── positions in the text ────────────────────────────────────────────────────

export function lineStart(t, i) {
  return t.lastIndexOf('\n', i - 1) + 1;
}

export function lineEnd(t, i) {
  const n = t.indexOf('\n', i);
  return n === -1 ? t.length : n;
}

function firstNonBlank(t, i) {
  let j = lineStart(t, i);
  while (j < t.length && (t[j] === ' ' || t[j] === '\t')) j++;
  return j;
}

export function wordForward(t, i, big) {
  const n = t.length;
  const c = cls(t[i], big);
  if (c) while (i < n && cls(t[i], big) === c) i++;
  while (i < n && cls(t[i], big) === 0) i++;
  return i;
}

export function wordBack(t, i, big) {
  if (i > 0) i--;
  while (i > 0 && cls(t[i], big) === 0) i--;
  const c = cls(t[i], big);
  while (i > 0 && cls(t[i - 1], big) === c) i--;
  return i;
}

export function wordEnd(t, i, big) {
  const n = t.length;
  if (i < n - 1) i++;
  while (i < n - 1 && cls(t[i], big) === 0) i++;
  const c = cls(t[i], big);
  while (i < n - 1 && cls(t[i + 1], big) === c) i++;
  return i;
}

function matchPair(t, i) {
  // from the cursor, find the first bracket on the line, then its partner
  const end = lineEnd(t, i);
  while (i < end && !PAIRS[t[i]]) i++;
  if (!PAIRS[t[i]]) return null;
  const open = '([{'.includes(t[i]);
  const me = t[i];
  const other = PAIRS[me];
  let depth = 0;
  for (let j = i; open ? j < t.length : j >= 0; j += open ? 1 : -1) {
    if (t[j] === me) depth++;
    else if (t[j] === other && --depth === 0) return j;
  }
  return null;
}

/** Text object range [start, end) for iw/aw/i(/a(/i"/a"… at index i, or null. */
export function textObject(t, i, inner, ch) {
  if (ch === 'w' || ch === 'W') {
    const big = ch === 'W';
    const c = cls(t[i], big);
    let a = i;
    let b = i;
    const same = (k) => (c === 0 ? /[ \t]/.test(t[k] ?? '') : cls(t[k], big) === c);
    while (a > lineStart(t, i) && same(a - 1)) a--;
    while (b < lineEnd(t, i) && same(b)) b++;
    if (!inner) while (b < lineEnd(t, i) && /[ \t]/.test(t[b])) b++;
    return [a, b];
  }
  const quote = { '"': '"', "'": "'", '`': '`' }[ch];
  if (quote) {
    const s = lineStart(t, i);
    const e = lineEnd(t, i);
    const positions = [];
    for (let k = s; k < e; k++) if (t[k] === quote && t[k - 1] !== '\\') positions.push(k);
    for (let k = 0; k + 1 < positions.length; k += 2) {
      const [a, b] = [positions[k], positions[k + 1]];
      if ((i >= a && i <= b) || i < a) return inner ? [a + 1, b] : [a, b + 1];
    }
    return null;
  }
  const open = { '(': '(', ')': '(', b: '(', '[': '[', ']': '[', '{': '{', '}': '{', B: '{', '<': '<', '>': '<' }[ch];
  if (!open) return null;
  const close = { '(': ')', '[': ']', '{': '}', '<': '>' }[open];
  let depth = 0;
  let a = -1;
  for (let k = i; k >= 0; k--) {
    if (t[k] === close && k !== i) depth++;
    else if (t[k] === open) {
      if (depth === 0) {
        a = k;
        break;
      }
      depth--;
    }
  }
  if (a === -1) return null;
  depth = 0;
  for (let k = a + 1; k < t.length; k++) {
    if (t[k] === open) depth++;
    else if (t[k] === close) {
      if (depth === 0) return inner ? [a + 1, k] : [a, k + 1];
      depth--;
    }
  }
  return null;
}

// ── the state machine ─────────────────────────────────────────────────────────

const CHANGES = new Set(['d', 'c', 'y', 'x', 'X', 's', 'S', 'r', '~', 'p', 'P', 'J', 'o', 'O', 'i', 'a', 'I', 'A', 'R', 'C', 'D', '>', '<']);

export class Vi {
  constructor(repl) {
    this.repl = repl;
    this.mode = 'insert';
    this.register = { text: '', linewise: false };
    this.lastFind = null; // [kind, char]
    this.lastChange = null;
    this.recording = null;
    this.replaying = false;
    this.anchor = 0; // visual mode start
    this.clear();
  }

  get b() {
    return this.repl.buffer;
  }

  clear() {
    this.count = '';
    this.op = null; // {name, count}
    this.pending = null; // 'f', 'F', 't', 'T', 'r', 'g', 'i', 'a' (text object after an operator)
  }

  label() {
    return { insert: 'INSERT', normal: 'NORMAL', visual: 'VISUAL', vline: 'VISUAL LINE', replace: 'REPLACE' }[this.mode];
  }

  /** Enter normal mode (Esc from insert moves the cursor back one, as vi does). */
  toNormal() {
    const b = this.b;
    if (this.mode === 'insert' || this.mode === 'replace') {
      if (b.cursor > lineStart(b.text, b.cursor)) b.cursor--;
    }
    this.mode = 'normal';
    this.clear();
    this.clamp();
    this.finishRecording();
  }

  toInsert() {
    this.mode = 'insert';
    this.clear();
  }

  /** In normal mode the cursor sits on a character, never after the end of a line. */
  clamp() {
    const b = this.b;
    const s = lineStart(b.text, b.cursor);
    const e = lineEnd(b.text, b.cursor);
    if (b.cursor >= e && e > s) b.cursor = e - 1;
  }

  startRecording(ev) {
    if (this.replaying || this.recording) return;
    this.recording = [ev];
  }

  finishRecording() {
    if (this.recording && this.mode === 'normal' && !this.op && !this.pending) {
      this.lastChange = this.recording;
      this.recording = null;
    }
  }

  repeat() {
    if (!this.lastChange) return;
    this.replaying = true;
    try {
      for (const ev of this.lastChange) this.repl.handleKey(ev);
      if (this.mode !== 'normal') this.toNormal();
    } finally {
      this.replaying = false;
    }
  }

  /** Handle a key outside insert mode. */
  key(ev) {
    try {
      this.dispatch(ev);
    } finally {
      this.finishRecording();
    }
  }

  dispatch(ev) {
    const ch = ev.text ?? (ev.name === 'escape' ? 'Esc' : ev.name === 'return' ? 'Enter' : ev.name === 'backspace' ? 'BS' : null);
    const name = ev.ctrl ? `C-${ev.name}` : ch ?? ev.name;
    if (this.recording && !this.replaying && this.recording[this.recording.length - 1] !== ev) this.recording.push(ev);
    if (name === 'Esc' || name === 'C-c') {
      if (this.mode === 'replace') this.toNormal();
      else if (this.mode !== 'normal') this.exitVisual();
      this.clear();
      this.recording = null;
      return;
    }
    if (this.mode === 'replace') return this.replaceKey(ev, name);
    if (this.pending) return this.pendingKey(name);
    if (/^[1-9]$/.test(name) || (name === '0' && this.count)) {
      this.count += name;
      return;
    }
    if (this.mode === 'normal' && !this.op && CHANGES.has(name)) this.startRecording(ev);
    const count = Math.max(1, Number(this.count || 1)) * (this.op?.count ?? 1);
    this.count = '';
    if (this.handleMotion(name, count)) return;
    if (this.mode === 'visual' || this.mode === 'vline') return this.visualCommand(name);
    this.command(name, count, ev);
  }

  replaceKey(ev, name) {
    const b = this.b;
    if (name === 'BS') {
      b.left();
      return;
    }
    if (name === 'Enter') return this.repl.handleInsert(ev);
    if (ev.text) {
      b.snapshot('replace');
      const at = b.cursor;
      const over = at < b.text.length && b.text[at] !== '\n' ? 1 : 0;
      b.text = b.text.slice(0, at) + ev.text + b.text.slice(at + over);
      b.cursor = at + ev.text.length;
    } else {
      this.repl.handleInsert(ev);
    }
  }

  pendingKey(name) {
    const kind = this.pending;
    this.pending = null;
    const b = this.b;
    if (kind === 'r') {
      if (name.length !== 1 || b.cursor >= lineEnd(b.text, b.cursor)) return;
      b.snapshot(null);
      b.text = b.text.slice(0, b.cursor) + name + b.text.slice(b.cursor + 1);
      return;
    }
    if (kind === 'g') {
      if (name === 'g') this.applyMotion(() => ({ to: this.b.indexOf(0, 0), linewise: true }));
      else if (name === '~' || name === 'u' || name === 'U') this.clear();
      return;
    }
    if (kind === 'i' || kind === 'a') {
      const range = textObject(b.text, b.cursor, kind === 'i', name);
      if (range) this.operate(range[0], range[1], false);
      else this.clear();
      return;
    }
    // f F t T
    if (name.length !== 1) return this.clear();
    this.lastFind = [kind, name];
    const count = Math.max(1, Number(this.count || 1)) * (this.op?.count ?? 1);
    this.count = '';
    this.applyMotion(() => this.find(kind, name, count));
  }

  find(kind, ch, count) {
    const t = this.b.text;
    let i = this.b.cursor;
    const s = lineStart(t, i);
    const e = lineEnd(t, i);
    const forward = kind === 'f' || kind === 't';
    for (let n = 0; n < count; n++) {
      let j = forward ? i + 1 + (kind === 't' && n === 0 ? 1 : 0) : i - 1 - (kind === 'T' && n === 0 ? 1 : 0);
      while (j >= s && j < e && t[j] !== ch) j += forward ? 1 : -1;
      if (j < s || j >= e) return null;
      i = j;
    }
    if (kind === 't') i--;
    if (kind === 'T') i++;
    return { to: i, inclusive: forward };
  }

  /** Motions: move the cursor, or with a pending operator, act on the text they cover. */
  handleMotion(name, count) {
    const t = () => this.b.text;
    const cur = () => this.b.cursor;
    const repeat = (fn) => () => {
      let i = cur();
      for (let n = 0; n < count; n++) i = fn(i);
      return { to: i };
    };
    const motions = {
      h: () => ({ to: Math.max(lineStart(t(), cur()), cur() - count) }),
      BS: () => ({ to: Math.max(0, cur() - count) }),
      left: () => ({ to: Math.max(lineStart(t(), cur()), cur() - count) }),
      l: () => ({ to: Math.min(lineEnd(t(), cur()), cur() + count), clampLine: true }),
      right: () => ({ to: Math.min(lineEnd(t(), cur()), cur() + count), clampLine: true }),
      ' ': () => ({ to: Math.min(t().length, cur() + count) }),
      w: () => {
        if (this.op?.name === 'c' && cls(t()[cur()]) !== 0) return { ...repeat((i) => wordEnd(t(), i, false))(), inclusive: true };
        return repeat((i) => wordForward(t(), i, false))();
      },
      W: () => {
        if (this.op?.name === 'c' && cls(t()[cur()], true) !== 0) return { ...repeat((i) => wordEnd(t(), i, true))(), inclusive: true };
        return repeat((i) => wordForward(t(), i, true))();
      },
      b: repeat((i) => wordBack(t(), i, false)),
      B: repeat((i) => wordBack(t(), i, true)),
      e: () => ({ ...repeat((i) => wordEnd(t(), i, false))(), inclusive: true }),
      E: () => ({ ...repeat((i) => wordEnd(t(), i, true))(), inclusive: true }),
      0: () => ({ to: lineStart(t(), cur()) }),
      home: () => ({ to: lineStart(t(), cur()) }),
      '^': () => ({ to: firstNonBlank(t(), cur()) }),
      $: () => {
        let i = cur();
        for (let n = 1; n < count; n++) i = Math.min(t().length, lineEnd(t(), i) + 1);
        return { to: Math.max(lineStart(t(), i), lineEnd(t(), i) - (this.op ? 0 : 1)), inclusive: false, end: true, toEnd: lineEnd(t(), i) };
      },
      end: () => ({ to: lineEnd(t(), cur()), end: true }),
      '%': () => {
        const j = matchPair(t(), cur());
        return j === null ? null : { to: j, inclusive: true };
      },
      G: () => ({ to: this.b.indexOf(this.countGiven ? count - 1 : Infinity, 0), linewise: true }),
      j: () => this.lineMotion(count),
      k: () => this.lineMotion(-count),
      down: () => this.lineMotion(count),
      up: () => this.lineMotion(-count),
      '+': () => ({ ...this.lineMotion(count), toFirst: true }),
      '-': () => ({ ...this.lineMotion(-count), toFirst: true }),
      ';': () => (this.lastFind ? this.find(this.lastFind[0], this.lastFind[1], count) : null),
      ',': () => {
        if (!this.lastFind) return null;
        const flip = { f: 'F', F: 'f', t: 'T', T: 't' }[this.lastFind[0]];
        return this.find(flip, this.lastFind[1], count);
      },
    };
    if ('fFtT'.includes(name) && name.length === 1) {
      this.pending = name;
      this.count = String(count === 1 ? '' : count);
      return true;
    }
    if (name === 'g') {
      this.pending = 'g';
      return true;
    }
    if (this.op && (name === 'i' || name === 'a')) {
      this.pending = name;
      return true;
    }
    this.countGiven = count > 1;
    const fn = motions[name];
    if (!fn) return false;
    // j/k at the first/last line walk history instead (normal mode, no operator)
    if (!this.op && this.mode === 'normal' && ['j', 'k', 'up', 'down'].includes(name)) {
      const b = this.b;
      const goingDown = name === 'j' || name === 'down';
      if ((goingDown && b.onLastLine) || (!goingDown && b.onFirstLine)) {
        if (goingDown) this.repl.down();
        else this.repl.up();
        b.cursor = lineStart(b.text, b.cursor);
        return true;
      }
    }
    this.applyMotion(fn);
    return true;
  }

  lineMotion(delta) {
    const b = this.b;
    const [row, col] = b.rowCol();
    const target = Math.max(0, Math.min(b.lines.length - 1, row + delta));
    return { to: b.indexOf(target, b.goalCol ?? col), linewise: true, keepGoal: true, goal: b.goalCol ?? col };
  }

  applyMotion(fn) {
    const b = this.b;
    const m = fn();
    if (!m) return this.clear();
    if (this.op) {
      const from = b.cursor;
      if (m.linewise) return this.operateLines(from, m.to);
      let [a, z] = from <= m.to ? [from, m.to] : [m.to, from];
      if (m.inclusive && from <= m.to) z++;
      if (m.inclusive && from > m.to) z = from + 0;
      if (m.end && m.toEnd !== undefined) z = m.toEnd;
      // dw on the last word of a line stops at the line end
      if (this.op.name !== 'y' && !m.inclusive && !m.end && z > lineEnd(b.text, a) && m.to === z && b.text.slice(a, z).includes('\n')) {
        z = lineEnd(b.text, a);
      }
      return this.operate(a, z, false);
    }
    if (m.keepGoal) b.goalCol = m.goal;
    else b.goalCol = undefined;
    b.cursor = m.toFirst ? firstNonBlank(b.text, m.to) : m.to;
    if (this.mode === 'normal') this.clamp();
  }

  /** Apply the pending operator to [a, z). */
  operate(a, z, linewise) {
    const b = this.b;
    const op = this.op?.name;
    this.clear();
    const text = b.text.slice(a, z);
    if (op === 'y') {
      this.register = { text, linewise };
      b.cursor = a;
      return;
    }
    if (op === '>' || op === '<') return this.indentLines(a, Math.max(a, z - 1), op);
    if (op === 'd' || op === 'c') {
      this.register = { text, linewise };
      b.snapshot(null);
      b.text = b.text.slice(0, a) + b.text.slice(z);
      b.cursor = a;
      if (op === 'c') this.toInsert();
      else this.clamp();
    }
  }

  operateLines(i, j) {
    const b = this.b;
    const t = b.text;
    const [p, q] = i <= j ? [i, j] : [j, i];
    const a = lineStart(t, p);
    const e = lineEnd(t, q);
    const op = this.op?.name;
    if (op === '>' || op === '<') {
      this.clear();
      return this.indentLines(a, e, op);
    }
    const text = t.slice(a, e) + '\n';
    if (op === 'y') {
      this.clear();
      this.register = { text, linewise: true };
      return;
    }
    this.clear();
    this.register = { text, linewise: true };
    b.snapshot(null);
    if (op === 'c') {
      const indent = /^[ \t]*/.exec(t.slice(a))[0];
      b.text = t.slice(0, a) + indent + t.slice(e);
      b.cursor = a + indent.length;
      this.toInsert();
      return;
    }
    // delete whole lines, with their newline
    const lastLine = e === t.length;
    const from = lastLine && a > 0 ? a - 1 : a; // the last line takes the newline before it
    const to = lastLine ? e : e + 1;
    b.text = t.slice(0, from) + t.slice(to);
    b.cursor = firstNonBlank(b.text, from === a ? Math.min(a, b.text.length) : lineStart(b.text, from));
    this.clamp();
  }

  indentLines(a, e, op) {
    const b = this.b;
    b.snapshot(null);
    const s = lineStart(b.text, a);
    const block = b.text.slice(s, lineEnd(b.text, e));
    const changed = block.split('\n').map((l) => (op === '>' ? (l ? INDENT + l : l) : l.replace(new RegExp(`^ {1,${INDENT.length}}`), ''))).join('\n');
    b.text = b.text.slice(0, s) + changed + b.text.slice(s + block.length);
    b.cursor = firstNonBlank(b.text, s);
  }

  command(name, count, ev) {
    const b = this.b;
    const t = b.text;
    const cur = b.cursor;
    const lineOp = (op) => {
      // dd, cc, yy, >>, << with a count
      let end = cur;
      for (let n = 1; n < count; n++) end = Math.min(t.length, lineEnd(t, end) + 1);
      this.op = { name: op };
      this.operateLines(cur, end);
    };
    if (this.op) {
      if (name === this.op.name || (this.op.name === 'c' && name === 'c')) return lineOp(this.op.name);
      return this.clear();
    }
    switch (name) {
      case 'd': case 'c': case 'y': case '>': case '<':
        this.op = { name, count };
        return;
      case 'i': return this.toInsert();
      case 'a':
        if (cur < lineEnd(t, cur)) b.cursor++;
        return this.toInsert();
      case 'I':
        b.cursor = firstNonBlank(t, cur);
        return this.toInsert();
      case 'A':
        b.cursor = lineEnd(t, cur);
        return this.toInsert();
      case 'o':
      case 'O': {
        const line = t.slice(lineStart(t, cur), lineEnd(t, cur));
        const indent = /^[ \t]*/.exec(line)[0];
        b.snapshot(null);
        if (name === 'o') {
          b.cursor = lineEnd(t, cur);
          b.insert('\n' + (/[{([]\s*$/.test(line) ? indent + INDENT : indent), null);
        } else {
          const s = lineStart(t, cur);
          b.text = t.slice(0, s) + indent + '\n' + t.slice(s);
          b.cursor = s + indent.length;
        }
        return this.toInsert();
      }
      case 'R':
        this.mode = 'replace';
        return;
      case 'x':
      case 'X': {
        const s = lineStart(t, cur);
        const e = lineEnd(t, cur);
        const [a, z] = name === 'x' ? [cur, Math.min(e, cur + count)] : [Math.max(s, cur - count), cur];
        if (a === z) return;
        this.op = { name: 'd' };
        return this.operate(a, z, false);
      }
      case 's':
        this.op = { name: 'c' };
        return this.operate(cur, Math.min(lineEnd(t, cur), cur + count), false);
      case 'S':
        return lineOp('c');
      case 'D':
      case 'C':
        this.op = { name: name === 'D' ? 'd' : 'c' };
        return this.operate(cur, lineEnd(t, cur), false);
      case 'Y':
        return lineOp('y');
      case 'r':
        this.pending = 'r';
        return;
      case '~': {
        const e = Math.min(lineEnd(t, cur), cur + count);
        if (cur >= e) return;
        b.snapshot(null);
        const flipped = [...t.slice(cur, e)].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
        b.text = t.slice(0, cur) + flipped + t.slice(e);
        b.cursor = e;
        return this.clamp();
      }
      case 'J': {
        const e = lineEnd(t, cur);
        if (e >= t.length) return;
        b.snapshot(null);
        const next = t.slice(e + 1).replace(/^[ \t]*/, '');
        b.text = t.slice(0, e).replace(/[ \t]*$/, '') + (next && !next.startsWith(')') ? ' ' : '') + next;
        b.cursor = e;
        return this.clamp();
      }
      case 'p':
      case 'P':
        return this.put(name === 'p', count);
      case 'u':
        for (let n = 0; n < count; n++) b.undo();
        return this.clamp();
      case 'C-r':
        for (let n = 0; n < count; n++) b.redo();
        return this.clamp();
      case '.':
        return this.repeat();
      case 'v':
      case 'V':
        this.mode = name === 'v' ? 'visual' : 'vline';
        this.anchor = cur;
        return;
      case '/':
      case '?':
        return this.repl.startSearch();
      case 'Enter':
        return this.repl.enter();
      default:
        // anything else (ctrl keys like Ctrl+D, Ctrl+L, Ctrl+O) behaves as in insert mode
        if (ev.ctrl || !ev.text) this.repl.handleInsert(ev);
    }
  }

  put(after, count) {
    const b = this.b;
    const { text, linewise } = this.register;
    if (!text) return;
    b.snapshot(null);
    const chunk = text.repeat(count);
    const t = b.text;
    if (linewise) {
      const at = after ? lineEnd(t, b.cursor) : lineStart(t, b.cursor);
      const insert = after ? '\n' + chunk.replace(/\n$/, '') : chunk;
      b.text = t.slice(0, at) + insert + t.slice(at);
      b.cursor = firstNonBlank(b.text, after ? at + 1 : at);
    } else {
      const at = after && b.cursor < lineEnd(t, b.cursor) ? b.cursor + 1 : b.cursor;
      b.text = t.slice(0, at) + chunk + t.slice(at);
      b.cursor = at + chunk.length - 1;
    }
    this.clamp();
  }

  // ── visual mode ─────────────────────────────────────────────────────────────

  /** The selected range [a, z) for rendering and operators. */
  selection() {
    if (this.mode !== 'visual' && this.mode !== 'vline') return null;
    const t = this.b.text;
    let [a, z] = [Math.min(this.anchor, this.b.cursor), Math.max(this.anchor, this.b.cursor)];
    if (this.mode === 'vline') return [lineStart(t, a), lineEnd(t, z)];
    return [a, Math.min(t.length, z + 1)];
  }

  exitVisual() {
    this.mode = 'normal';
    this.clamp();
  }

  visualCommand(name) {
    const [a, z] = this.selection();
    const linewise = this.mode === 'vline';
    const ops = { d: 'd', x: 'd', c: 'c', s: 'c', y: 'y', '>': '>', '<': '<' };
    if (name === 'o') {
      [this.anchor, this.b.cursor] = [this.b.cursor, this.anchor];
      return;
    }
    if (name === 'v' || name === 'V') {
      const target = name === 'v' ? 'visual' : 'vline';
      if (this.mode === target) this.exitVisual();
      else this.mode = target;
      return;
    }
    if (name === '~' || name === 'u' || name === 'U') {
      const b = this.b;
      b.snapshot(null);
      const part = b.text.slice(a, z);
      const out = name === 'u' ? part.toLowerCase() : name === 'U' ? part.toUpperCase() : [...part].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
      b.text = b.text.slice(0, a) + out + b.text.slice(z);
      b.cursor = a;
      return this.exitVisual();
    }
    const op = ops[name];
    if (!op) return;
    this.mode = 'normal';
    this.op = { name: op };
    if (linewise) {
      if (op === 'd' || op === 'y') {
        this.operateLines(a, z);
        if (op === 'y') this.b.cursor = a;
      } else this.operateLines(a, z);
    } else this.operate(a, z, false);
    if (this.mode === 'normal') this.clamp();
  }
}
