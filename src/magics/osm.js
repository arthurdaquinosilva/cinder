// Shell & files magics.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import util from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { shortPath } from '../text.js';
import { MagicError, cellMagic, lineMagic, parseArgs } from './registry.js';

const category = 'osm';

export const DEFAULT_ALIASES = { ls: 'ls', ll: 'ls -lF', la: 'ls -AF', cat: 'cat', mkdir: 'mkdir', rm: 'rm', cp: 'cp', mv: 'mv', rmdir: 'rmdir' };

function loadBookmarks(shell) {
  if (!shell.profile) return shell.bookmarks;
  try {
    shell.bookmarks = JSON.parse(fs.readFileSync(shell.profile.bookmarksFile, 'utf8'));
  } catch {
    // none yet
  }
  return shell.bookmarks;
}

function saveBookmarks(shell) {
  if (!shell.profile) return;
  fs.mkdirSync(path.dirname(shell.profile.bookmarksFile), { recursive: true });
  fs.writeFileSync(shell.profile.bookmarksFile, JSON.stringify(shell.bookmarks, null, 2) + '\n');
}

export function changeDir(shell, target) {
  const dir = path.resolve(target.replace(/^~(?=$|\/)/, os.homedir()));
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new MagicError(`no such directory: ${target}`);
  }
  if (!stat.isDirectory()) throw new MagicError(`not a directory: ${target}`);
  const before = process.cwd();
  process.chdir(dir);
  shell.prevDir = before;
  shell.dirHistory.push(dir);
  shell.updateRequire();
  return dir;
}

lineMagic(['cd'], {
  doc: 'Change directory: ~ by default, - for the previous one, -N for entry N of %dhist, -b name or a bookmark name. require() and import follow.',
  usage: '[dir | - | -N | -b bookmark]',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args.trim() === '-' ? '' : args, { b: 'value' });
  let target;
  if (args.trim() === '-') {
    if (!shell.prevDir) throw new MagicError('no previous directory');
    target = shell.prevDir;
  } else if (/^-\d+$/.test(args.trim())) {
    target = shell.dirHistory[Number(args.trim().slice(1))];
    if (!target) throw new MagicError(`no entry ${args.trim().slice(1)} in %dhist`);
  } else if (opts.b) {
    target = loadBookmarks(shell)[opts.b];
    if (!target) throw new MagicError(`no bookmark ${opts.b}`);
  } else if (!rest.length) target = os.homedir();
  else {
    target = rest.join(' ');
    if (!fs.existsSync(path.resolve(target.replace(/^~(?=$|\/)/, os.homedir())))) {
      const mark = loadBookmarks(shell)[target];
      if (mark) target = mark;
    }
  }
  const dir = changeDir(shell, target);
  shell.print(shell.theme.paint('muted', shortPath(dir)));
});

lineMagic(['pwd'], { doc: 'The current directory (returned as a string).', category }, () => process.cwd());

lineMagic(['bookmark'], {
  doc: 'Bookmark a directory (the current one by default) for %cd -b name. -l lists them, -d name deletes one.',
  usage: '[-l] [-d name] [name [dir]]',
  category,
}, (shell, args) => {
  const { opts, rest } = parseArgs(args, { l: 'bool', d: 'value' });
  const marks = loadBookmarks(shell);
  if (opts.d) {
    if (!marks[opts.d]) throw new MagicError(`no bookmark ${opts.d}`);
    delete marks[opts.d];
    saveBookmarks(shell);
    return;
  }
  if (opts.l || !rest.length) {
    const names = Object.keys(marks).sort();
    shell.print(names.length ? names.map((n) => `${shell.theme.paint('label', n.padEnd(14))} ${shortPath(marks[n])}`).join('\n') : shell.theme.paint('faint', 'no bookmarks yet'));
    return;
  }
  marks[rest[0]] = path.resolve(rest[1] ?? process.cwd());
  saveBookmarks(shell);
  shell.print(shell.theme.paint('muted', `${rest[0]} → ${shortPath(marks[rest[0]])}`));
});

lineMagic(['env'], {
  doc: 'Environment variables: %env lists them, %env NAME shows one, %env NAME=value sets it.',
  usage: '[NAME[=value]]',
  category,
}, (shell, args) => {
  const text = args.trim();
  if (!text) return { ...process.env };
  const m = /^([\w.]+)\s*(?:[=\s]\s*(.*))?$/.exec(text);
  if (!m) throw new MagicError('usage: %env NAME=value');
  if (m[2] === undefined) return process.env[m[1]];
  process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  shell.print(shell.theme.paint('muted', `${m[1]}=${process.env[m[1]]}`));
  return undefined;
});

