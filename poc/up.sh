#!/bin/sh
# Wrapper for `docker compose` that stamps the worker image with the current
# git commit/branch so GET /status never reports "unknown" on a local build.
# Usage: ./up.sh up --build -d   (any compose args pass through)
set -e
cd "$(dirname "$0")"
GIT_COMMIT=$(git rev-parse HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BUILD_TIME=$(date -u +%FT%TZ)
GIT_DIRTY=$([ -n "$(git status --porcelain)" ] && echo 1 || echo 0)
export GIT_COMMIT GIT_BRANCH BUILD_TIME GIT_DIRTY
exec docker compose "$@"
