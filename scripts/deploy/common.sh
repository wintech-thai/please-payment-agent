#!/usr/bin/env bash

set -euo pipefail

DEPLOY_COMMON_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${DEPLOY_COMMON_DIR}/../.." && pwd)"
DRY_RUN="${DRY_RUN:-0}"

usage_prefix() {
  local script_name
  script_name="$(basename -- "$0")"
  printf 'Usage: %s %s\n' "$script_name" "$*"
}

log_info() {
  printf '[deploy] %s\n' "$*"
}

require_command() {
  local command_name
  for command_name in "$@"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      printf 'Missing required command: %s\n' "$command_name" >&2
      exit 1
    fi
  done
}

require_env() {
  local variable_name
  for variable_name in "$@"; do
    if [[ -z "${!variable_name:-}" ]]; then
      printf 'Missing required environment variable: %s\n' "$variable_name" >&2
      exit 1
    fi
  done
}

ensure_volume() {
  local volume_name="$1"

  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    log_info "Volume exists: ${volume_name}"
    return 0
  fi

  run_cmd docker volume create "$volume_name"
}

remove_container_if_exists() {
  local container_name="$1"

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    run_cmd docker rm -f "$container_name"
  fi
}

print_or_run() {
  local rendered=""
  local part

  for part in "$@"; do
    if [[ -n "$rendered" ]]; then
      rendered+=" "
    fi
    rendered+="$(printf '%q' "$part")"
  done

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$rendered"
    return 0
  fi

  printf '[run] %s\n' "$rendered"
  "$@"
}

run_cmd() {
  print_or_run "$@"
}

main_guard() {
  if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
  fi
}