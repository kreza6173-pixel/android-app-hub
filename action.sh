#!/system/bin/sh
# Privacy Audit - Quick Check
# Runs a fast summary scan of third-party apps for the most sensitive
# permissions. This is the "Action" button output shown on the module
# card. The full interactive dashboard lives in the WebUI.

echo "== Privacy Audit :: Quick Check =="
echo "module=$SHIZUKU_MODULE_ID mode=$SHIZUKU_MODULE_MODE"
id
echo "-----------------------------------"

PERMS="CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION ACCESS_BACKGROUND_LOCATION MANAGE_EXTERNAL_STORAGE"

TOTAL=0
FLAGGED=0
GRANTS=0

for pkg in $(pm list packages -3 2>/dev/null | sed 's/^package://'); do
  TOTAL=$((TOTAL + 1))
  DUMP=$(dumpsys package "$pkg" 2>/dev/null)
  APP_HIT=0
  for p in $PERMS; do
    if echo "$DUMP" | grep -q "android.permission.$p: granted=true"; then
      GRANTS=$((GRANTS + 1))
      APP_HIT=1
    fi
  done
  if [ "$APP_HIT" = "1" ]; then
    FLAGGED=$((FLAGGED + 1))
  fi
done

echo "Scanned:            $TOTAL third-party apps"
echo "Apps with sensitive grants: $FLAGGED"
echo "Total sensitive grants:     $GRANTS"
echo "-----------------------------------"
echo "Open the module's WebUI for the full dashboard,"
echo "category breakdown, and one-tap revoke controls."
