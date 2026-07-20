#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./deploy/common.sh
source "${SCRIPT_DIR}/deploy/common.sh"

usage() {
  cat <<'EOF'
Deploy a worker image with Docker.

Usage:
  deploy-worker.sh build
  deploy-worker.sh run
  deploy-worker.sh deploy

Defaults:
  WORKER_IMAGE=rlbotline-worker:latest
  WORKER_CONTAINER_NAME=rlbotline-worker
  WORKER_DATA_VOLUME=rlbotline-worker-data
  LOG_LEVEL=info

Required env for run/deploy:
  API_BASE_URL
  INSTANCE_TOKEN

Examples:
  ./scripts/deploy-worker.sh build
  API_BASE_URL=http://host.docker.internal:3001 INSTANCE_TOKEN=... ./scripts/deploy-worker.sh run
  WORKER_IMAGE=ghcr.io/acme/rlbotline-worker:latest API_BASE_URL=http://host.docker.internal:3001 INSTANCE_TOKEN=... ./scripts/deploy-worker.sh deploy
EOF
}

build_image() {
  require_command docker

  local worker_image="${WORKER_IMAGE:-rlbotline-worker:latest}"

  run_cmd docker build \
    -f "${REPO_ROOT}/Dockerfile" \
    -t "$worker_image" \
    "${REPO_ROOT}"
}

run_container() {
  require_command docker
  require_env API_BASE_URL INSTANCE_TOKEN

  local worker_image="${WORKER_IMAGE:-rlbotline-worker:latest}"
  local container_name="${WORKER_CONTAINER_NAME:-rlbotline-worker}"
  local data_volume="${WORKER_DATA_VOLUME:-rlbotline-worker-data}"
  local log_level="${LOG_LEVEL:-info}"
  local command=(
    docker run -d
    --name "$container_name"
    --restart unless-stopped
    -v "${data_volume}:/data"
    -e "API_BASE_URL=${API_BASE_URL}"
    -e "INSTANCE_TOKEN=${INSTANCE_TOKEN}"
    -e "LOG_LEVEL=${log_level}"
  )

  command+=( "$worker_image" )

  ensure_volume "$data_volume"
  remove_container_if_exists "$container_name"
  run_cmd "${command[@]}"
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local subcommand="$1"
  shift

  case "$subcommand" in
    build)
      build_image
      ;;
    run)
      run_container
      ;;
    deploy)
      build_image
      run_container
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main_guard "$@"