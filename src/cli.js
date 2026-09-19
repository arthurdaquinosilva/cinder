// Command-line entry point.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Profile, Settings, loadSettings } from './config.js';
import { renderError, renderValue } from './display.js';
import { HistoryManager } from './history.js';
import { resolveFile, runFile } from './magics/execution.js';
import { restoreStore } from './magics/history.js';
import { ExitRequest, Shell } from './shell.js';
import { PALETTES } from './theme.js';

const HELP = `cinder — a modern interactive JavaScript shell for Node

usage:
  cinder                          interactive
  cinder file.js [args…]          run a file (-i to stay interactive afterwards)
  cinder -e "code"                run code        cinder -p "expr"   print its value
  cinder -  <  file.js            run code from stdin
  cinder --profile work --theme nebula --vi --layout box --no-startup

options:
  -e, --eval CODE      run code and exit
  -p, --print CODE     run code, print the result and exit
  -i, --interactive    stay interactive after -e/-p/file
  --profile NAME       use a named profile (separate config, startup files and history)
  --theme NAME         color theme: ${Object.keys(PALETTES).join(', ')}
  --layout NAME        block (full-width input bar) or box (rounded box)
  --vi                 vi key bindings
  --no-startup         skip startup files and execLines
  --no-history         don't read or write the history file
  -v, --version        print the version
  -h, --help           this help

inside cinder, %help lists keys, syntax and magics.`;

function version() {
  return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

function warn(shell, message) {
  process.stderr.write(shell.theme.paint('warn', `⚠ ${message}`) + '\n');
}

function reportError(shell, error) {
  if (error instanceof ExitRequest) return;
  process.stderr.write(renderError(error, { theme: shell.theme, sources: shell.sources, mode: shell.settings.xmode, width: shell.width }) + '\n');
}

async function runStartup(shell) {
  for (const line of shell.settings.execLines) {
    try {
      await shell.runQuiet(line, '[execLines]');
    } catch (e) {
      warn(shell, `error in execLines: ${line}`);
      reportError(shell, e);
    }
  }
  const files = [];
  if (shell.profile) {
    try {
      files.push(...fs.readdirSync(shell.profile.startupDir).filter((f) => /\.(c|m)?js$/.test(f)).sort().map((f) => path.join(shell.profile.startupDir, f)));
    } catch {
      // no startup directory
    }
  }
  files.push(...shell.settings.execFiles.map((f) => path.resolve(f.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))));
  for (const file of files) {
    try {
      await runFile(shell, file);
    } catch (e) {
      warn(shell, `error in ${file}`);
      reportError(shell, e);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  // everything after the file name belongs to the file
  const fileAt = argv.findIndex((a, i) => (a === '-' || !a.startsWith('-')) && !['-e', '--eval', '-p', '--print', '--profile', '--theme', '--layout'].includes(argv[i - 1]));
  const own = fileAt === -1 ? argv : argv.slice(0, fileAt + 1);
  const fileArgs = fileAt === -1 ? [] : argv.slice(fileAt + 1);
  try {
    opts = parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        eval: { type: 'string', short: 'e' },
        print: { type: 'string', short: 'p' },
        interactive: { type: 'boolean', short: 'i' },
        profile: { type: 'string' },
        theme: { type: 'string' },
        layout: { type: 'string' },
        vi: { type: 'boolean' },
        'no-startup': { type: 'boolean' },
        'no-history': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    process.stderr.write(`cinder: ${e.message}\n\n${HELP}\n`);
    return 2;
  }
  const o = opts.values;
  if (o.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (o.version) {
    process.stdout.write(`cinder ${version()} (node ${process.version})\n`);
    return 0;
  }

  let profile;
  try {
    profile = new Profile(o.profile ?? 'default');
  } catch (e) {
    process.stderr.write(`cinder: ${e.message}\n`);
    return 2;
  }
  const { settings, warnings } = loadSettings(profile);
  try {
    if (o.theme) settings.theme = Settings.validate('theme', o.theme);
    if (o.layout) settings.layout = Settings.validate('layout', o.layout);
  } catch (e) {
    process.stderr.write(`cinder: ${e.message}\n`);
    return 2;
  }
  if (o.vi) settings.editingMode = 'vi';
  const history = new HistoryManager(o['no-history'] ? null : profile.historyFile);
  const shell = new Shell({ settings, profile, history });
  for (const w of warnings) warn(shell, w);
  if (!o['no-startup']) await runStartup(shell);
  if (settings.storeAutorestore) {
    try {
      restoreStore(shell);
    } catch (e) {
      warn(shell, `%store autorestore: ${e.message}`);
    }
  }

  // batch work: -e, -p, a file, or code piped on stdin
  let ran = false;
  let status = 0;
  const batch = async (fn) => {
    ran = true;
    try {
      await fn();
    } catch (e) {
      if (e instanceof ExitRequest) {
        status = e.code;
        return false;
      }
      reportError(shell, e);
      status = 1;
    }
    return true;
  };
  const [file] = opts.positionals;
  if (o.eval !== undefined && !(await batch(() => shell.runQuiet(o.eval, '[eval]')))) return finish(shell, status);
  if (o.print !== undefined) {
    const going = await batch(async () => {
      const value = await shell.runQuiet(o.print, '[print]');
      process.stdout.write(renderValue(value, { theme: shell.theme, width: shell.width, depth: settings.depth, colors: process.stdout.isTTY }) + '\n');
    });
    if (!going) return finish(shell, status);
  }
  if (file && file !== '-' && !(await batch(() => runFile(shell, resolveFile(file), fileArgs)))) return finish(shell, status);
  if (file === '-' || (!ran && !process.stdin.isTTY)) {
    const source = fs.readFileSync(0, 'utf8');
    await batch(() => shell.runQuiet(source, '[stdin]'));
  }
  if ((ran && !o.interactive) || !process.stdin.isTTY || !process.stdout.isTTY) return finish(shell, status);

  const { Repl } = await import('./ui.js');
  process.on('uncaughtException', (e) => shell.reportBackgroundError(e, 'uncaught error'));
  process.on('unhandledRejection', (e) => shell.reportBackgroundError(e, 'unhandled rejection'));
  process.on('exit', () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // already closed
      }
    }
    fs.writeSync(1, '\x1b[>4;0m\x1b[?2004l\x1b[?25h' + (settings.editingMode === 'vi' ? '\x1b[0 q' : ''));
  });
  return new Repl(shell).run();
}

function finish(shell, status) {
  shell.close();
  return status;
}
