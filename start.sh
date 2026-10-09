#!/bin/bash
set -e
[ -d venv ] || python3 -m venv venv
source venv/bin/activate
pip install -q -r requirements.txt
if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from .env.example. Fill in MRPC_API_KEY and SESSION_SECRET, then run again."; exit 1; fi
echo "KanAIRY on http://localhost:${PORT:-8000}"
uvicorn backend.main:app --host 0.0.0.0 --port "${PORT:-8000}"
