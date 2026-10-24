#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 24 LTS first.' >&2; exit 1; }
if [ ! -f .env ]; then
  (umask 077; cp .env.example .env)
fi
if [ ! -d node_modules ]; then npm ci; fi
exec node server.js
