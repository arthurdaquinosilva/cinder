// Where was a function defined? V8 knows ([[FunctionLocation]]); an in-process inspector session asks it.
// The session answers synchronously, and the debugger is switched off again straight away.

import { Session } from 'node:inspector';

/** {file, line, column} (1-based line) for a function, or null for built-ins and bound functions. */
export function functionLocation(fn) {
  if (typeof fn !== 'function') return null;
  const session = new Session();
  const scripts = new Map();
  let location = null;
  try {
    session.connect();
    session.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
    session.post('Debugger.enable');
    globalThis.__cinder_locate__ = fn;
    session.post('Runtime.evaluate', { expression: '__cinder_locate__' }, (err, res) => {
      if (err || !res?.result?.objectId) return;
      session.post('Runtime.getProperties', { objectId: res.result.objectId, ownProperties: true }, (err2, props) => {
        const loc = props?.internalProperties?.find((p) => p.name === '[[FunctionLocation]]')?.value?.value;
        if (loc) location = { scriptId: loc.scriptId, line: loc.lineNumber + 1, column: loc.columnNumber + 1 };
      });
    });
    session.post('Debugger.disable');
  } catch {
    return null;
  } finally {
    delete globalThis.__cinder_locate__;
    session.disconnect();
  }
  if (!location) return null;
  const file = scripts.get(location.scriptId);
  if (!file) return null;
  let path = file.replace(/^file:\/\//, '');
  try {
    path = decodeURIComponent(path); // cells are named `[cell 3]`, which arrives as `[cell%203]`
  } catch {
    // not encoded
  }
  return { file: path, line: location.line, column: location.column };
}
