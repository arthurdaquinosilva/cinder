# Changelog

## 0.1.0

- First version, modelled on ember — an interactive JavaScript and TypeScript shell: pixel `CINDER:` banner, full-width input bar with syntax highlighting, context-aware key bar and mode line, cells with a rail and timing footers, three themes (void, nebula, matrix).
- **Running code**: cells run in Node's main context; `let`/`const`/`class` persist and can be declared again; top-level `await` and `import`; `{a: 1}` is an object; `_`, `_N`, `Out`, `In`, `_error`; built-in modules as lazy globals; `require` from the current directory.
- **Help while typing**: completions from live objects (members, literals, keys, modules, paths, magics), signature hints with JSDoc, default and argument types, grey history suggestions.
- **Input**: smart Enter, Shift+Enter via modifyOtherKeys/CSI-u, auto-indent and dedent, bracket matching, bracketed paste with Node REPL prompts stripped, Ctrl+R search, Ctrl+O editor, emacs keys, undo, Ctrl+Z.
- **Errors**: your code around each frame with a caret, internals hidden, causes and extra fields; `%xmode` minimal · plain · context · verbose.
- **Magics** (78): `%timeit`, `%time`, `%profile`, `%run` (TypeScript via type stripping), `%load`, `%edit`, `%paste`, `%cpaste`, `%debugger`, `%history`, `%recall`, `%rerun`, `%save`, `%macro`, `%store`, `%logstart`, `%%capture`, `%tb`, `%autoreload` / `%aimport` (CommonJS, updating existing objects and class methods), `%cd`, `%pushd` / `%popd` / `%dirs` / `%dhist`, `%bookmark`, `%sx`, `%alias`, `%env`, `%npm`, `%copy`, `%page`, `%precision`, `%who`, `%whos`, `%who_ls`, `%reset`, `%reset_selective`, `%del`, `%pdef`, `%pdoc`, `%psource`, `%pfile`, `%config`, `%theme`, `%layout`, `%editmode`, `%lsmagic`, `%help`, `%%bash`, `%%node` and other interpreters (with `--bg` and `%killbgscripts`), `%%writefile`…
- **TypeScript**: types, interfaces, generics, `as`/`!`/`satisfies`, enums, namespaces and parameter properties in cells, `%run file.ts`, and imported/required `.ts` files; compiled with Node's `module.stripTypeScriptTypes` (or the project's `typescript` package), errors mapped to your lines, TypeScript-aware smart Enter, highlighting and signature hints; `typescript` setting (auto · always · off).
- **vi mode** (`--vi`, `%vi`, `editingMode`): normal, insert, replace and visual modes; counts, motions, `f`/`t`, text objects, operators, registers, undo/redo, `.`; `[INSERT]` / `[NORMAL]` in the mode line and a matching cursor shape.
- **Box layout** (`--layout box`, `%layout box`): ember's rounded box with `In [N]` in the title and a single status line.
- **Automagic**: `cd ..`, `pwd`, `ls -la` work without `%` when the line isn't JavaScript.
- `interactivity` (last_expr · all · none · last_expr_or_assign), `%precision`, `\alpha` → α completion, `obj?` shows where a function was defined.
- Ctrl+C interrupts synchronous loops and `await`; a spinner in a worker thread keeps turning while code blocks.
- Output from timers and promises appears above the prompt while you type.
- Sessioned history in JSON lines, `config.json`, profiles, startup files, `-e`/`-p`/file/stdin batch modes.
