// End to end: run the real CLI in a real terminal (an isolated tmux server) and read the screen.
// Skipped when tmux isn't installed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const socket = `cinder-test-${process.pid}`;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cinder-e2e-'));

const tmux = (...args) => execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
const screen = () => tmux('capture-pane', '-p', '-t', 'e2e');
const send = (...keys) => tmux('send-keys', '-t', 'e2e', ...keys);
const type = (text) => tmux('send-keys', '-t', 'e2e', '-l', text);
let modifiedKeys = false; // whether this tmux can send Shift+Enter

async function waitFor(re, timeout = 8000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = screen();
    if (re.test(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${re}; screen was:\n${last}`);
}

before(() => {
  if (!hasTmux) return;
  tmux('new-session', '-d', '-s', 'e2e', '-x', '100', '-y', '40', '-e', `XDG_DATA_HOME=${home}`, '-e', `XDG_CONFIG_HOME=${home}`,
    // `trap : INT` keeps this wrapper shell alive when Ctrl+C reaches it too (there's no job control here)
    `/bin/sh -c 'trap : INT; cd "${root}" && "${process.execPath}" bin/cinder.js; echo CINDER-EXITED; sleep 30'`);
  tmux('set', '-s', 'escape-time', '10');
  // Shift+Enter needs tmux 3.2+ (extended-keys); the key format option only exists from 3.5, and cinder
  // understands both formats, so it's optional.
  modifiedKeys = trySet('extended-keys', 'on');
  trySet('extended-keys-format', 'csi-u');
});

function trySet(option, value) {
  try {
    tmux('set', '-g', option, value);
    return true;
  } catch {
    return false;
  }
}

after(() => {
  if (hasTmux) spawnSync('tmux', ['-L', socket, 'kill-server']);
});

test('an interactive session in a real terminal', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  await waitFor(/Type JavaScript…/);
  assert.match(screen(), /▀▀▀▀ ▀▀▀ ▀ {3}▀/); // the pixel wordmark

  // a multi-line cell with auto-indent; the result goes on the rail with a footer
  type('function double(x) {');
  send('Enter');
  type('return x * 2');
  send('Enter');
  type('}');
  send('Enter');
  await waitFor(/╰─ ✓ .*\n/);
  type('double(21)');
  send('Enter');
  await waitFor(/│ 42\n│\n╰─ ✓ .* · number · Out\[2\]/);

  // the signature hint while typing a call
  type('double(');
  await waitFor(/ƒ double\(x\)/);
  send('C-u');

  // Shift+Enter inserts a newline instead of running (Alt+Enter where tmux can't send it)
  type('const a = 1');
  if (modifiedKeys) send('S-Enter');
  else send('M-Enter');
  type('a + 1');
  await waitFor(/> const a = 1 .*\n +· a \+ 1/);
  send('Enter');
  await waitFor(/│ 2\n│\n╰─ ✓ .* Out\[3\]/);

  // Ctrl+C interrupts a busy loop
  type('while (true) {}');
  send('Enter');
  await waitFor(/running/);
  send('C-c');
  await waitFor(/╰─ ✗ interrupted/);

  // vi mode: fix a typo from normal mode and run the cell from there
  type('%vi');
  send('Enter');
  await waitFor(/editing mode: vi/);
  type('"xcinder"');
  send('Escape');
  await waitFor(/\[NORMAL\]/);
  type('0lx');
  await waitFor(/> "cinder"/);
  send('Enter');
  await waitFor(/│ 'cinder'\n/);

  // Ctrl+D leaves
  send('C-d');
  await waitFor(/goodbye ✦\n(.*\n)*CINDER-EXITED/);
});
