#!/bin/bash
# launchd 상시 서비스가 떠 있으면 먼저 정지 — kill -9만 하면 KeepAlive가 되살려
# dev 서버와 port 7200을 두고 싸운다. dev 종료 후 scripts/service-macos.sh start로 복구.
launchctl bootout "gui/$(id -u)/com.nova-orbit.server" 2>/dev/null

# Kill any zombie processes on ports 7200 and 5173
lsof -ti :7200 | xargs kill -9 2>/dev/null
lsof -ti :5173 | xargs kill -9 2>/dev/null

# Auto-sync Nova rules if Nova directory exists and rules are outdated
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
NOVA_DIR="${NOVA_DIR:-$(dirname "$PROJECT_ROOT")/nova}"
VERSION_FILE="$PROJECT_ROOT/server/core/nova-rules/version.json"

if [ -d "$NOVA_DIR/.git" ]; then
  # Compare by release version (e.g., "3.14.1"), fallback to commit SHA
  NOVA_VERSION=""
  if [ -f "$NOVA_DIR/scripts/.nova-version" ]; then
    NOVA_VERSION=$(cat "$NOVA_DIR/scripts/.nova-version")
  fi

  SYNCED_VERSION=""
  if [ -f "$VERSION_FILE" ]; then
    SYNCED_VERSION=$(grep -o '"novaVersion":"[^"]*"' "$VERSION_FILE" | cut -d'"' -f4)
  fi

  if [ -z "$SYNCED_VERSION" ] || [ "$NOVA_VERSION" != "$SYNCED_VERSION" ]; then
    echo "Nova rules outdated (v$SYNCED_VERSION → v$NOVA_VERSION) — syncing..."
    bash "$SCRIPT_DIR/sync-nova-rules.sh"
  else
    echo "Nova rules up to date (v$SYNCED_VERSION)"
  fi
fi

exit 0
