#!/usr/bin/env bash
# Start the DigInside backend on :8000 (frontend dev server proxies /api and /ws here).
cd "$(dirname "$0")"
# --loop asyncio: uvloop (the default with uvicorn[standard]) leaks server fds into launched programs
exec .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload --loop asyncio
