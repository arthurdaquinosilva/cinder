// The "running" spinner. It lives in a worker thread so it keeps turning while the main thread is busy
// running synchronous user code; the rail writer and the spinner share a lock in a SharedArrayBuffer.

import fs from 'node:fs';
import { receiveMessageOnPort, workerData } from 'node:worker_threads';
import { formatDuration } from './text.js';
import { S } from './spinner-state.js';

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const { state, fd, port } = workerData;
let look = workerData.look; // {before, frameOpen, after, timeOpen, hint, reset}
let generation = 0;
let started = 0;
let frame = 0;

function lock() {
  while (Atomics.compareExchange(state, S.LOCK, 0, 1) !== 0) Atomics.wait(state, S.LOCK, 1, 5);
}

function unlock() {
  Atomics.store(state, S.LOCK, 0);
  Atomics.notify(state, S.LOCK);
}

for (;;) {
  Atomics.wait(state, S.RUNNING, 0, 1000); // sleep while idle
  let msg;
  while ((msg = receiveMessageOnPort(port))) look = msg.message;
  if (Atomics.load(state, S.QUIT)) break;
  if (!Atomics.load(state, S.RUNNING)) continue;
  const gen = Atomics.load(state, S.GENERATION);
  if (gen !== generation) {
    generation = gen;
    started = performance.now();
    frame = 0;
  }
  Atomics.wait(state, S.GENERATION, gen, 80);
  const elapsed = (performance.now() - started) / 1000;
  if (elapsed < 0.25) continue;
  lock();
  try {
    if (Atomics.load(state, S.RUNNING) && !Atomics.load(state, S.PAUSED) && Atomics.load(state, S.AT_LINE_START)
        && Atomics.load(state, S.GENERATION) === generation) {
      const text = `\r\x1b[2K${look.before}${look.frameOpen}${FRAMES[frame % FRAMES.length]}${look.after}`
        + `${look.timeOpen}${formatDuration(elapsed)}${look.hint}${look.reset}`;
      fs.writeSync(fd, text);
      Atomics.store(state, S.SHOWN, 1);
      frame++;
    }
  } catch {
    // the terminal went away; nothing useful to do
  } finally {
    unlock();
  }
}
