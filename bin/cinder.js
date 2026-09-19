#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main(process.argv.slice(2));
// process.exit is wrapped by the shell; call the real one so timers left by user code don't keep us alive.
(process.exit.__cinder ?? process.exit)(code ?? 0);
