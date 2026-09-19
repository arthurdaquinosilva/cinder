// The input buffer: text, cursor, emacs-style editing, a kill ring of one and undo.

const WORD = /[\p{L}\p{N}_$]/u;

export class EditBuffer {
  constructor(text = '') {
    this.text = text;
    this.cursor = text.length;
    this.undoStack = [];
    this.redoStack = [];
    this.killed = '';
    this.lastEdit = null; // groups consecutive typing into one undo step
  }

  set(text, cursor = text.length) {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
  }

  reset(text = '') {
    this.set(text);
    this.undoStack = [];
    this.redoStack = [];
    this.lastEdit = null;
  }

  snapshot(kind) {
    if (kind && kind === this.lastEdit) return;
    this.undoStack.push([this.text, this.cursor]);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastEdit = kind;
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push([this.text, this.cursor]);
    [this.text, this.cursor] = prev;
    this.lastEdit = null;
    return true;
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push([this.text, this.cursor]);
    [this.text, this.cursor] = next;
    this.lastEdit = null;
    return true;
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  get lines() {
    return this.text.split('\n');
  }

  /** [row, col] of an index. */
  rowCol(index = this.cursor) {
    const before = this.text.slice(0, index);
    const row = (before.match(/\n/g) ?? []).length;
    return [row, index - (before.lastIndexOf('\n') + 1)];
  }

  indexOf(row, col) {
    const lines = this.lines;
    row = Math.max(0, Math.min(row, lines.length - 1));
    let index = 0;
    for (let r = 0; r < row; r++) index += lines[r].length + 1;
    return index + Math.min(col, lines[row].length);
  }

  get lineStart() {
    return this.text.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  get lineEnd() {
    const i = this.text.indexOf('\n', this.cursor);
    return i === -1 ? this.text.length : i;
  }

  get beforeCursor() {
    return this.text.slice(this.lineStart, this.cursor);
  }

  get afterCursor() {
    return this.text.slice(this.cursor, this.lineEnd);
  }

  get isMultiline() {
    return this.text.includes('\n');
  }

  get onFirstLine() {
    return this.text.lastIndexOf('\n', this.cursor - 1) === -1;
  }

  get onLastLine() {
    return this.text.indexOf('\n', this.cursor) === -1;
  }

  // ── editing ───────────────────────────────────────────────────────────────

  insert(s, kind = 'type') {
    this.snapshot(s.length === 1 && !/\s/.test(s) ? kind : null);
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
  }

  deleteBack(n = 1) {
    if (!this.cursor) return false;
    this.snapshot('delete');
    const start = Math.max(0, this.cursor - n);
    // don't split a surrogate pair
    const from = start > 0 && /[\udc00-\udfff]/.test(this.text[start]) ? start - 1 : start;
    this.text = this.text.slice(0, from) + this.text.slice(this.cursor);
    this.cursor = from;
    return true;
  }

  deleteForward(n = 1) {
    if (this.cursor >= this.text.length) return false;
    this.snapshot('delete-forward');
    let end = Math.min(this.text.length, this.cursor + n);
    if (/[\udc00-\udfff]/.test(this.text[end] ?? '')) end++;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
    return true;
  }

  kill(from, to) {
    if (from === to) return;
    this.snapshot(null);
    this.killed = this.text.slice(from, to);
    this.text = this.text.slice(0, from) + this.text.slice(to);
    this.cursor = from;
  }

  killToEnd() {
    // at the end of a line, join the next one (like emacs)
    const end = this.lineEnd === this.cursor && this.cursor < this.text.length ? this.cursor + 1 : this.lineEnd;
    this.kill(this.cursor, end);
  }

  killToStart() {
    this.kill(this.lineStart, this.cursor);
  }

  killWordBack() {
    this.kill(this.wordLeftIndex(), this.cursor);
  }

  killWordForward() {
    this.kill(this.cursor, this.wordRightIndex());
  }

  yank() {
    if (this.killed) this.insert(this.killed, null);
  }

  // ── movement ──────────────────────────────────────────────────────────────

  left() {
    if (this.cursor > 0) this.cursor -= /[\udc00-\udfff]/.test(this.text[this.cursor - 1]) && this.cursor > 1 ? 2 : 1;
    this.lastEdit = null;
  }

  right() {
    if (this.cursor < this.text.length) this.cursor += /[\ud800-\udbff]/.test(this.text[this.cursor]) ? 2 : 1;
    this.lastEdit = null;
  }

  home() {
    // first press: after the indentation; second: column 0
    const indentEnd = this.lineStart + /^[ \t]*/.exec(this.text.slice(this.lineStart))[0].length;
    this.cursor = this.cursor === indentEnd ? this.lineStart : indentEnd;
    this.lastEdit = null;
  }

  end() {
    this.cursor = this.lineEnd;
    this.lastEdit = null;
  }

  wordLeftIndex() {
    let i = this.cursor;
    while (i > 0 && !WORD.test(this.text[i - 1])) i--;
    while (i > 0 && WORD.test(this.text[i - 1])) i--;
    return i;
  }

  wordRightIndex() {
    let i = this.cursor;
    const n = this.text.length;
    while (i < n && !WORD.test(this.text[i])) i++;
    while (i < n && WORD.test(this.text[i])) i++;
    return i;
  }

  wordLeft() {
    this.cursor = this.wordLeftIndex();
    this.lastEdit = null;
  }

  wordRight() {
    this.cursor = this.wordRightIndex();
    this.lastEdit = null;
  }

  up() {
    const [row, col] = this.rowCol();
    if (row === 0) return false;
    this.cursor = this.indexOf(row - 1, this.goalCol ?? col);
    this.goalCol ??= col;
    return true;
  }

  down() {
    const [row, col] = this.rowCol();
    if (row >= this.lines.length - 1) return false;
    this.cursor = this.indexOf(row + 1, this.goalCol ?? col);
    this.goalCol ??= col;
    return true;
  }

  /** Remove up to `n` spaces of indentation from the cursor's line. */
  dedent(n) {
    const start = this.lineStart;
    const indent = /^ */.exec(this.text.slice(start))[0].length;
    const remove = Math.min(n, indent);
    if (!remove) return false;
    this.snapshot(null);
    this.text = this.text.slice(0, start) + this.text.slice(start + remove);
    this.cursor = Math.max(start, this.cursor - remove);
    return true;
  }
}
