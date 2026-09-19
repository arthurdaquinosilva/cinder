// Input history grouped by session, kept as JSON lines so several cinder windows can append at once.
// Record shapes: {"session": id, "start": iso, "cwd": dir} and {"s": id, "n": line, "src": source, "out"?: text}.

import fs from 'node:fs';
import path from 'node:path';

export class HistoryManager {
  /** `file` null keeps history in memory only (tests, --no-history). */
  constructor(file) {
    this.file = file;
    this.sessions = []; // [{id, start, cwd}], oldest first
    this.entries = []; // [{s, n, src, out}]
    this.isNew = true;
    if (file) this.load();
    this.session = Math.max(Date.now(), (this.sessions.at(-1)?.id ?? 0) + 1);
    this.sessions.push({ id: this.session, start: new Date().toISOString(), cwd: process.cwd() });
    this.started = false;
  }

  load() {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
      this.isNew = false;
    } catch {
      return;
    }
    const byKey = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.session !== undefined) this.sessions.push({ id: rec.session, start: rec.start, cwd: rec.cwd });
      else if (rec.s !== undefined && rec.src !== undefined) {
        const key = `${rec.s}:${rec.n}`;
        byKey.set(key, { ...byKey.get(key), ...rec });
      } else if (rec.s !== undefined && rec.out !== undefined) {
        const key = `${rec.s}:${rec.n}`;
        if (byKey.has(key)) byKey.get(key).out = rec.out;
      }
    }
    this.entries = [...byKey.values()];
    this.sessions.sort((a, b) => a.id - b.id);
  }

  append(rec) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!this.started) {
        this.started = true;
        const s = this.sessions.at(-1);
        fs.appendFileSync(this.file, JSON.stringify({ session: s.id, start: s.start, cwd: s.cwd }) + '\n');
      }
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch {
      // history is a convenience; never fail a cell because of it
    }
  }

  storeInput(n, src) {
    const rec = { s: this.session, n, src, t: new Date().toISOString() };
    this.entries.push(rec);
    this.append(rec);
  }

  storeOutput(n, out) {
    const entry = this.entries.findLast((e) => e.s === this.session && e.n === n);
    if (entry) entry.out = out;
    this.append({ s: this.session, n, out });
  }

  /** Session id `offset` sessions ago (0 = this one), or null. */
  sessionOffset(offset) {
    const ids = [...new Set([...this.sessions.map((s) => s.id), ...this.entries.map((e) => e.s)])].sort((a, b) => a - b);
    const withInput = ids.filter((id) => id === this.session || this.entries.some((e) => e.s === id));
    const i = withInput.indexOf(this.session) - offset;
    return i >= 0 ? withInput[i] : null;
  }

  range(session, start = 1, stop = null) {
    return this.entries.filter((e) => e.s === session && e.n >= start && (stop === null || e.n < stop));
  }

  /**
   * IPython-style ranges, space separated: `4`, `4-6` (inclusive), `4:6` (end exclusive), `~1/` (the whole
   * previous session), `~2/3-5`. Returns entries in order; throws on malformed specs.
   */
  rangeByString(spec) {
    const out = [];
    for (const part of spec.trim().split(/\s+/).filter(Boolean)) {
      const m = /^(?:~(\d+)\/)?(?:(\d+)(?:([-:])(\d+)?)?)?$/.exec(part);
      if (!m) throw new Error(`bad history range ${JSON.stringify(part)} — try 4, 4-6, 4:6, ~1/ or ~1/2-3`);
      const session = this.sessionOffset(m[1] ? +m[1] : 0);
      if (session === null) continue;
      if (m[2] === undefined) {
        out.push(...this.range(session));
        continue;
      }
      const a = +m[2];
      let b;
      if (!m[3]) b = a + 1;
      else if (m[4] === undefined) b = null;
      else b = m[3] === '-' ? +m[4] + 1 : +m[4];
      out.push(...this.range(session, a, b));
    }
    return out;
  }

  tail(n = 10, includeCurrent = true) {
    const all = includeCurrent ? this.entries : this.entries.filter((e) => e.s !== this.session);
    return all.slice(-n);
  }

  /** Search every session with a glob (`*`, `?`), newest last. */
  search(pattern, { unique = false, limit = null } = {}) {
    const re = globToRegExp(pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`);
    let found = this.entries.filter((e) => re.test(e.src));
    if (unique) {
      const seen = new Set();
      found = found.reverse().filter((e) => !seen.has(e.src) && seen.add(e.src)).reverse();
    }
    return limit ? found.slice(-limit) : found;
  }

  /** Unique inputs, newest first, for ↑/↓, Ctrl+R and grey suggestions. */
  recentInputs(limit = 5000) {
    const seen = new Set();
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const src = this.entries[i].src;
      if (!seen.has(src)) {
        seen.add(src);
        out.push(src);
      }
    }
    return out;
  }

  label(entry) {
    return entry.s === this.session ? String(entry.n) : `${this.sessionIndexLabel(entry.s)}/${entry.n}`;
  }

  sessionIndexLabel(id) {
    for (let k = 1; k < 1000; k++) {
      const s = this.sessionOffset(k);
      if (s === null) break;
      if (s === id) return `~${k}`;
    }
    return '~?';
  }
}

export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
