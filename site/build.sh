#!/usr/bin/env bash
#
# Assembles site/public from its three sources.
#
# public/ is generated in full and gitignored, so there is one rule with no
# exceptions: never edit anything in it. The previous layout mixed hand-written
# pages with copies of loop/ and cli/dist, and the only thing standing between
# you and losing an afternoon's work was remembering which was which.
#
#   site/src/               pages and the installer, hand-written
#   skills/                 the branded skills the installer downloads
#   skills/morning-pr-review/press/  the toolkit that skill calls
#   cli/dist/               the CLI, shipped as a tarball
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
# the served directory — there is no build step on Cloudflare's side. The
# canonical skills live under skills/<name>/ so `npx skills add janwilmake/
# screenless` (skills.sh) discovers them; these flat copies are what the bash
# installer fetches.
cp "$root"/skills/screenless/SKILL.md "$root"/skills/screenless/APPLY.md "$out"/
cp "$root"/skills/call-when-afk/SKILL.md "$out"/CALL-WHEN-AFK.md
cp "$root"/skills/morning-pr-review/SKILL.md "$out"/MORNING-PR-REVIEW.md

# The morning-pr-review skill calls press/bin/*.mjs by absolute path under
# ~/.claude/skills/morning-pr-review/, so the toolkit ships with it. The example
# edition rides along: the skill reads it before writing its first one.
COPYFILE_DISABLE=1 tar -czf "$out/press.tar.gz" \
  -C "$root/skills/morning-pr-review/press" bin lib templates example README.md

npm --prefix "$root/cli" run build --silent
COPYFILE_DISABLE=1 tar -czf "$out/screenless.tar.gz" \
  -C "$root/cli/dist" --exclude='*.map' .

printf 'built %s:\n' "$out"
ls -1 "$out" | sed 's/^/  /'
