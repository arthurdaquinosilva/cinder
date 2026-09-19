// Decode raw terminal input into key events. Understands xterm/CSI-u modified keys (so Shift+Enter can be
// told apart from Enter), SS3 keys, Alt as an ESC prefix, and bracketed paste.
//
// A key event: {name, ctrl, meta, shift, seq, text?} — `text` is set for printable characters.
// A paste event: {name: 'paste', text}.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const CSI_TILDE = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' };
const CSI_LETTER = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4', Z: 'tab' };
const CODE_NAMES = { 13: 'return', 9: 'tab', 27: 'escape', 127: 'backspace', 8: 'backspace', 32: 'space' };

function mods(param) {
  const m = Math.max(0, (Number(param) || 1) - 1);
  return { shift: !!(m & 1), meta: !!(m & 2) || !!(m & 8), ctrl: !!(m & 4) };
}

function key(name, extra = {}) {
  return { name, ctrl: false, meta: false, shift: false, ...extra };
}

/** Key for a character code with modifiers (modifyOtherKeys / CSI-u). */
function fromCode(code, m, seq) {
  const name = CODE_NAMES[code] ?? String.fromCodePoint(code).toLowerCase();
  const ev = key(name, { ...m, seq });
  if (!CODE_NAMES[code] && !m.ctrl && !m.meta) ev.text = String.fromCodePoint(code);
  return ev;
}

export class KeyDecoder {
  /** `emit(event)` is called for each decoded key; `escapeTimeout` ms decides a lone Esc. */
  constructor(emit, { escapeTimeout = 40 } = {}) {
    this.emit = emit;
    this.buf = '';
    this.paste = null;
    this.escapeTimeout = escapeTimeout;
    this.timer = null;
  }

  feed(data) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buf += data;
    this.drain(false);
    if (this.buf) {
      // An incomplete escape sequence (or a lone Esc): wait a moment for the rest.
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain(true);
      }, this.escapeTimeout);
    }
  }

  /** Decode as much as possible. With `flush`, a pending lone ESC becomes an Escape key. */
  drain(flush) {
    while (this.buf) {
      if (this.paste !== null) {
        const end = this.buf.indexOf(PASTE_END);
        if (end === -1) {
          // keep a possible partial end marker in the buffer
          const keep = this.buf.length >= PASTE_END.length ? PASTE_END.length - 1 : this.buf.length;
          this.paste += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          if (flush) {
            this.paste += this.buf;
            this.buf = '';
          }
          return;
        }
        this.paste += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + PASTE_END.length);
        this.emit({ name: 'paste', text: this.paste });
        this.paste = null;
        continue;
      }
      if (this.buf.startsWith(PASTE_START)) {
        this.buf = this.buf.slice(PASTE_START.length);
        this.paste = '';
        continue;
      }
      const res = this.parseOne(this.buf, flush);
      if (!res) return; // need more input
      const [ev, len] = res;
      this.buf = this.buf.slice(len);
      if (ev) this.emit(ev);
    }
  }

  /** Returns [event|null, consumed] or null when the buffer holds an incomplete sequence. */
  parseOne(s, flush) {
    const c = s[0];
    if (c === '\x1b') {
      if (s.length === 1) return flush ? [key('escape', { seq: c }), 1] : null;
      const n = s[1];
      if (n === '[') return this.parseCSI(s, flush);
      if (n === 'O') {
        if (s.length < 3) return flush ? [key('escape', { seq: '\x1b' }), 1] : null;
        const name = CSI_LETTER[s[2]];
        return [name ? key(name, { seq: s.slice(0, 3) }) : null, 3];
      }
      if (n === '\x1b') {
        // ESC ESC [ … — some terminals send Alt+arrow this way
        if (s.length >= 3 && s[2] === '[') {
          const inner = this.parseCSI(s.slice(1), flush);
          if (!inner) return null;
          const [ev, len] = inner;
          if (ev) ev.meta = true;
          return [ev, len + 1];
        }
        return [key('escape', { seq: '\x1b' }), 1];
      }
      // Alt+key
      const inner = this.parseOne(s.slice(1), flush);
      if (!inner) return null;
      const [ev, len] = inner;
      if (ev) {
        ev.meta = true;
        delete ev.text;
        ev.seq = s.slice(0, len + 1);
      }
      return [ev, len + 1];
    }
    if (c === '\r') return [key('return', { seq: c }), s[1] === '\n' ? 2 : 1];
    if (c === '\n') return [key('j', { ctrl: true, seq: c }), 1];
    if (c === '\t') return [key('tab', { seq: c }), 1];
    if (c === '\x7f' || c === '\b') return [key('backspace', { seq: c }), 1];
    if (c === '\x00') return [key('space', { ctrl: true, seq: c }), 1];
    if (c === '\x1f') return [key('_', { ctrl: true, seq: c }), 1];
    if (c === '\x1c') return [key('\\', { ctrl: true, seq: c }), 1];
    if (c < ' ') return [key(String.fromCharCode(c.charCodeAt(0) + 96), { ctrl: true, seq: c }), 1];
    const ch = String.fromCodePoint(s.codePointAt(0));
    return [key(ch, { seq: ch, text: ch, shift: ch !== ch.toLowerCase() }), ch.length];
  }

  parseCSI(s, flush) {
    // ESC [ params intermediates final
    let i = 2;
    while (i < s.length && /[0-9;:<=>?]/.test(s[i])) i++;
    while (i < s.length && /[ -/]/.test(s[i])) i++;
    if (i >= s.length) return flush ? [key('escape', { seq: '\x1b' }), 1] : null;
    const final = s[i];
    const params = s.slice(2, i);
    const seq = s.slice(0, i + 1);
    const len = i + 1;
    if (params.startsWith('<') || final === 'M' && params === '') return [null, len]; // mouse reports
    const parts = params.split(';');
    if (final === '~') {
      if (parts[0] === '27' && parts.length >= 3) return [fromCode(Number(parts[2]), mods(parts[1]), seq), len];
      const name = CSI_TILDE[parts[0]];
      return [name ? key(name, { ...mods(parts[1]), seq }) : null, len];
    }
    if (final === 'u') {
      const code = Number(parts[0].split(':')[0]);
      return [fromCode(code, mods(parts[1]), seq), len];
    }
    const name = CSI_LETTER[final];
    if (!name) return [null, len];
    const ev = key(name, { ...mods(parts[1]), seq });
    if (final === 'Z') ev.shift = true;
    return [ev, len];
  }
}

/** A readable name like "ctrl+a", "alt+return", "shift+tab". */
export function keyName(ev) {
  return `${ev.ctrl ? 'ctrl+' : ''}${ev.meta ? 'alt+' : ''}${ev.shift && ev.name.length > 1 ? 'shift+' : ''}${ev.name}`;
}
