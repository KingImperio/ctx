#!/bin/bash
# MCP daemon wrapper — keeps MCP alive after parent CLI exits
# Usage: mcp-daemon.sh <name> <command> [args...]
#
# Spawns MCP, writes PID to running.json, waits for exit.

set -e

NAME="$1"
shift
CMD="$1"
shift
ARGS="$@"

# Sanitize name — prevent shell injection
NAME=$(echo "$NAME" | tr -cd 'a-zA-Z0-9_-')

CTX_DIR="$HOME/.ctx"
RUNNING_FILE="$CTX_DIR/mcps/running.json"

mkdir -p "$(dirname "$RUNNING_FILE")"

# Spawn MCP with stdio passthrough
$CMD $ARGS 2>/dev/null &
MCP_PID=$!

# Write PID to running.json (atomic)
NOW=$(($(date +%s) * 1000))
python3 -c "
import json, os
f = '$RUNNING_FILE'
data = {}
try:
    with open(f) as fh: data = json.load(fh)
except: pass
data['$NAME'] = {
    'pid': $MCP_PID,
    'startedAt': $NOW,
    'lastUsed': $NOW,
    'command': '$CMD',
    'args': $(python3 -c "import json; print(json.dumps('$ARGS'.split()))" 2>/dev/null || echo '[]')
}
tmp = f + '.tmp'
with open(tmp, 'w') as fh: json.dump(data, fh, indent=2)
os.rename(tmp, f)
"

# Print PID for caller
echo "$MCP_PID"

# Wait for MCP to exit
wait $MCP_PID 2>/dev/null || true

# Remove from running.json
python3 -c "
import json
f = '$RUNNING_FILE'
try:
    with open(f) as fh: data = json.load(fh)
    data.pop('$NAME', None)
    with open(f, 'w') as fh: json.dump(data, fh, indent=2)
except: pass
" 2>/dev/null
