// Runs cells (JSON array on stdin) in a fresh shell and writes [{out, ok, value}] as JSON to fd 3.
// Tests use it through runCells() so cell output never mixes with the test runner's own stdout.

import fs from 'node:fs';
import util from 'node:util';
import { makeShell, run } from '../helpers.js';

const cells = JSON.parse(fs.readFileSync(0, 'utf8'));
const { shell, stdout } = makeShell({}, { profile: Boolean(process.env.XDG_DATA_HOME) });
const results = [];
for (const cell of cells) {
  try {
    const r = await run(shell, stdout, cell);
    results.push({ out: r.out, ok: r.ok, value: util.inspect(r.value, { depth: 4 }) });
  } catch (e) {
    results.push({ out: stdout.take(), thrown: e.constructor.name, code: e.code });
  }
}
fs.writeSync(3, JSON.stringify(results));
shell.close();
(process.exit.__cinder ?? process.exit)(0);
