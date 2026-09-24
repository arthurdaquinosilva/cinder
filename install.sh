#!/bin/sh
# Installs cinder straight from GitHub — no npm registry involved:
#
#   curl -fsSL https://raw.githubusercontent.com/arthurdaquinosilva/cinder/main/install.sh | sh
#
# Environment overrides:
#   CINDER_VERSION   branch or tag to install (default: main), e.g. CINDER_VERSION=v0.1.0
#   CINDER_HOME      where the source lives   (default: ~/.local/lib/cinder)
#   CINDER_BIN_DIR   where the command goes   (default: ~/.local/bin)
#
# Pass --uninstall to remove it:  curl -fsSL .../install.sh | sh -s -- --uninstall
#
# The launcher uses `#!/usr/bin/env node`, so it runs on whichever Node is on PATH — switching nvm
# versions keeps the command available (as long as that Node is 20.12+).

set -eu

REPO="arthurdaquinosilva/cinder"
VERSION="${CINDER_VERSION:-main}"
# Not ~/.local/share/cinder: that is cinder's own data dir (history), which updates must never touch.
HOME_DIR="${CINDER_HOME:-$HOME/.local/lib/cinder}"
BIN_DIR="${CINDER_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE="20.12"

say() { printf '%s\n' "$*"; }
err() { printf 'cinder install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# Succeeds when version $1 >= version $2 (major.minor only).
version_ge() {
  a_major=${1%%.*}; a_rest=${1#*.}; a_minor=${a_rest%%.*}
  b_major=${2%%.*}; b_minor=${2#*.}
  [ "$a_major" -gt "$b_major" ] || { [ "$a_major" -eq "$b_major" ] && [ "$a_minor" -ge "$b_minor" ]; }
}

uninstall() {
  rm -f "$BIN_DIR/cinder"
  rm -rf "$HOME_DIR"
  say "Removed cinder ($HOME_DIR and $BIN_DIR/cinder)."
  say "Your history and config (~/.local/share/cinder, ~/.config/cinder) were left in place."
}

download() {
  if has curl; then curl -fsSL "$1"
  elif has wget; then wget -qO- "$1"
  else err "needs curl or wget to download cinder"
  fi
}

main() {
  if [ "${1:-}" = "--uninstall" ]; then uninstall; return; fi

  has node || err "Node.js $MIN_NODE or newer is required (https://nodejs.org or nvm)"
  has npm || err "npm is required to install cinder's dependencies"
  has tar || err "tar is required"
  node_version=$(node -p 'process.versions.node')
  version_ge "$node_version" "$MIN_NODE" || err "Node $node_version is too old; cinder needs $MIN_NODE or newer"

  case "$VERSION" in
    v[0-9]*) ref="refs/tags/$VERSION" ;;
    *) ref="refs/heads/$VERSION" ;;
  esac
  url="https://github.com/$REPO/archive/$ref.tar.gz"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading cinder ($VERSION)..."
  download "$url" | tar -xz -C "$tmp" --strip-components=1 || err "could not download $url"
  [ -f "$tmp/bin/cinder.js" ] || err "the download does not look like cinder ($url)"

  say "Installing dependencies..."
  (cd "$tmp" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) ||
    err "npm could not install cinder's dependencies"

  # Swap the new copy in only once it is complete, so a failed update leaves the old one working.
  mkdir -p "$(dirname "$HOME_DIR")" "$BIN_DIR"
  rm -rf "$HOME_DIR.old"
  [ -d "$HOME_DIR" ] && mv "$HOME_DIR" "$HOME_DIR.old"
  mv "$tmp" "$HOME_DIR"
  rm -rf "$HOME_DIR.old"
  trap - EXIT INT TERM
  chmod +x "$HOME_DIR/bin/cinder.js"
  ln -sf "$HOME_DIR/bin/cinder.js" "$BIN_DIR/cinder"

  say "Installed $("$BIN_DIR/cinder" --version) to $BIN_DIR/cinder"

  case ":$PATH:" in
    *":$BIN_DIR:"*)
      found=$(command -v cinder)
      [ "$found" = "$BIN_DIR/cinder" ] ||
        say "Note: another cinder comes first on PATH ($found); remove it with 'npm uninstall -g cinder-shell' or 'npm unlink -g cinder-shell'."
      ;;
    *)
      say ""
      say "$BIN_DIR is not on your PATH. Add it to your shell profile (~/.zshrc or ~/.bashrc):"
      say "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
  say "Run 'cinder' to start, 'cinder --vi' for vi keys. Re-run this installer to update."
}

main "$@"