lineMagic(['sx', 'system'], {
  doc: 'Run a shell command and return its output as an array of lines. $name and ${expr} insert JS values.',
  usage: 'command',
  category,
}, async (shell, args) => {
  if (!args.trim()) throw new MagicError('usage: %sx command');
  const { out, code } = await shell.system(args, { capture: true });
  if (code) shell.print(shell.theme.paint('warn', `exit ${code}`));
  const lines = out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
});

lineMagic(['alias'], {
  doc: 'Define a shell alias used as %name: %s is replaced by an argument, %l by the rest of the line. %alias alone lists them.',
  usage: '[name command]',
  category,
}, (shell, args) => {
  const text = args.trim();
  if (!text) {
    const names = Object.keys(shell.aliases).sort();
    shell.print(names.map((n) => `${shell.theme.paint('label', n.padEnd(12))} ${shell.aliases[n]}`).join('\n'));
    return;
  }
  const [name, ...cmd] = text.split(/\s+/);
  if (!/^[A-Za-z_][\w-]*$/.test(name)) throw new MagicError(`invalid alias name ${name}`);
  shell.aliases[name] = cmd.length ? text.slice(name.length).trim() : name;
});

lineMagic(['unalias'], { doc: 'Remove an alias.', usage: 'name', category }, (shell, args) => {
  const name = args.trim();
  if (!shell.aliases[name]) throw new MagicError(`no alias ${name}`);
  delete shell.aliases[name];
});

lineMagic(['npm'], {
  doc: 'Run npm in the current directory, e.g. %npm install lodash — then require() or import it right away.',
  usage: 'args…',
  category,
}, async (shell, args) => {
  const code = await shell.system(`npm ${args}`);
  if (code) throw new MagicError(`npm exited with ${code}`);
});

// ── the directory stack ──────────────────────────────────────────────────────

lineMagic(['pushd'], { doc: 'Change directory, remembering the current one on a stack for %popd.', usage: '[dir]', category }, (shell, args) => {
  const before = process.cwd();
  const dir = changeDir(shell, args.trim() || os.homedir());
  shell.dirStack.push(before);
  shell.print(shell.theme.paint('muted', [dir, ...shell.dirStack.slice().reverse()].map(shortPath).join('  ')));
});

lineMagic(['popd'], { doc: 'Go back to the directory on top of the %pushd stack.', category }, (shell) => {
  const dir = shell.dirStack.pop();
  if (!dir) throw new MagicError('the directory stack is empty');
  shell.print(shell.theme.paint('muted', shortPath(changeDir(shell, dir))));
});

lineMagic(['dirs'], { doc: 'The directory stack (returned as an array, current directory first).', category }, (shell) => [process.cwd(), ...shell.dirStack.slice().reverse()]);

lineMagic(['dhist'], { doc: 'Directories you visited this session; %cd -N goes back to entry N. -n limits to the last n.', usage: '[n]', category }, (shell, args) => {
  const n = Number(args.trim()) || shell.dirHistory.length;
  const start = Math.max(0, shell.dirHistory.length - n);
  shell.print(shell.dirHistory.slice(start).map((d, i) => `${shell.theme.paint('faint', String(start + i).padStart(3))}  ${shortPath(d)}`).join('\n'));
});

// ── clipboard ────────────────────────────────────────────────────────────────

const COPY_TOOLS = [['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];

lineMagic(['copy'], {
  doc: 'Copy a value to the clipboard (default: the last result). Strings are copied as they are, other values as JSON when possible, else as printed.',
  usage: '[expr]',
  category,
}, (shell, args) => {
  const value = args.trim() ? shell.evalSimple(args.trim()) : shell.lastValue;
  if (value === undefined) throw new MagicError('nothing to copy');
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = undefined;
    }
    text ??= util.inspect(value, { depth: Infinity, colors: false });
  }
  for (const [cmd, ...rest] of COPY_TOOLS) {
    const r = spawnSync(cmd, rest, { input: text });
    if (!r.error && r.status === 0) {
      shell.print(shell.theme.paint('muted', `copied ${text.length} characters`));
      return;
    }
  }
  throw new MagicError('no clipboard tool found (pbcopy, wl-copy, xclip or xsel)');
});

// ── cell magics that run other programs ──────────────────────────────────────

