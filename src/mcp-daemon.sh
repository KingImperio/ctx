#!/bin/bash
# MCP daemon wrapper — keeps MCP alive after parent CLI exits
# Usage: mcp-daemon.sh <name> <command> [args...]
#
# Spawns MCP with FIFOs for stdin/stdout.
# Daemon holds file descriptors open so MCP survives parent exit.
# Writes MCP PID to ~/.ctx/mcps/running.json

set -e

NAME="$1"
shift
CMD="$1"
shift
ARGS="$@"

CTX_DIR="$HOME/.ctx"
IPC_DIR="$CTX_DIR/mcps/ipc"
RUNNING_FILE="$CTX_DIR/mcps/running.json"

mkdir -p "$IPC_DIR" "$(dirname "$RUNNING_FILE")"

REQ_FIFO="$IPC_DIR/$NAME.req"
RES_FIFO="$IPC_DIR/$NAME.res"

# Clean stale FIFOs
rm -f "$REQ_FIFO" "$RES_FIFO"
mkfifo "$REQ_FIFO"
mkfifo "$RES_FIFO"

# Open FIFOs in background subprocesses to avoid blocking
# The MCP's stdin reads from REQ_FIFO (needs a writer to not block)
# The MCP's stdout writes to RES_FIFO (needs a reader to not block)
bash -c "exec 3>'' >('$REQ_FIFO')" 2>/dev/null &
bash -c "exec 3<'' <('$RES_FIFO')" 2>/dev/null &

# Small delay to let FIFO opens complete
sleep 0.1

# Spawn MCP with FIFOs as stdin/stdout
$CMD $ARGS < "$REQ_FIFO" > "$RES_FIFO" 2>/dev/null &
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

# Wait for MCP to exit (keeps daemon alive holding FIFOs)
wait $MCP_PID 2>/dev/null || true

# Cleanup
rm -f "$REQ_FIFO" "$RES_FIFO"

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
