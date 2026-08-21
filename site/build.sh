#!/usr/bin/env bash
#
# Assembles site/public from its three sources.
#
# public/ is generated in full and gitignored, so there is one rule with no
# exceptions: never edit anything in it. The previous layout mixed hand-written
# pages with copies of loop/ and cli/dist, and the only thing standing between
# you and losing an afternoon's work was remembering which was which.
#
#   site/src/   pages and the installer, hand-written
#   loop/       the skills the installer downloads
#   press/      the collector and renderer the skill calls, shipped as a tarball
#   cli/dist/   the CLI, shipped as a tarball
#
#   ./build.sh          assemble
#   npm run deploy      assemble, then deploy the merged Worker (worker/),
#                       which serves these files as its static assets

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="$here/public"

# Rebuilt from empty every time, so a file deleted from a source cannot linger
# in the deploy directory and keep being served.
rm -rf "$out"
mkdir -p "$out"

cp "$here"/src/* "$out"/

# Downloaded by the installer over HTTP, so they have to exist as real files in
# the served directory — there is no build step on Cloudflare's side.
cp "$root"/loop/SKILL.md "$root"/loop/APPLY.md "$out"/

# The skill calls press/bin/*.mjs by absolute path under ~/.claude/skills/
# screenless/, so the toolkit ships with it. The example edition rides along:
# the skill tells the model to read it before writing its first one.
COPYFILE_DISABLE=1 tar -czf "$out/press.tar.gz" \
  -C "$root/press" bin lib templates example README.md

npm --prefix "$root/cli" run build --silent
COPYFILE_DISABLE=1 tar -czf "$out/screenless.tar.gz" \
  -C "$root/cli/dist" --exclude='*.map' .

printf 'built %s:\n' "$out"
ls -1 "$out" | sed 's/^/  /'