const INTERPRETERS = {
  bash: ['bash'], sh: ['sh'], zsh: ['zsh'], python: ['python3'], python3: ['python3'], ruby: ['ruby'], perl: ['perl'],
  node: [process.execPath, '--input-type=module', '-'], deno: ['deno', 'run', '-'], bun: ['bun', 'run', '-'],
};
const SCRIPT_OPTS = { o: 'value', out: 'value', err: 'value', bg: 'bool' };

/** Run a cell with a program. --bg runs it in the background (%killbgscripts stops those). */
async function runProgram(shell, program, opts, body) {
  const out = opts.o ?? opts.out;
  if (opts.bg) return runBackground(shell, program, body, out, opts.err);
  const capture = out !== undefined || opts.err !== undefined;
  const result = await shell.system('', { program, input: body, capture });
  const code = capture ? result.code : result;
  if (out !== undefined) globalThis[out] = result.out;
  if (code) throw new MagicError(`${program[0]} exited with ${code}`);
}

function runBackground(shell, program, body, out, err) {
  const child = spawn(program[0], program.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], detached: false });
  const job = { id: shell.bgJobs.length + 1, name: program[0], child, stdout: '', stderr: '' };
  shell.bgJobs.push(job);
  child.stdin.end(body);
  child.stdout.on('data', (d) => (job.stdout += d));
  child.stderr.on('data', (d) => (job.stderr += d));
  child.on('error', (e) => shell.print(shell.theme.paint('warn', `⚠ job ${job.id}: ${e.message}`)));
  child.on('close', (code, signal) => {
    if (out) globalThis[out] = job.stdout;
    if (err) globalThis[err] = job.stderr;
    const status = signal ? `stopped (${signal})` : `exit ${code}`;
    shell.print(shell.theme.paint(code ? 'warn' : 'muted', `job ${job.id} (${job.name}) finished: ${status}`)
      + (out ? shell.theme.paint('faint', ` · output in ${out}`) : ''));
    if (!out && job.stdout) shell.print(job.stdout.trimEnd());
    if (!err && job.stderr) shell.print(shell.theme.paint('err', job.stderr.trimEnd()));
  });
  shell.print(shell.theme.paint('muted', `job ${job.id} started in the background (pid ${child.pid})`));
}

for (const [name, program] of Object.entries(INTERPRETERS)) {
  cellMagic([name], {
    doc: `Run the cell with ${name === 'node' ? 'a separate node process (as an ES module)' : program[0]}. -o/--out var and --err var capture its output; --bg runs it in the background.`,
    usage: '[-o var] [--err var] [--bg] [args…]',
    category,
  }, (shell, args, body) => {
    const { opts, rest } = parseArgs(args, SCRIPT_OPTS);
    const cmd = name === 'node' || name === 'deno' || name === 'bun' ? [...program.slice(0, -1), ...rest, program.at(-1)] : [...program, ...rest];
    return runProgram(shell, cmd, opts, body);
  });
}

cellMagic(['script'], {
  doc: 'Run the cell with any program, e.g. %%script ruby -w. -o/--out var and --err var capture its output; --bg runs it in the background.',
  usage: '[-o var] [--err var] [--bg] program [args…]',
  category,
}, (shell, args, body) => {
  const { opts, rest } = parseArgs(args, SCRIPT_OPTS);
  if (!rest.length) throw new MagicError('usage: %%script program [args…]');
  return runProgram(shell, rest, opts, body);
});

lineMagic(['killbgscripts'], { doc: 'Stop every background job started with --bg.', category }, (shell) => {
  const running = shell.bgJobs.filter((j) => j.child.exitCode === null && !j.child.killed);
  for (const j of running) j.child.kill('SIGTERM');
  shell.print(shell.theme.paint('muted', `stopped ${running.length} job${running.length === 1 ? '' : 's'}`));
});

cellMagic(['writefile', 'file'], { doc: 'Write the cell to a file (-a appends).', usage: '[-a] path', category }, (shell, args, body) => {
  const { opts, rest } = parseArgs(args, { a: 'bool' });
  if (!rest.length) throw new MagicError('usage: %%writefile path');
  const file = path.resolve(rest.join(' '));
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = body.endsWith('\n') ? body : body + '\n';
  if (opts.a) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
  shell.print(shell.theme.paint('muted', `${opts.a ? 'appended to' : existed ? 'overwrote' : 'wrote'} ${rest.join(' ')}`));
});

