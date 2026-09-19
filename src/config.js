// Settings, profiles and where things live on disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PALETTES } from './theme.js';

export const XMODES = ['minimal', 'plain', 'context', 'verbose'];

/** Every setting with its default, and a check for values set from config.json or %config. */
export const SETTINGS = {
  theme: { default: 'void', choices: Object.keys(PALETTES), doc: 'color theme' },
  layout: { default: 'block', choices: ['block', 'box'], doc: 'block (full-width input bar) or box (rounded box)' },
  typescript: { default: 'auto', choices: ['auto', 'always', 'off'], doc: 'TypeScript in cells: auto (when the code isn\'t JavaScript), always, or off' },
  editingMode: { default: 'emacs', choices: ['emacs', 'vi'], doc: 'key bindings for the input' },
  automagic: { default: true, type: 'boolean', doc: 'run magics without the % prefix (cd .., pwd, ls) when the line isn\'t JavaScript' },
  interactivity: { default: 'last_expr', choices: ['last_expr', 'all', 'none', 'last_expr_or_assign'], doc: 'which expressions of a cell are displayed' },
  precision: { default: '', doc: 'digits after the point for printed numbers ("" = as JavaScript prints them)' },
  autoreload: { default: 0, type: 'number', doc: 'reload changed CommonJS files before each cell: 0 off, 1 only %aimport-ed, 2 all' },
  storeAutorestore: { default: false, type: 'boolean', doc: 'restore %store variables at startup' },
  xmode: { default: 'context', choices: XMODES, doc: 'how errors are shown' },
  depth: { default: 4, type: 'number', doc: 'how deep results are printed (util.inspect depth)' },
  autoImport: { default: true, type: 'boolean', doc: 'built-in modules (fs, path, …) as globals, loaded on first use' },
  historyLogOutput: { default: true, type: 'boolean', doc: 'save a short text form of each result in the history' },
  execLines: { default: [], type: 'array', doc: 'code to run at startup' },
  execFiles: { default: [], type: 'array', doc: 'files to run at startup' },
  aliases: { default: {}, type: 'object', doc: 'shell aliases for %alias, e.g. {"gs": "git status"}' },
};

export class Settings {
  constructor(values = {}) {
    for (const [k, spec] of Object.entries(SETTINGS)) this[k] = structuredClone(spec.default);
    for (const [k, v] of Object.entries(values)) this[k] = v;
  }

  static names() {
    return Object.keys(SETTINGS);
  }

  /** Coerce and check `value` for setting `name`. Strings are parsed ("3", "true", "on", JSON). */
  static validate(name, value) {
    const spec = SETTINGS[name];
    if (!spec) throw new Error(`unknown setting ${name} — try: ${Object.keys(SETTINGS).join(', ')}`);
    const type = spec.type ?? 'string';
    if (typeof value === 'string' && type !== 'string') {
      const s = value.trim();
      if (type === 'boolean' && /^(on|yes|true|off|no|false)$/i.test(s)) value = /^(on|yes|true)$/i.test(s);
      else {
        try {
          value = JSON.parse(s);
        } catch {
          throw new Error(`${name} expects a ${type}`);
        }
      }
    }
    if (type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) throw new Error(`${name} expects a number`);
    if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${name} expects true or false`);
    if (type === 'array' && !Array.isArray(value)) throw new Error(`${name} expects a list`);
    if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new Error(`${name} expects an object`);
    if (type === 'string') {
      value = String(value).trim().replace(/^['"]|['"]$/g, '');
      if (spec.choices) {
        value = value.toLowerCase();
        if (!spec.choices.includes(value)) throw new Error(`${name} must be one of: ${spec.choices.join(', ')}`);
      }
    }
    if (name === 'depth' && value < 0) throw new Error('depth must be 0 or more (use Infinity for everything)');
    if (name === 'autoreload' && ![0, 1, 2].includes(value)) throw new Error('autoreload must be 0, 1 or 2');
    if (name === 'precision' && value !== '' && !/^\d{1,2}$/.test(value)) throw new Error('precision must be a number of digits (0-20) or empty');
    return value;
  }
}

function xdg(envName, fallback) {
  const dir = process.env[envName];
  return dir && path.isAbsolute(dir) ? dir : path.join(os.homedir(), fallback);
}

export class Profile {
  constructor(name = 'default') {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid profile name ${JSON.stringify(name)}`);
    this.name = name;
    const config = path.join(xdg('XDG_CONFIG_HOME', '.config'), 'cinder');
    const data = path.join(xdg('XDG_DATA_HOME', '.local/share'), 'cinder');
    this.configDir = name === 'default' ? config : path.join(config, 'profiles', name);
    this.dataDir = name === 'default' ? data : path.join(data, 'profiles', name);
  }

  get configFile() {
    return path.join(this.configDir, 'config.json');
  }

  get startupDir() {
    return path.join(this.configDir, 'startup');
  }

  get historyFile() {
    return path.join(this.dataDir, 'history.jsonl');
  }

  get bookmarksFile() {
    return path.join(this.dataDir, 'bookmarks.json');
  }

  get storeDir() {
    return path.join(this.dataDir, 'store');
  }
}

/** Read config.json. Problems become warnings; they never stop cinder from starting. */
export function loadSettings(profile) {
  const warnings = [];
  const settings = new Settings();
  if (!profile) return { settings, warnings };
  let raw;
  try {
    raw = fs.readFileSync(profile.configFile, 'utf8');
  } catch {
    return { settings, warnings };
  }
  let data;
  try {
    // allow // comments and trailing commas, people write config by hand
    data = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  } catch (e) {
    warnings.push(`${profile.configFile}: ${e.message}`);
    return { settings, warnings };
  }
  for (const [key, value] of Object.entries(data ?? {})) {
    try {
      settings[key] = Settings.validate(key, value);
    } catch (e) {
      warnings.push(`config ${key}: ${e.message}`);
    }
  }
  return { settings, warnings };
}
