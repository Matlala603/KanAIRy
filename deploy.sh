#!/bin/bash
set -e
[ -f .env ] || { echo "Missing .env (copy .env.example and fill it in)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 1; }
docker compose up -d --build
echo "KanAIRY running on http://localhost:8000"
