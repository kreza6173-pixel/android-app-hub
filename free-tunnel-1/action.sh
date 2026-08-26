#!/system/bin/sh
# Free Net Tunnel - Quick Status
# Shows what's currently running and whether we have root. Full control
# (start/stop/configure) lives in the WebUI.

WORKDIR="/data/local/tmp/free_tunnel"

echo "== Free Net Tunnel :: Status =="
id
echo "-----------------------------------"

if [ "$(id -u 2>/dev/null)" = "0" ]; then
  echo "Privilege: ROOT (full transparent routing available)"
else
  echo "Privilege: ADB/shell (system proxy + private DNS only)"
fi

echo "-----------------------------------"
if [ -f "$WORKDIR/state/active.method" ]; then
  METHOD=$(cat "$WORKDIR/state/active.method" 2>/dev/null)
  echo "Active method: $METHOD"
  PIDFILE="$WORKDIR/state/${METHOD}.pid"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Process:       running (pid $(cat "$PIDFILE"))"
  else
    echo "Process:       not running (stale state)"
  fi
else
  echo "Active method: none"
fi

echo "-----------------------------------"
echo "Open the WebUI to configure and start/stop a method."
