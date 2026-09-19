// Cell output capture: stdout/stderr go through a writer that draws a left rail (│) beside everything a
// cell prints, while a spinner (in a worker thread) shows that a slow cell is still running.

import fs from 'node:fs';
import { MessageChannel, Worker } from 'node:worker_threads';
import { S, SIZE } from './spinner-state.js';

const SPLIT = /(\r\n|\n|\r)/;

export class Spinner {
  constructor(fd, look) {
    this.state = new Int32Array(new SharedArrayBuffer(SIZE * 4));
    Atomics.store(this.state, S.AT_LINE_START, 1);
    this.fd = fd;
    this.enabled = false;
    this.worker = null;
    this.look = look;
    try {
      this.enabled = fs.fstatSync(fd).isCharacterDevice() && process.stdout.isTTY;
    } catch {
      this.enabled = false;
    }
  }

  ensureWorker() {
    if (!this.enabled || this.worker) return;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(new URL('./spinner-worker.js', import.meta.url), {
      workerData: { state: this.state, fd: this.fd, look: this.look, port: port2 },
      transferList: [port2],
      stdout: false,
      stderr: false,
    });
    this.worker.unref();
    this.port.unref();
    this.worker.on('error', () => { this.enabled = false; });
  }

  setLook(look) {
    this.look = look;
    this.port?.postMessage(look);
  }

  lock() {
    while (Atomics.compareExchange(this.state, S.LOCK, 0, 1) !== 0) Atomics.wait(this.state, S.LOCK, 1, 5);
  }

  unlock() {
    Atomics.store(this.state, S.LOCK, 0);
    Atomics.notify(this.state, S.LOCK);
  }

  start() {
    if (!this.enabled) return;
    this.ensureWorker();
    Atomics.add(this.state, S.GENERATION, 1);
    Atomics.store(this.state, S.PAUSED, 0);
    Atomics.store(this.state, S.RUNNING, 1);
    Atomics.notify(this.state, S.RUNNING);
    Atomics.notify(this.state, S.GENERATION);
  }

  /** Erase the spinner line if it's showing. Caller holds the lock. */
  clear() {
    if (Atomics.load(this.state, S.SHOWN)) {
      fs.writeSync(this.fd, '\r\x1b[2K');
      Atomics.store(this.state, S.SHOWN, 0);
    }
  }

  /** Hide the spinner for a while (e.g. while a cell reads from stdin). */
  pause(paused = true) {
    if (!this.enabled) return;
    this.lock();
    try {
      Atomics.store(this.state, S.PAUSED, paused ? 1 : 0);
      if (paused) this.clear();
    } finally {
      this.unlock();
    }
  }

  stop() {
    if (!this.enabled) return;
    this.lock();
    try {
      Atomics.store(this.state, S.RUNNING, 0);
      Atomics.add(this.state, S.GENERATION, 1);
      Atomics.notify(this.state, S.GENERATION);
      this.clear();
    } finally {
      this.unlock();
    }
  }

  close() {
    if (!this.worker) return;
    Atomics.store(this.state, S.QUIT, 1);
    Atomics.store(this.state, S.RUNNING, 1);
    Atomics.notify(this.state, S.RUNNING);
    this.worker.terminate();
    this.worker = null;
  }
}

/**
 * Writes cell output with a rail prefix on every line. stdout and stderr share one Rail so they agree on
 * where the cursor is. `write(text, stream)` is what the patched process.stdout/stderr.write call.
 */
export class Rail {
  constructor({ prefix, errPrefix, spacer = true, spinner = null, sink }) {
    this.prefix = prefix;
    this.errPrefix = errPrefix ?? prefix;
    this.spacer = spacer;
    this.spinner = spinner;
    this.sink = sink; // (text) => void — writes to the real terminal
    this.atLineStart = true;
    this.wrote = false;
  }

  setAtLineStart(v) {
    this.atLineStart = v;
    if (this.spinner?.enabled) Atomics.store(this.spinner.state, S.AT_LINE_START, v ? 1 : 0);
  }

  write(text, isErr = false) {
    if (!text) return;
    const spinner = this.spinner?.enabled ? this.spinner : null;
    spinner?.lock();
    try {
      spinner?.clear();
      const prefix = isErr ? this.errPrefix : this.prefix;
      let out = '';
      if (this.spacer && !this.wrote && this.atLineStart) out += this.prefix.trimEnd() + '\n'; // room below the code
      let atStart = this.atLineStart;
      for (const piece of text.split(SPLIT)) {
        if (!piece) continue;
        if (piece === '\n' || piece === '\r\n') {
          if (atStart) out += prefix.trimEnd();
          out += '\n';
          atStart = true;
        } else if (piece === '\r') {
          out += '\r';
          atStart = true;
        } else {
          if (atStart) out += prefix;
          atStart = false;
          out += piece;
        }
      }
      this.sink(out);
      this.wrote = true;
      this.setAtLineStart(atStart);
    } finally {
      spinner?.unlock();
    }
  }

  /** End the rail: finish a partial line and leave a blank rail line above the footer. */
  finish() {
    const spinner = this.spinner?.enabled ? this.spinner : null;
    spinner?.lock();
    try {
      spinner?.clear();
      let out = '';
      if (!this.atLineStart) out += '\n';
      if (this.wrote && this.spacer) out += this.prefix.trimEnd() + '\n';
      if (out) this.sink(out);
      this.setAtLineStart(true);
    } finally {
      spinner?.unlock();
    }
  }
}
