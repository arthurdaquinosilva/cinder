// %autoreload for CommonJS: before each cell, files you've required that changed on disk are loaded again,
// and the new code is copied into the objects you already have — the old `module.exports` object is updated
// in place and classes get the new prototype methods — so `lib.fn()` and existing instances pick it up.
// ES modules can't be unloaded by Node, so they aren't reloaded (use a new `await import(url + '?v=2')`).

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function isClass(fn) {
  return typeof fn === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(fn));
}

/** Copy the new class's methods and accessors onto the old one (prototype and statics). */
function patchClass(oldCls, newCls) {
  for (const [target, source] of [[oldCls.prototype, newCls.prototype], [oldCls, newCls]]) {
    for (const key of Reflect.ownKeys(source)) {
      if (['prototype', 'length', 'name', 'constructor'].includes(key)) continue;
      const d = Object.getOwnPropertyDescriptor(source, key);
      try {
        Object.defineProperty(target, key, d);
      } catch {
        // non-configurable: leave it
      }
    }
  }
}

function patchExports(oldExports, newExports) {
  if (oldExports === newExports || oldExports === null || typeof oldExports !== 'object' && typeof oldExports !== 'function') return;
  if (isClass(oldExports) && isClass(newExports)) return patchClass(oldExports, newExports);
  if (typeof newExports !== 'object' || newExports === null) return;
  for (const key of Object.keys(oldExports)) if (!(key in newExports)) delete oldExports[key];
  for (const [key, value] of Object.entries(newExports)) {
    const old = oldExports[key];
    if (isClass(old) && isClass(value)) {
      patchClass(old, value);
      continue;
    }
    try {
      oldExports[key] = value;
    } catch {
      // frozen exports
    }
  }
}

export class AutoReloader {
  constructor() {
    this.mode = 0; // 0 off · 1 only marked files · 2 every file you required
    this.mtimes = new Map(); // filename → mtimeMs
    this.marked = new Set(); // files added with %aimport
  }

  get cache() {
    return require.cache;
  }

  /** Files worth watching: your own, not packages or Node's. */
  watched() {
    return Object.keys(this.cache).filter((f) => !f.includes('/node_modules/') && (this.mode === 2 || this.marked.has(f)));
  }

  /** Remember modification times; with `onlyNew`, only for files required since the last look. */
  snapshot(onlyNew = false) {
    for (const f of Object.keys(this.cache)) {
      if (onlyNew && this.mtimes.has(f)) continue;
      try {
        this.mtimes.set(f, fs.statSync(f).mtimeMs);
      } catch {
        // gone
      }
    }
  }

  /** Reload changed files; returns [{file, error?}]. `force` reloads every watched file. */
  check(force = false) {
    const done = [];
    for (const file of this.watched()) {
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const before = this.mtimes.get(file);
      this.mtimes.set(file, mtime);
      if (!force && (before === undefined || before === mtime)) continue;
      const entry = this.cache[file];
      const oldExports = entry?.exports;
      delete this.cache[file];
      try {
        const fresh = require(file);
        patchExports(oldExports, fresh);
        // keep the old object as the module's exports so later require() calls return what you hold
        if (this.cache[file] && oldExports && typeof oldExports === 'object') this.cache[file].exports = oldExports;
        done.push({ file });
      } catch (error) {
        if (entry) this.cache[file] = entry;
        done.push({ file, error });
      }
    }
    return done;
  }
}
