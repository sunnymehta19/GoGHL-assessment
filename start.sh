#!/bin/sh
# Kill any process still holding our port before starting.
# On Windows the harness kill(-pgid) only kills sh, not node children.
PORT="${PORT:-4000}"

# Find and kill PID holding the port using netstat (available in MinGW/Git Bash)
OLD_PID=$(netstat -ano 2>/dev/null | grep "LISTENING" | grep ":${PORT} " | awk '{print $5}' | head -1)
if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
  echo "Killing old process $OLD_PID on port $PORT"
  taskkill //F //PID "$OLD_PID" 2>/dev/null || true
  sleep 0.5
fi

exec '/c/Program Files/nodejs/node.exe' scaffold/server/dist/index.js
