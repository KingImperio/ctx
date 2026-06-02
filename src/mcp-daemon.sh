#!/bin/bash
# MCP daemon wrapper — keeps FIFO open after parent CLI exits
# Usage: mcp-daemon.sh <name> <command> [args...]
#
# Creates FIFOs at ~/.ctx/mcps/ipc/<name>.{req,res}
# Spawns the MCP with stdin=req FIFO, stdout=res FIFO
# Writes PID to running.json
# Holds FIFO file descriptors open so MCP survives parent exit

NAME="$1"
shift
CMD="$1"
shift
ARGS="$@"

CTX_DIR="$HOME/.ctx"
IPC_DIR="$CTX_DIR/mcps/ipc"
RUNNING_FILE="$CTX_DIR/mcps/running.json"

mkdir -p "$IPC_DIR"

REQ_FIFO="$IPC_DIR/$NAME.req"
RES_FIFO="$IPC_DIR/$NAME.res"

# Clean stale FIFOs
rm -f "$REQ_FIFO" "$RES_FIFO"

# Create FIFOs
mkfifo "$REQ_FIFO"
mkfifo "$RES_FIFO"

# Open FIFOs in background to avoid blocking on open
# These file descriptors keep the FIFOs alive after parent exits
exec 3>"$REQ_FIFO" &
exec 4<"$RES_FIFO" &
wait 2>/dev/null

# Spawn MCP with FIFOs as stdin/stdout
$CMD $ARGS < "$REQ_FIFO" > "$RES_FIFO" 2>/dev/null &
MCP_PID=$!

# Write PID to running.json (atomic via tmp)
NOW=$(($(date +%s) * 1000))
python3 -c "
import json
data = {}
try:
    with open('$RUNNING_FILE') as f: data = json.load(f)
except: pass
data['$NAME'] = {
    'pid': $MCP_PID,
    'startedAt': $NOW,
    'lastUsed': $NOW,
    'command': '$CMD',
    'args': '$ARGS'.split() if '$ARGS' else []
}
with open('$RUNNING_FILE', 'w') as f: json.dump(data, f, indent=2)
"

# Print PID so caller can track it
echo "$MCP_PID"

# Wait for MCP to exit
wait $MCP_PID 2>/dev/null

# Cleanup on exit
exec 3>&- 2>/dev/null
exec 4<&- 2>/dev/null
rm -f "$REQ_FIFO" "$RES_FIFO"

# Remove from running.json
python3 -c "
import json
try:
    with open('$RUNNING_FILE') as f: data = json.load(f)
    data.pop('$NAME', None)
    with open('$RUNNING_FILE', 'w') as f: json.dump(data, f, indent=2)
except: pass
" 2>/dev/null
