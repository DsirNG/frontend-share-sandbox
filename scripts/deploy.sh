#!/usr/bin/env bash
set -euo pipefail

APP_NAME="frontend-share-sandbox"

cd "$(dirname "$0")/.."

if [ ! -f ".env" ]; then
  echo "Missing .env. Create it from .env.example and fill production values first."
  exit 1
fi

docker compose -p "$APP_NAME" up -d --build
docker compose -p "$APP_NAME" ps
