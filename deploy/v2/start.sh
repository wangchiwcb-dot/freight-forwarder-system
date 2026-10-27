#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! docker compose version >/dev/null 2>&1; then
  echo '请先安装 Docker Engine 和 Docker Compose 插件，再执行本脚本。'
  exit 1
fi
if [ ! -f .env ]; then
  umask 077
  task_database_password="$(openssl rand -hex 32)"
  printf 'POSTGRES_PASSWORD=%s\nHTTP_PORT=127.0.0.1:8080\nV2_IMPORT_MANIFEST=/data/sources/manifest.json\nV2_PRICE_DRAFTS=/data/sources/normalized\n' "$task_database_password" > .env
  unset task_database_password
fi
docker compose up -d --build
docker compose ps
