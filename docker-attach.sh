#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "Detach without stopping with Ctrl-P, Ctrl-Q."
docker attach zenitmc-afk-manager
