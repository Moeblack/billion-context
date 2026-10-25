#!/usr/bin/env bash
# Push the freshly built dist into every host that runs billion-context.
# One source tree, one build, N installs — add a line per new host.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist"
STAMP="$(date +%Y%m%d-%H%M%S)"

TARGETS=(
  "$HOME/.dsh/profiles/web/node_modules/billion-context"
  "$HOME/.local/share/billion-context-omp-fork"
)

for t in "${TARGETS[@]}"; do
  if [ ! -f "$t/dist/index.js" ]; then
    echo "skip  $t (not installed)"
    continue
  fi
  cp -a "$t/dist/index.js" "$t/dist/index.js.bak-$STAMP"
  cp -a "$SRC/index.js" "$t/dist/index.js"
  echo "sync  $t"
done

echo "done — restart each host for the change to take effect:"
echo "  systemctl --user restart dsh-web"
echo "  (omp: restart the omp session; its fork is respawned by the launcher)"
