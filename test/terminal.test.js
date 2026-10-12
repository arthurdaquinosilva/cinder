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

async function waitUntilGone(re, timeout = 8000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = screen();
    if (!re.test(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${re} never went away; screen was:\n${last}`);
}

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
  assert.match(screen(), /─{100}\n> Type JavaScript….*\n─{100}\n {2}\? for shortcuts/); // the rule layout

  type('?');
  await waitFor(/%help all commands/);
  send('BSpace'); // any other key closes the panel
  await waitUntilGone(/%help all commands/);

  // a multi-line cell with auto-indent; the output hangs under ⎿ with the footer last
  type('function double(x) {');
  send('Enter');
  type('return x * 2');
  send('Enter');
  type('}');
  send('Enter');
  await waitFor(/⎿ {2}✓ .*\n/);
  type('double(21)');
  send('Enter');
  await waitFor(/⎿ {2}42\n {5}✓ .* · number · Out\[2\]/);

  // the signature hint while typing a call
  type('double(');
  await waitFor(/ƒ double\(x\)/);
  send('C-u');

  // Shift+Enter inserts a newline instead of running (Alt+Enter where tmux can't send it)
  type('const a = 1');
  if (modifiedKeys) send('S-Enter');
  else send('M-Enter');
  type('a + 1');
  await waitFor(/> const a = 1\s*\n {2}a \+ 1/);
  send('Enter');
  await waitFor(/⎿ {2}2\n {5}✓ .* Out\[3\]/);

  // Ctrl+C interrupts a busy loop
  type('while (true) {}');
  send('Enter');
  await waitFor(/Running…/);
  send('C-c');
  await waitFor(/✗ interrupted/);

  // vi mode: fix a typo from normal mode and run the cell from there
  type('%vi');
  send('Enter');
  await waitFor(/editing mode: vi/);
  type('"xcinder"');
  await waitFor(/-- INSERT --/);
  send('Escape');
  await waitUntilGone(/-- INSERT --/); // NORMAL mode shows no label, as in vim
  type('0lx');
  await waitFor(/> "cinder"/);
  send('Enter');
  await waitFor(/⎿ {2}'cinder'\n/);

  // Ctrl+C on an empty prompt asks for a second press
  send('C-c');
  await waitFor(/Press Ctrl-C again to exit/);

  // Ctrl+D leaves
  send('C-d');
  await waitFor(/goodbye ✦\n(.*\n)*CINDER-EXITED/);
});
