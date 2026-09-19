# Features

## The interface

Each cell you run becomes a block:

```text
> greet("Ada", 2)
│
│ 'hi Ada! hi Ada! '
│
╰─ ✓ 1.4ms · string · 16 chars · Out[2]
```

- The footer shows success or the error's name (`✗ TypeError`, `✗ exit 3` for a failing shell command), how long the cell took, the result's type and size, and where it's stored (`Out[2]`, also `_2` and `_`).
- Output printed while the cell runs appears on the rail as it happens; lines written to stderr get a red rail. Cells slower than a quarter second show a spinner — it runs in a worker thread, so it keeps turning even while your code blocks the main thread. Ctrl+C interrupts.
- Output from timers and promises that fires while you're typing appears above the input instead of corrupting it.
- Below the input: the **key bar** shows the keys that make sense right now (or the signature of the call you're typing), and the **mode line** shows the Node version, the `package.json` name in the current directory, the directory and the last cell's status.

### Typing

- **Enter** runs the cell when it's complete. Inside an unfinished block (an open `{`, `(`, `[`, template string or comment) it adds an indented new line. Enter on two blank lines runs an unfinished cell anyway, to show its syntax error.
- **Shift+Enter**, Alt+Enter or Ctrl+J always insert a newline.
- **Auto-indent** after an opening bracket or `=>`; typing `}`, `)` or `]` at the start of a line dedents it. Backspace in indentation removes a whole level; Shift+Tab dedents.
- **Grey suggestions** come from your history; → (or Ctrl+E / Ctrl+F at the end) accepts them. ↑/↓ walk history entries that start with what you've typed; Ctrl+R searches all of it.
- **Pasting** code copied from a Node REPL session works: `> ` / `... ` prompts are removed and the output lines between them dropped.
- **Ctrl+O** (or F2) opens the cell in `$VISUAL` / `$EDITOR`. Ctrl+Z suspends cinder; `fg` brings it back.
- Emacs keys: Ctrl+A/E, Alt+B/F (or Alt/Ctrl+arrows), Ctrl+W, Alt+D, Ctrl+K, Ctrl+U, Ctrl+Y, and Ctrl+_ to undo.
- `\alpha` Tab → `α`: Greek letters (valid in JavaScript names) and common symbols (`\sum` ∑, `\to` →, `\le` ≤…).

### vi mode

Start with `--vi`, switch with `%vi` / `%editmode emacs`, or set `"editingMode": "vi"`. The mode shows as `[INSERT]` / `[NORMAL]` in the mode line (in the box title with the box layout), and the cursor is a bar in insert mode and a block in normal mode.

| | |
| --- | --- |
| Modes | `Esc` normal · `i a I A o O` insert · `R` replace · `v` / `V` visual (charwise / linewise) |
| Motions | `h j k l`, `w b e W B E`, `0 ^ $`, `gg G`, `f F t T` with `;` `,`, `%` — all take counts (`3w`) |
| Operators | `d c y > <` with a motion or text object (`dw`, `c$`, `y2j`), doubled for lines (`dd`, `cc`, `yy`, `>>`) |
| Text objects | `iw aw iW aW`, `i( a( ib`, `i[ a[`, `i{ a{ iB`, `i< a<`, `i" a" i' a' i\` a\`` |
| Editing | `x X s S C D Y r ~ J p P`, `u` undo, `Ctrl+R` redo, `.` repeats the last change |
| Visual | move to select, then `d x c s y > < ~ u U`; `o` swaps the ends |
| The prompt | `Enter` runs a complete cell; `j`/`k` on the last/first line walk history; `/` searches history |

In insert mode the usual editing keys (Tab completion, Ctrl+R history search, Ctrl+O editor…) keep working.

### Layouts

`block` (the default) is the full-width input bar with the key bar and mode line. `box` is ember's classic look: the input in a rounded box titled `In [N]`, and one status line with the environment on the left and key hints on the right. Switch with `--layout box`, `%layout box` or `"layout": "box"`.

### Signature hints

While you type inside a call, its signature replaces the key bar, with the current argument highlighted:

```text
ƒ greet(name: string, times: number = 1) → string
```

Parameters come from the function's own source (defaults, rest parameters, destructuring). Types come from, in order: a JSDoc comment above the function in one of your cells (`@param {number} a`, `@returns {string}`); the value you're passing (`"Ada"` → `string`); the parameter's default; and for return types, the function's body (`Promise` for async functions, `Generator` for generators, `undefined` when it never returns a value, simple literal returns). Inferred types are shown in muted italics. Built-ins such as `JSON.stringify`, `Math.max` and the common array, string, `Map` and `Promise` methods have no JavaScript source, so their signatures come from a table in cinder. Long signatures collapse to fit: defaults go first, then parameters far from the cursor.

## Input syntax

| Syntax | Meaning |
| --- | --- |
| `obj?` / `obj??` | Inspect: type, signature, prototype chain, keys, methods and value / plus the source of functions and classes |
| `Math.*round*?` | Search names with wildcards (`%psearch` for the same with a plain word) |
| `!cmd` | Run a shell command, streaming its output. `!name` is JavaScript negation when `name` is one of your variables |
| `$name`, `${expr}`, `{expr}` | Put JavaScript values into shell commands; `$$` for a literal `$`. Environment variables like `$HOME` are left to the shell |
| `%magic args` | Line magic ([reference](magics.md)). Magic lines can be mixed into JavaScript cells |
| `cd ..`, `pwd`, `ls -la` | Magics and aliases without `%` (automagic): used when the name isn't one of your variables and what follows it isn't JavaScript (`=`, `(`, `.`, an operator…). `%automagic off` turns it off |
| `name` of a macro | Runs the macro (`%macro`) |
| `%%magic` | Cell magic, on the first line |
| `await …` | Top-level await |
| `import … from "…"` | Import statements work in cells (they're loaded with `import()`); `export` is ignored so module code can be pasted |
| `exit`, `.exit`, Ctrl+D | Leave |

Variables kept for you: `_` (the last result), `_N` and `Out` (results), `_iN` and `In` (inputs), `_error` (the last error). Assign to `_` or `_error` yourself and cinder stops updating it, as Node's REPL does.

Built-in modules are globals, loaded the first time you use them: `fs.readdirSync(".")`, `path.join(…)`, `os.cpus()`. `require` is there too, resolving from the current directory.

## How cells run

Cells run in Node's main JavaScript context, the same way Node's own REPL does, so objects behave normally (`instanceof Array` works) and `process`, `Buffer` and friends are the real ones.

- **Declarations persist.** Top-level `let`, `const` and `class` become global bindings, so the next cell sees them — and you can declare them again after fixing a typo. (The trade-off: reassigning a top-level `const` doesn't throw.)
- **Top-level await.** Cells that use `await` or `import` at the top level run inside an async function; their declarations are hoisted to globals and the value of the last expression is returned. Line numbers in errors stay exact.
- **`{a: 1}` alone is an object**, not a block.
- **The last expression is the result.** Statements (declarations, loops, `if`) show no result. The `interactivity` setting changes this: `all` shows every top-level expression, `last_expr_or_assign` also shows `x` after `const x = …`, `none` shows nothing.
- **`process.exit()`** in a cell ends cinder cleanly; in a file run with `%run` it only ends the file.
- **Ctrl+C** stops a synchronous loop right away. For `await`, it stops waiting: the cell ends as interrupted, but timers and promises it started keep running in the background.

## TypeScript

Type TypeScript straight into cells — types, interfaces, type aliases, generics, `as`, `!`, `satisfies`, enums, namespaces, parameter properties (`constructor(private x: number)`):

```ts
> interface User { name: string; age?: number }
> enum Role { Admin = "admin", Guest = "guest" }
> function first<T>(xs: T[]): T | undefined {
    return xs[0]
  }
> first<User>([{ name: "ada" }])?.name
│
│ 'ada'
```

- **How it runs.** A cell that is valid JavaScript runs as JavaScript. Otherwise it is compiled as TypeScript with Node's built-in compiler (`module.stripTypeScriptTypes`, Node 22.13+). Plain type syntax is blanked out in place, so error lines and columns are exact; enums, namespaces and parameter properties need real code generation, and a source map puts their errors back on your lines. Types are not *checked* — like `tsx` or Node itself, cinder runs your code without a type checker (run `tsc --noEmit` for that).
- **Files.** `%run file.ts` (and `.mts`, `.cts`) compiles the file first. `import … from "./model.ts"` and `require("./legacy.cts")` in cells compile imported TypeScript too, enums included, and stack traces point at the `.ts` lines (Node 22.15+).
- **Older Node.** Without Node's compiler, cinder uses the `typescript` package when the project has it (`npm i -D typescript`).
- **The `typescript` setting.** `auto` (the default) as above; `always` compiles every cell as TypeScript — for code where the two languages disagree, like `f<T>(x)`, which JavaScript reads as comparisons; `off` never does.
- **Help while typing.** Enter keeps an unfinished `interface User {` open, TypeScript keywords and type names are highlighted, and signature hints show the types you declared — `ƒ pick<T, K extends keyof T>(obj: T, keys: K[]) → Pick<T, K>`.

## Display

Results are printed with Node's `util.inspect`, colored with the theme, as deep as the `depth` setting (4 by default; `%depth Infinity` for everything). Objects can customise their display with `[Symbol.for('nodejs.util.inspect.custom')]`, as in Node.

- `%precision 3` prints non-integer numbers with 3 decimals — in arrays, objects, Maps and Sets too. Only the display changes.
- `%page` shows a value in full in your pager; `%copy` puts it on the clipboard (strings as they are, other values as JSON).
- `%%capture out` keeps a cell's output instead of printing it: `out.stdout`, `out.stderr`, `out.outputs`, and `out()` prints it all.

## Errors and debugging

### How errors look

```text
> function f(x) {
    return x.y.z
  }
  f({})
│
│ ✗ TypeError: Cannot read properties of undefined (reading 'z')
│   at f · cell 8:2
│       1 │ function f(x) {
│     ❱ 2 │   return x.y.z
│         │              ^
│       3 │ }
│   at cell 8:4
│     ❱ 4 │ f({})
│
╰─ ✗ TypeError · 686.1µs
```

Frames inside Node and cinder are hidden. Extra fields on the error (`code: 'ENOENT'`) are listed under the message, and `cause` chains and `AggregateError` members are shown below the frames.

`%xmode` chooses the format: `minimal` (one line), `plain` (Node's standard stack), `context` (the default, above) or `verbose` (every frame, including Node's internals and packages, with source around each). `%tb` shows the last error again, optionally in another format: `%tb verbose`.

### Looking at code

`obj?` includes the file and line where a function or class was defined (`cell 3:1` for your cells). `%pdef fn` prints just the signature, `%pdoc fn` its JSDoc, `%psource fn` its source, and `%pfile fn` the file around its definition.

### Debugging

`%debugger` opens the V8 inspector. Attach Chrome DevTools from `chrome://inspect`, or VS Code with "Attach to Node Process"; a `debugger;` statement in your code then pauses there with the full debugger — breakpoints, stepping, watches. `%debugger -w` waits until a debugger has attached; `%debugger off` closes the inspector.

### Profiling

`%profile expr` (or `%%profile` for a whole cell) runs the code under the V8 CPU profiler and lists where the time went, by self time per function. `%time` gives wall and CPU time; `%timeit` repeats a statement to get a steady per-loop time.

## History and sessions

History is kept as JSON lines, grouped by session, including a short text form of each result.

```js
%history              // this session
%history -n 4-6 ~1/   // lines 4–6 of this session and all of the previous one
%history -g "fetch*"  // search every session
%history -l 20 -o     // the last 20 lines with their outputs
%history -p -f log.js // with > prompts, written to a file
%recall 12            // put line 12 back into the input for editing
%rerun -l 3           // run the last three lines again
%save work.js 1-10    // write lines to a file
%load -r 5-20 app.js  // load lines of a file into the input
```

Range syntax: `4`, `4-6` (inclusive), `4:6` (end exclusive), `4-` (to the end), `~1/` (the whole previous session), `~2/3-5`.

```js
%macro setup 1-4      // typing `setup` now runs lines 1–4
%store data helpers   // keep variables across sessions (%store -r to restore, "storeAutorestore": true to do it at startup)
%logstart -o -t       // log every cell, with results and timestamps, to cinder_log.js
%paste                // run the code on the clipboard; %cpaste reads a pasted block until --
```

`%store` saves values with the structured clone algorithm (objects, arrays, `Map`, `Set`, `Date`, typed arrays, errors…) and functions as their source.

## Running files

`%run file.js [args…]` runs a file in your session: its top-level variables and functions become yours. While it runs, `require`, `import`, `import.meta.url`, `__filename`, `__dirname` and `process.argv` point at the file. `.ts`, `.mts` and `.cts` files are compiled as TypeScript first ([TypeScript](#typescript)). `-t` prints how long the file took.

## Reloading code

`%autoreload 2` reloads CommonJS files you edited before each cell, and updates what you already have: the old `module.exports` object gets the new functions, and classes get the new methods — so `lib.fn()` and existing instances run the new code. (Functions you destructured, `const { fn } = require(…)`, keep the old version.) `%autoreload 1` limits this to files marked with `%aimport ./lib.js`; `%autoreload` alone reloads changed files now. ES modules can't be unloaded by Node, so they aren't reloaded — `await import('./lib.mjs?v=2')` loads a fresh copy.

## Shell and files

- `!cmd` runs a command in `$SHELL`, streaming its output; `%sx cmd` returns the output as an array of lines.
- `%cd` with `-` (the previous directory), `-N` (entry N of `%dhist`), `-b name` (a bookmark) and bookmark names as a fallback. `require()` and `import` follow the current directory.
- `%pushd` / `%popd` / `%dirs`, and `%dhist` for every directory you visited.
- `%bookmark name [dir]`, `%bookmark -l`, `%bookmark -d name`.
- `%alias name command` with `%s` placeholders or `%l` for the rest of the line; defaults include `%ls`, `%ll`, `%cat`, `%cp`, `%mv`, `%rm`, `%mkdir`.
- `%%bash`, `%%sh`, `%%zsh`, `%%node` (a separate Node process), `%%python`, `%%ruby`, `%%perl`, `%%deno`, `%%bun`, or `%%script program` run a cell with another program. `-o`/`--out var` and `--err var` capture its output into variables; `--bg` runs it in the background and reports when it finishes (`%killbgscripts` stops those jobs).
- `%%writefile path` writes a cell to a file. `%env` reads and sets environment variables. `%npm install pkg` installs into the current directory.

## Completion

- Global names, your variables first, with an icon for each kind (ƒ function, ◇ class, ▣ module, ● value, ◦ property, ⌘ keyword).
- Properties after `.`, from the live object — reached through plain member chains like `a.b["c"].d`, which cinder looks up without calling anything. Literals work too: `"abc".` and `[1, 2].`.
- Keys inside brackets: `config["da` → `config["database"]`.
- Module names inside `require("` and `import … from "`: built-ins and the packages in `node_modules`.
- File paths in strings that look like paths (`"./`), after `%run`, `%cd`, `%load` and friends, and in `!` commands.
- Magic names after `%` and `%%`.
- Unicode after a backslash: `\alpha` → `α`.
