#!/bin/zsh
# Start a static web server on macOS and open the browser.
# Usage: double-click or run: ./start-server.command [port]

cd "$(dirname "$0")"
PORT=${1:-8010}

# pick python
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Python is not installed. Please install Python 3 from https://www.python.org/downloads/"
  exit 1
fi

# kill stale process using pid file if it exists but process is dead
if [ -f .server.pid ]; then
  if ! ps -p $(cat .server.pid) >/dev/null 2>&1; then
    rm -f .server.pid
  fi
fi

# if port is already used, just open the page
if command -v lsof >/dev/null 2>&1 && lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "A server is already running on port $PORT. Opening browser..."
  open "http://localhost:$PORT"
  exit 0
fi

# start server in background (detached)
nohup "$PY" -m http.server "$PORT" >/dev/null 2>&1 &
PID=$!
echo $PID > .server.pid
sleep 1

echo "Server started on http://localhost:$PORT (pid=$PID)"
open "http://localhost:$PORT"
