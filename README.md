<div align="center">

<img src="https://raw.githubusercontent.com/arthurdaquinosilva/cinder/main/docs/assets/cover.svg?sanitize=true" alt="cinder's start screen: the pixel CINDER: wordmark, version and environment info, the input bar and the key bar" width="900">

# ✦ cinder

**A modern, beautiful interactive JavaScript and TypeScript shell for Node.**
Node's REPL, rebuilt around a calm terminal UI — with IPython-style magics, history, timing and live help.

[![npm](https://img.shields.io/npm/v/cinder-shell)](https://www.npmjs.com/package/cinder-shell)
[![tests](https://github.com/arthurdaquinosilva/cinder/actions/workflows/tests.yml/badge.svg)](https://github.com/arthurdaquinosilva/cinder/actions/workflows/tests.yml)
[![node](https://img.shields.io/badge/node-20.12%20%7C%2022%20%7C%2024-blue)](https://github.com/arthurdaquinosilva/cinder/blob/main/package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](https://github.com/arthurdaquinosilva/cinder/blob/main/LICENSE)

</div>

## See it in action

<p align="center">
<img src="https://raw.githubusercontent.com/arthurdaquinosilva/cinder/main/docs/assets/demo.svg?sanitize=true" alt="cinder running in a terminal: cells with results and timing, an import, %timeit, and a signature hint while typing a call" width="820">
</p>

cinder is the JavaScript sibling of [ember](https://github.com/arthurdaquinosilva/ember), the Python shell — same look, same keys, same habits.

## Why cinder

- **Readable sessions.** Every cell is a block: your code, its output on a rail, and a footer with status, time, result type and `Out[N]`.
- **Help while you type.** Completions from your live objects with type icons, and signatures for the call under the cursor — `ƒ greet(name, times: number = 1)` — with types from JSDoc, defaults and the values you're passing.
- **TypeScript too.** Types, interfaces, generics, enums and namespaces work in cells, in `%run file.ts` and in the `.ts` files you import — compiled with Node's own TypeScript support, errors on your lines.
- **A REPL that forgives.** `const` and `class` can be declared again, `await` and `import` work at the top level, `{a: 1}` is an object, and code pasted from a Node session loses its `>` prompts.
- **Everything you reach for.** 78 magics: `%timeit`, `%time`, `%profile`, `%run file.js` (TypeScript too), `obj?`, `!shell`, `%cd`, `%history` across sessions, `%store`, `%macro`, `%%capture`, `%autoreload`, `%debugger` for Chrome DevTools… and `cd ..` or `pwd` work without the `%`.
- **Errors you can read.** The failing line from your cell with a caret under the problem, your frames only, causes included.
- **Feels good.** A spinner that keeps turning during blocking code, Ctrl+C that interrupts loops and awaits, Shift+Enter for new lines, vi or emacs keys, three themes, two layouts.

## Install

```sh
npm install -g cinder-shell    # the `cinder` command everywhere
npx cinder-shell               # or try it without installing
```

The package is `cinder-shell` on npm; the command is `cinder`. Requires Node 20.12 or newer on macOS or Linux; TypeScript needs Node 22.13+ (22.15+ to import `.ts` files), or the `typescript` package in your project.

> **Tip:** `require()` and `import` resolve from the directory you're in, so run cinder inside a project to use its packages (`%npm install lodash` works too).

## Quick tour

```js
> const users = await fetch("https://api.github.com/users/octocat").then((r) => r.json())
> users.login                    // Out[2] · also _ and _2
> users?                         // inspect: type, keys, methods, value (?? shows source)
> import { readFile } from "node:fs/promises"
> fs.readdirSync(".")            // built-in modules are globals, loaded on first use
> !ls -la                        // shell commands; $name puts JS values in
> %timeit JSON.parse(text)       // automatic loop count, mean ± std
> enum Role { Admin, Guest }     // TypeScript works in cells
> %run scripts/seed.ts           // run a file in the session (TypeScript compiled)
> %history -g fetch              // search history across sessions
> %help                          // every key, syntax and magic
```

| | |
| --- | --- |
| **Enter** | run the cell (adds a newline while a block is unfinished) |
| **Shift+Enter** · Alt+Enter · Ctrl+J | insert a newline |
| **Tab** / Shift+Tab | complete · indent / dedent |
| **→** | accept the grey suggestion from history |
| **↑ ↓** · Ctrl+R | history · search history |
| **Ctrl+O** | edit the cell in `$EDITOR` |
| **Ctrl+C** · **Ctrl+D** | clear input / interrupt · exit |
| **Esc** (with `--vi`) | normal mode: motions, operators, text objects, visual mode, `.` |

Shift+Enter needs a terminal that reports modified keys (iTerm2, WezTerm, Ghostty, kitty, xterm; inside tmux set `extended-keys on`). Alt+Enter and Ctrl+J work everywhere.

## Documentation

| Guide | What's inside |
| --- | --- |
| [Features](https://github.com/arthurdaquinosilva/cinder/blob/main/docs/features.md) | The interface, input syntax, how cells run, display, errors and debugging, history, shell, completion |
| [Magic reference](https://github.com/arthurdaquinosilva/cinder/blob/main/docs/magics.md) | All magics with options (generated from the code) |
| [Configuration](https://github.com/arthurdaquinosilva/cinder/blob/main/docs/configuration.md) | `config.json`, themes, profiles, startup files, command-line options |
| [Releasing](https://github.com/arthurdaquinosilva/cinder/blob/main/docs/releasing.md) | How versions are published to npm |

## Command line

```sh
cinder                        # interactive
cinder script.js args…        # run a file (-i to stay interactive afterwards)
cinder -e "code"              # run code · -p "expr" prints its value
echo 'console.log(6 * 7)' | cinder   # code on stdin
cinder --profile work --theme nebula --vi --layout box --no-startup
```

## Limits

- Top-level `const` becomes re-declarable in cells (that's the point), so reassigning it doesn't throw.
- Ctrl+C stops synchronous code and stops *waiting* for async code; timers and promises a cell started keep going.
- Full-screen programs inside `!cmd` (vim, htop) aren't supported — use `%edit` or Ctrl+O for editing.
- `%autoreload` works for CommonJS files; ES modules can't be unloaded by Node.
- TypeScript is compiled, not type-checked (like `tsx` and Node itself); decorators and JSX aren't supported.
- There's no post-mortem debugger like IPython's `%debug`: a debugger can't pause the thread it runs on. `%debugger` connects Chrome DevTools or VS Code instead.

## Development

```sh
git clone https://github.com/arthurdaquinosilva/cinder.git && cd cinder
npm install
npm test                          # unit tests + a real-terminal test (uses tmux when installed)
npm run docs                      # regenerate docs/magics.md
node scripts/screenshot.js        # re-record docs/assets/*.svg from a real session (needs tmux)
docker build -t cinder-test .     # run the tests in a clean Linux container
```

## License

MIT © Arthur D'Aquino
