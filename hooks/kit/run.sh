#!/bin/sh
# Runs hooks/kit/*.kit.ts with `claude plugin test` in a scratch plugin root.
# The repo root cannot host them: the engine loads every *.test.ts under the
# root, and the bun tests there import bun:test, which it refuses.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d /tmp/cdx-kit.XXXXXX)
rsync -a --exclude '*.test.ts' --exclude '*.test.py' --exclude kit \
  --exclude node_modules --exclude .git --exclude .codegraph --exclude docs --exclude assets \
  "$repo/" "$scratch/"
for kit in "$repo"/hooks/kit/*.kit.ts; do
  cp "$kit" "$scratch/hooks/$(basename "$kit" .kit.ts).test.ts"
done
cd "$scratch"
CDX_STATE_HOME="$scratch/state" claude plugin test
