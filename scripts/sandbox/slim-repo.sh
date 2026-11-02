#!/usr/bin/env bash
# Reduce this checkout to the profile an agent needs to *use* REA.
#
# An agent sandbox gives the workspace a file budget (10,000 files) and a size
# budget. A full development checkout spends most of that budget on material that
# never runs during an investigation: the test suites, the documentation website,
# the changelog, CI configuration and release tooling. This script removes that
# material deterministically and reversibly.
#
#   bash scripts/sandbox/slim-repo.sh --dry-run   # show what would go
#   bash scripts/sandbox/slim-repo.sh             # apply
#   bash scripts/sandbox/slim-repo.sh --restore   # git-restore everything listed
#
# What survives: `src/` (production sources), `scripts/` (build pipeline),
# `bridge/` (engine bridges used at runtime), `native/`, `third_party/`,
# `licenses/`, the `docs/*.md` guides, the workflow skill, and the sandbox
# provisioner/verifier. Everything removed here is recoverable from git — this
# repository keeps its history — or from upstream
# (https://github.com/morluto/rea).
#
# Nothing here changes runtime behaviour: `npm run build:cached` and every CLI
# command work identically after pruning.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="apply"

case "${1:-}" in
  --dry-run) MODE="dry-run" ;;
  --restore) MODE="restore" ;;
  "") ;;
  -h | --help)
    sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown option: $1 (try --help)" >&2
    exit 2
    ;;
esac

cd "$REPO_ROOT"

# Directories removed whole. Each entry is either development-only or
# regenerable, and none is read by the build or by a CLI command.
REMOVE_DIRECTORIES=(
  tests                 # 2,375 files: vitest suites, goldens and fixtures
  website               # documentation site; docs/*.md already carries the text
  docs/readme           # 23 translated READMEs
  docs/assets           # screenshots for the website
  docs/releases         # release notes; upstream keeps the canonical copy
  docs/specs            # design specs
  docs/design           # rendered architecture images
  docs/public           # generated catalog output
  docs/verification     # generated conformance goldens (our sandbox report is re-added below)
  docs/.vitepress       # site config
  .github               # CI workflows and issue/PR templates
  .husky                # git hooks (lint-staged, which cannot run here anyway)
  examples              # sample projects
)

# Individual files removed.
REMOVE_FILES=(
  CHANGELOG.md                 # 461 KB; upstream is canonical
  stryker.config.mjs           # mutation-testing config
  stryker.semantics.config.mjs
  vitest.config.ts
  vitest.reverse-tools.config.ts
  vitest.reverse-tools-semantics.config.ts
  knip.json
  knip.production.json
  .jscpd.json
  release-please-config.json
  .release-please-manifest.json
  tsconfig.reverse-tools-mutation.json
  tsconfig.frida-verification.json
  scripts/check-doc-facts.mjs        # validates docs we no longer ship translations for
  scripts/lib/docs-facts.mjs
  scripts/verify-package-setup.mjs  # depends on the removed doc-fact inventory
)

# Co-located source tests: 1,187 files the build already excludes
# (tsconfig.build.json skips *.test.ts and *.fixture.ts), so removing them
# speeds up the tree without touching the emitted runtime.
prune_source_tests() {
  find src -type f \( -name "*.test.ts" -o -name "*.fixture.ts" \) -print
}

count_files() {
  find . -path ./.git -prune -o -path ./node_modules -prune -o -path ./dist -prune -o \
    -type f -print | wc -l | tr -d ' '
}

report() {
  printf '  %-46s %6s files\n' "$1" "$2"
}

list_targets() {
  local path
  for path in "${REMOVE_DIRECTORIES[@]}"; do
    [ -e "$path" ] && printf '%s\n' "$path"
  done
  for path in "${REMOVE_FILES[@]}"; do
    [ -e "$path" ] && printf '%s\n' "$path"
  done
  prune_source_tests
}

print_summary() {
  local before after total=0 path count
  before="$1"
  after="$2"
  echo
  echo "files: ${before} -> ${after} ($((before - after)) removed)"
  echo "size:  $(du -sh --exclude=.git --exclude=node_modules --exclude=dist . | cut -f1) (excluding .git/node_modules/dist)"
}

if [ "$MODE" = "restore" ]; then
  mapfile -t targets < <(list_targets)
  if [ ${#targets[@]} -eq 0 ]; then
    echo "nothing to restore"
    exit 0
  fi
  git checkout -- "${targets[@]}" 2>/dev/null ||
    echo "note: use 'git checkout <commit> -- <path>' for files removed in that commit" >&2
  echo "restored ${#targets[@]} paths from git"
  exit 0
fi

mapfile -t targets < <(list_targets)

if [ "$MODE" = "dry-run" ]; then
  echo "would remove ${#targets[@]} paths:"
  total=0
  source_tests=0
  for path in "${targets[@]}"; do
    case "$path" in
      src/*)
        source_tests=$((source_tests + 1))
        continue
        ;;
    esac
    count=$(find "$path" -type f 2>/dev/null | wc -l | tr -d ' ')
    [ -d "$path" ] || count=1
    report "$path" "$count"
    total=$((total + count))
  done
  report "src/**/*.test.ts + *.fixture.ts" "$source_tests"
  total=$((total + source_tests))
  echo
  echo "total files removed: ${total}; current: $(count_files)"
  exit 0
fi

before=$(count_files)
for path in "${targets[@]}"; do
  if [ -d "$path" ]; then
    count=$(find "$path" -type f | wc -l | tr -d ' ')
    report "$path/" "$count"
    rm -rf -- "$path"
  else
    report "$path" 1
    rm -f -- "$path"
  fi
done
after=$(count_files)
print_summary "$before" "$after"
echo
echo "Restore anything with: bash scripts/sandbox/slim-repo.sh --restore"
echo "Then rebuild:          export PATH=/usr/local/bin:\$PATH && npm run build:cached"
