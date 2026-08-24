#!/bin/sh
set -eu

NODE_VERSION=22.20.0

case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH=arm64 ;;
  x86_64|amd64) NODE_ARCH=x64 ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

NODE_ROOT="$HOME/.local/node-v$NODE_VERSION-linux-$NODE_ARCH"
if [ -x "$NODE_ROOT/bin/node" ]; then
  export PATH="$NODE_ROOT/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js is missing. Run ./setup-userland.sh first.\n' >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf 'Node.js 22 or newer is required. Run ./setup-userland.sh first.\n' >&2
  exit 1
fi

mkdir -p data
export ZENIT_DATABASE_PATH="${ZENIT_DATABASE_PATH:-$PWD/data/zenitmc.sqlite}"
exec node manager.js "$@"
