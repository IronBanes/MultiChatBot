#!/usr/bin/env bash
# Multichat starter for macOS and Linux.
# Checks for (and offers to install) everything the app needs, then builds and runs it.
#
#   ./start.sh                     run the app
#   ./start.sh --server            also host the relay server for friends
#   ./start.sh --instance bob      run a second local identity
#   ./start.sh --yes ...           install missing pieces without asking
#
# Windows users: run start.cmd instead.

set -euo pipefail
cd "$(dirname "$0")"

MIN_NODE_MAJOR=22
MIN_RUST_MINOR=88 # Rust 1.88+ (the MCP client needs it)
ASSUME_YES=0
PASSTHRU=()
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *) PASSTHRU+=("$arg") ;;
  esac
done

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local reply
  read -r -p "    $1 [Y/n] " reply </dev/tty || return 1
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

sudo_cmd() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux)  PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) die "On Windows, run start.cmd (double-click it, or run .\\start.cmd in a terminal)." ;;
  *) die "Unsupported OS: $OS" ;;
esac

# ---------------------------------------------------------------- system libraries
if [ "$PLATFORM" = mac ]; then
  say "Checking Xcode Command Line Tools"
  if xcode-select -p >/dev/null 2>&1; then
    ok "installed"
  else
    warn "missing (needed to compile the app)"
    xcode-select --install || true
    die "Finish the Xcode Command Line Tools installer that just opened, then run ./start.sh again."
  fi
else
  say "Checking system libraries for Tauri"
  if have pkg-config && have cc && have cmake && pkg-config --exists webkit2gtk-4.1 dbus-1 openssl librsvg-2.0 2>/dev/null; then
    ok "webkit2gtk-4.1, dbus, openssl, librsvg, cmake and a C compiler are installed"
  else
    if have apt-get; then
      PKGS=(build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev
            libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev cmake)
      INSTALL=(apt-get install -y "${PKGS[@]}"); PRE=(apt-get update)
    elif have dnf; then
      PKGS=(webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel
            libxdo-devel dbus-devel pkgconf-pkg-config gcc gcc-c++ make cmake)
      INSTALL=(dnf install -y "${PKGS[@]}"); PRE=(true)
    elif have pacman; then
      PKGS=(webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3
            librsvg xdotool dbus pkgconf cmake)
      INSTALL=(pacman -S --needed --noconfirm "${PKGS[@]}"); PRE=(true)
    else
      die "Could not find apt, dnf or pacman. Install the Tauri prerequisites for your distro
(https://v2.tauri.app/start/prerequisites/#linux) plus the dbus development package, then re-run."
    fi
    warn "some packages are missing: ${PKGS[*]}"
    if confirm "Install them now with sudo?"; then
      sudo_cmd "${PRE[@]}"
      sudo_cmd "${INSTALL[@]}"
      ok "system libraries installed"
    else
      die "System libraries are required to build the app."
    fi
  fi
fi

# ---------------------------------------------------------------- Rust
say "Checking Rust"
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
rust_minor() { rustc --version 2>/dev/null | sed -E 's/^rustc 1\.([0-9]+).*/\1/'; }
if ! have cargo || ! have rustc; then
  warn "Rust is not installed"
  confirm "Install Rust with rustup (https://rustup.rs)?" || die "Rust is required."
  have curl || die "curl is required to install Rust."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
if [ "$(rust_minor)" -lt "$MIN_RUST_MINOR" ] 2>/dev/null; then
  warn "$(rustc --version) is too old (need 1.$MIN_RUST_MINOR or newer)"
  if have rustup; then
    confirm "Update Rust with rustup?" || die "A newer Rust is required."
    rustup update stable && rustup default stable
  else
    die "Your Rust came from the system package manager. Install rustup (https://rustup.rs) or update Rust, then re-run."
  fi
fi
ok "$(rustc --version)"

# ---------------------------------------------------------------- Node.js
say "Checking Node.js"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if ! have node || [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
  if have node; then warn "Node $(node -v) is too old (need $MIN_NODE_MAJOR+)"; else warn "Node.js is not installed"; fi
  if [ "$PLATFORM" = mac ] && have brew; then
    confirm "Install Node.js with Homebrew?" || die "Node.js $MIN_NODE_MAJOR+ is required."
    brew install node
  else
    confirm "Install Node.js $MIN_NODE_MAJOR with nvm (https://github.com/nvm-sh/nvm, installs into your home folder)?" \
      || die "Node.js $MIN_NODE_MAJOR+ is required."
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      have curl || die "curl is required to install nvm."
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
      # shellcheck disable=SC1091
      . "$NVM_DIR/nvm.sh"
    fi
    nvm install "$MIN_NODE_MAJOR"
    nvm use "$MIN_NODE_MAJOR" >/dev/null
  fi
  [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || die "Node.js $MIN_NODE_MAJOR+ is still not on PATH. Open a new terminal and re-run."
fi
ok "Node $(node -v)"

# ---------------------------------------------------------------- build and run
exec node app/scripts/launch.mjs ${PASSTHRU[@]+"${PASSTHRU[@]}"}
