#!/bin/sh
set -eu

NODE_VERSION=22.20.0

case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH=arm64 ;;
  x86_64|amd64) NODE_ARCH=x64 ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  apt-get update
  apt-get install -y ca-certificates python3 make g++ wget xz-utils
elif command -v sudo >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates python3 make g++ wget xz-utils
else
  printf 'Run this script as root or install sudo.\n' >&2
  exit 1
fi

NODE_ROOT="$HOME/.local/node-v$NODE_VERSION-linux-$NODE_ARCH"
NODE_ARCHIVE="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION"

if [ ! -x "$NODE_ROOT/bin/node" ]; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT INT TERM
  wget -q "$NODE_URL/$NODE_ARCHIVE" -O "$TEMP_DIR/$NODE_ARCHIVE"
  wget -q "$NODE_URL/SHASUMS256.txt" -O "$TEMP_DIR/SHASUMS256.txt"
  EXPECTED="$(awk -v file="$NODE_ARCHIVE" '$2 == file { print $1 }' "$TEMP_DIR/SHASUMS256.txt")"
  [ -n "$EXPECTED" ]
  printf '%s  %s\n' "$EXPECTED" "$TEMP_DIR/$NODE_ARCHIVE" | sha256sum -c -
  mkdir -p "$HOME/.local"
  tar -xJf "$TEMP_DIR/$NODE_ARCHIVE" -C "$HOME/.local"
fi

export PATH="$NODE_ROOT/bin:$PATH"
PROFILE_LINE="export PATH=\"$NODE_ROOT/bin:\$PATH\""
touch "$HOME/.profile"
grep -F "$NODE_ROOT/bin" "$HOME/.profile" >/dev/null 2>&1 || printf '%s\n' "$PROFILE_LINE" >> "$HOME/.profile"

mkdir -p data
npm ci
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('Native SQLite check passed.')"
npm run check
npm test
printf 'Installation completed. Start with: ./start-userland.sh\n'
