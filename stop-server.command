#!/bin/zsh
# Stop the static server started by start-server.command
# Usage: ./stop-server.command [port]

cd "$(dirname "$0")"
PORT=${1:-8010}

# stop by pid file
if [ -f .server.pid ]; then
  PID=$(cat .server.pid)
  if ps -p $PID >/dev/null 2>&1; then
    kill $PID 2>/dev/null || true
    echo "Stopped server pid=$PID"
  fi
  rm -f .server.pid
fi

# also stop any process listening on PORT (best-effort)
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti tcp:"$PORT")
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs -I {} kill {} 2>/dev/null || true
    echo "Stopped processes on port $PORT"
  fi
fi

echo "Done."
