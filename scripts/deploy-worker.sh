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
  INSTANCE_ID

Optional (passed through when set): BOT_NAME, LINE_EMAIL, LINE_PASSWORD,
  LINE_AUTH_TOKEN, PROXY_URL, HTTP_PORT (default 3000, published as
  WORKER_HTTP_PORT:HTTP_PORT), HTTP_API_USER, HTTP_API_KEY, BANK_OA_HANDLES,
  ONIX_API_URL, ONIX_ORG, ONIX_AGENT_ID, ONIX_API_USER, ONIX_API_KEY,
  ONIX_APPLICATION_TYPE, ONIX_FORWARD_TIMEOUT_MS

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
  require_env API_BASE_URL INSTANCE_TOKEN INSTANCE_ID

  local worker_image="${WORKER_IMAGE:-rlbotline-worker:latest}"
  local container_name="${WORKER_CONTAINER_NAME:-rlbotline-worker}"
  local data_volume="${WORKER_DATA_VOLUME:-rlbotline-worker-data}"
  local log_level="${LOG_LEVEL:-info}"
  # Standalone app: publish the inbound HTTP API port (login + health).
  local http_port="${HTTP_PORT:-3000}"
  local host_http_port="${WORKER_HTTP_PORT:-$http_port}"
  local command=(
    docker run -d
    --name "$container_name"
    --restart unless-stopped
    -p "${host_http_port}:${http_port}"
    -v "${data_volume}:/data"
    -e "API_BASE_URL=${API_BASE_URL}"
    -e "INSTANCE_TOKEN=${INSTANCE_TOKEN}"
    -e "INSTANCE_ID=${INSTANCE_ID}"
    -e "LOG_LEVEL=${log_level}"
    -e "HTTP_PORT=${http_port}"
  )

  # Pass through optional vars (onix forwarding, bank OAs, HTTP auth, login
  # creds, proxy) only when they're set in the environment.
  local optional_vars=(
    BOT_NAME LINE_EMAIL LINE_PASSWORD LINE_AUTH_TOKEN PROXY_URL
    HTTP_API_USER HTTP_API_KEY BANK_OA_HANDLES
    ONIX_API_URL ONIX_ORG ONIX_AGENT_ID ONIX_API_USER ONIX_API_KEY
    ONIX_APPLICATION_TYPE ONIX_FORWARD_TIMEOUT_MS
  )
  local v
  for v in "${optional_vars[@]}"; do
    if [[ -n "${!v:-}" ]]; then
      command+=( -e "${v}=${!v}" )
    fi
  done

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