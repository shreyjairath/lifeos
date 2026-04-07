#!/usr/bin/env bash
# Wrapper — runs send-email.ts from within packages/server so googleapis resolves
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../packages/server"
exec bun src/send-email.ts "$@"
