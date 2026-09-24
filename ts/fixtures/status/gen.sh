#!/usr/bin/env bash
#
# gen.sh — regenerate the status goldens from the LAST BASH status.sh.
#
# The bash status.sh was retired by seam 3; its final version is commit
# 14f675e. This runs that version — never the TypeScript, whatever
# status.sh is today — on make-target.sh's target, under the suite's
# locale (test-lib.sh:58: C.UTF-8, where bash counts characters), and
# writes <view>.expected.txt (ten views). status-views.test.ts compares the TypeScript
# against these byte for byte.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fleet="$(cd "$here/../../.." && pwd)"
BASH_STATUS_SHA=14f675e
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/fleet"
git -C "$fleet" show "$BASH_STATUS_SHA:status.sh" > "$tmp/fleet/status.sh"
cp "$fleet/lib.sh" "$tmp/fleet/lib.sh"       # sourced by dirname; its readers did not change
bash "$here/make-target.sh" "$tmp/t"
run() {                               # run <view> [args…]
  local name="$1"; shift
  env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 FLEET_REGISTRY_DIR="$tmp/t/repos" \
    bash "$tmp/fleet/status.sh" t "$@" > "$here/$name.expected.txt"
}
run default
run epics --epics
run bot --bot
run bot-all --bot --all
run json --json
run one 900
run bot-one --bot 900
run epics-bot --epics --bot                  # the flags are independent: --epics wins, --bot shapes it
run json-bot --json --bot
run epics-json --epics --json
echo "goldens written from status.sh@$BASH_STATUS_SHA"
