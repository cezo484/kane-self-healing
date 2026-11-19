#!/usr/bin/env bash
# HARNESS SELF-TEST ONLY — a test double for `kane-cli`.
#
# This stub NEVER runs in a real heal loop. It exists so the loop harness
# can be tested end to end without a TestMu account or credits:
#   KANE_CMD=./test/stub-kane.sh node scripts/demo.js
#
# Behavior: it greps app/public/app.js for the seeded bug signature.
#   - Bug present  -> emits a failing NDJSON run (exit 1).
#   - Bug absent   -> emits a passing NDJSON run (exit 0).
# It answers both `testmd run` (test_md_done) and `run` (run_end) shapes.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_JS="$ROOT/app/public/app.js"
MODE="$1"  # testmd | run

bug_present=0
if grep -q "getElementById('order-form')" "$APP_JS" 2>/dev/null; then
  bug_present=1
fi

echo '{"type":"stream_start","session_id":"stub-session"}'
echo '{"step":"Open the store","status":"done","remark":"Store opened, 6 products listed."}'
echo '{"step":"Add items to the cart","status":"done","remark":"Added Wireless Headphones and USB-C Cable; cart shows 2 items."}'
echo '{"step":"Check the cart total","status":"done","remark":"Cart total stored as cart_total."}'

if [ "$bug_present" -eq 1 ]; then
  echo '{"step":"Checkout","status":"failed","remark":"Clicked Place order but nothing happened: the page stayed on the checkout form and no confirmation appeared."}'
  if [ "$MODE" = "testmd" ]; then
    echo '{"type":"test_md_done","overall_status":"failed","duration_s":42,"session_id":"stub-session","summary":"Checkout failed: Place order did nothing."}'
  else
    echo '{"type":"run_end","status":"failed","summary":"Checkout failed: Place order did nothing.","reason":"The Place order button did not navigate to the confirmation page.","duration":42,"credits_consumed":0,"final_state":{"cart_total":"$102.49"},"test_url":null,"session_dir":"stub-session"}'
  fi
  exit 1
fi

echo '{"step":"Checkout","status":"done","remark":"Form filled, Place order clicked."}'
echo '{"step":"Confirm the order","status":"done","remark":"Confirmation page shows Order confirmed with the matching total."}'
if [ "$MODE" = "testmd" ]; then
  echo '{"type":"test_md_done","overall_status":"passed","duration_s":38,"session_id":"stub-session","summary":"Checkout passed end to end."}'
else
  echo '{"type":"run_end","status":"passed","summary":"Checkout passed end to end.","reason":"","duration":38,"credits_consumed":0,"final_state":{"cart_total":"$102.49"},"test_url":null,"session_dir":"stub-session"}'
fi
exit 0
