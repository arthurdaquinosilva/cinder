// Shared test helpers: a shell whose terminal output is collected as plain text.

import { spawnSync } from 'node:child_process';
import { Profile, Settings } from '../src/config.js';
import { HistoryManager } from '../src/history.js';
import { Shell } from '../src/shell.js';
import { stripAnsi } from '../src/text.js';

export class FakeStdout {
  constructor(columns = 100) {
    this.columns = columns;
    this.rows = 40;
    this.chunks = [];
    this.isTTY = false;
  }

  write(s) {
    this.chunks.push(String(s));
    return true;
  }

  take() {
    const text = stripAnsi(this.chunks.join(''));
    this.chunks = [];
    return text;
  }

  on() {}

  off() {}
}

/** A shell with in-memory history; with `profile`, one using the XDG directories (for %store and friends). */
export function makeShell(settings = {}, { profile = false } = {}) {
  const stdout = new FakeStdout();
  const shell = new Shell({ settings: new Settings(settings), history: new HistoryManager(null), stdout, profile: profile ? new Profile() : null });
  return { shell, stdout };
}

/** Run a cell and return what it printed (without colors). */
export async function run(shell, stdout, source) {
  stdout.take();
  const result = await shell.runCell(source);
  return { ...result, out: stdout.take() };
}

/**
 * Run cells in a child process (cells patch process.stdout, which the test runner also uses) and return
 * [{out, ok, value}] per cell; `value` is util.inspect of the result, `thrown` names an escaping error.
 */
export function runCells(cells, { cwd, env } = {}) {
  const fixture = new URL('./fixtures/run-cells.js', import.meta.url);
  const r = spawnSync(process.execPath, [fixture.pathname], {
    input: JSON.stringify(cells),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 30_000,
  });
  if (r.status !== 0 || !r.output[3]) throw new Error(`run-cells failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.output[3]);
}
