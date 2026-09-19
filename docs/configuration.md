# Configuration

## Where things live

| Path | Contents |
| --- | --- |
| `~/.config/cinder/config.json` | Settings (this page) |
| `~/.config/cinder/startup/` | `*.js` / `*.mjs` / `*.cjs` files run at startup, in name order |
| `~/.local/share/cinder/history.jsonl` | Input and output history, grouped by session |
| `~/.local/share/cinder/bookmarks.json` | Directory bookmarks from `%bookmark` |
| `~/.local/share/cinder/store/` | Variables saved with `%store` |

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are respected.

## config.json

Every setting is optional. This example shows each one with its default (`//` comments and trailing commas are allowed):

```jsonc
{
  "theme": "void",            // void · nebula · matrix
  "layout": "block",          // block (full-width input bar) · box (rounded box)
  "typescript": "auto",       // auto (when a cell isn't JavaScript) · always · off
  "editingMode": "emacs",     // emacs · vi
  "automagic": true,          // run magics without the % prefix (cd .., pwd, ls)
  "interactivity": "last_expr", // last_expr · all · none · last_expr_or_assign
  "precision": "",            // decimals for printed numbers, e.g. "3" ("" = as JavaScript prints them)
  "autoreload": 0,            // 0 off · 1 only %aimport-ed files · 2 every CommonJS file you require
  "storeAutorestore": false,  // restore %store variables at startup
  "xmode": "context",         // minimal · plain · context · verbose
  "depth": 4,                 // how deep results are printed
  "autoImport": true,         // built-in modules (fs, path, os…) as globals, loaded on first use
  "historyLogOutput": true,   // save a short text form of each result in the history
  "execLines": [],            // code to run at startup, e.g. ["const _ = require('lodash')"]
  "execFiles": [],            // files to run at startup (like %run)
  "aliases": {}               // shell aliases, e.g. {"gs": "git status", "serve": "npx http-server %s"}
}
```

Unknown or invalid keys are reported as a warning when cinder starts; they never stop it from starting.

### Changing settings in a session

```js
%config                 // every setting and its value
%config xmode           // show one
%config xmode=verbose   // change it for this session
%theme nebula           // shortcuts: %theme, %layout, %editmode, %xmode, %depth, %precision, %automagic, %autoreload
```

## Themes

Three palettes, shared by the input bar, the cell chrome, syntax highlighting and printed values:

- **void** — near-black monochrome with a single warm accent (the default)
- **nebula** — violet and cyan
- **matrix** — greens

cinder uses 24-bit color when the terminal supports it and falls back to the nearest 256 colors otherwise. `NO_COLOR` turns colors off.

## Profiles

`cinder --profile work` keeps a separate configuration, startup directory and history under `~/.config/cinder/profiles/work/` and `~/.local/share/cinder/profiles/work/`.

## Startup files

Files in the startup directory run before the first prompt, like `%run`: their top-level variables and functions are available in your session. Use them for helpers you always want:

```js
// ~/.config/cinder/startup/10-helpers.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (value) => console.log(JSON.stringify(value, null, 2));
```

Errors in startup code are reported and skipped. `--no-startup` skips startup files and `execLines`.

## Command-line options

| Option | |
| --- | --- |
| `cinder file.js [args…]` | Run a file and exit (`-i` to stay interactive afterwards) |
| `-e`, `--eval CODE` | Run code and exit |
| `-p`, `--print CODE` | Run code, print the result and exit |
| `-` | Read code from stdin (also when stdin isn't a terminal) |
| `-i`, `--interactive` | Stay interactive after `-e`, `-p` or a file |
| `--profile NAME` | Use a named profile |
| `--theme NAME` | Color theme for this session |
| `--layout NAME` | `block` or `box` |
| `--vi` | vi key bindings |
| `--no-startup` | Skip startup files and `execLines` |
| `--no-history` | Don't read or write the history file |
| `-v`, `--version` · `-h`, `--help` | |
