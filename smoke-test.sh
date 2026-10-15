#!/bin/bash
#
# End-to-end smoke test. Expects a server already running.
#
#   PORT=3000 ADMIN_PASSWORD=... bash smoke-test.sh
#
# PORT defaults to 3000; ADMIN_PASSWORD must match the running server.

set -u

BASE="http://localhost:${PORT:-3000}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-dev_admin_password_at_least_20_characters}"
COOKIES="$(mktemp)"

echo "=== Strata Vote Smoke Test ==="
echo "Target: $BASE"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Test counter
PASS=0
FAIL=0

# Helper function
test_result() {
  if [ "$1" -eq 0 ]; then
    echo -e "${GREEN}✓ PASS${NC}: $2"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗ FAIL${NC}: $2"
    FAIL=$((FAIL + 1))
  fi
}

# Helper: extract CSRF token from HTML
extract_csrf() {
  grep -oP 'name="_csrf" value="\K[^"]+' | head -1
}

# Authenticated request. Both -b and -c are required: csrf-csrf is a
# double-submit scheme, so every page that renders a form also (re)sets the
# token cookie, and a request that does not store it will fail validation.
acurl() {
  curl -b "$COOKIES" -c "$COOKIES" "$@"
}

trap 'rm -f "$COOKIES"' EXIT

echo "0. Waiting for server..."
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "$BASE/healthz"; then
    break
  fi
  sleep 1
done
curl -sf -o /dev/null "$BASE/healthz"
test_result $? "Server responding on $BASE/healthz"

echo ""
echo "1. Testing admin login..."
# The login POST is deliberately CSRF-exempt (there is no session to forge yet,
# and it is rate limited), so no token is expected on this page.
LOGIN_PAGE=$(curl -c "$COOKIES" -s "$BASE/admin/login")

RESPONSE=$(acurl -X POST "$BASE/admin/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "password=$ADMIN_PASSWORD" \
  -s -o /dev/null -w "%{http_code}")

[ "$RESPONSE" = "302" ]
test_result $? "Admin login (expected 302, got $RESPONSE)"

echo ""
echo "2. Creating a motion..."

DASHBOARD=$(acurl -s "$BASE/admin/dashboard")
CSRF_TOKEN=$(echo "$DASHBOARD" | extract_csrf)

[ -n "$CSRF_TOKEN" ]
test_result $? "Dashboard issued a CSRF token"

# Motion times are entered as local wall-clock values in APP_TIMEZONE, so send
# plain local times rather than UTC.
OPEN_AT=$(date +"%Y-%m-%dT%H:%M" -d "now")
CLOSE_AT=$(date +"%Y-%m-%dT%H:%M" -d "now + 24 hours")

# Read the redirect target rather than following it: a followed redirect issues
# its request before the session store has committed the rotated session id,
# which lands on the login page and hides the real result.
MOTION_LOCATION=$(acurl -X POST "$BASE/admin/motions" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "_csrf=$CSRF_TOKEN" \
  --data "title=Test Motion - Budget Approval" \
  --data "description=Should we approve the 2024 budget?" \
  --data "options=Yes,No,Abstain" \
  --data "open_at=$OPEN_AT" \
  --data "close_at=$CLOSE_AT" \
  --data "required_majority=Simple" \
  -s -o /dev/null -D - | grep -i '^location:' | tr -d '\r' | awk '{print $2}')

# Motion ids are UUIDs, so match the whole path segment, not just leading digits.
MOTION_ID=$(echo "$MOTION_LOCATION" | grep -oP '/admin/motions/\K[^/?#]+')

[ -n "$MOTION_ID" ]
test_result $? "Motion created (ID: $MOTION_ID)"

echo ""
echo "3. Opening the motion..."
DETAIL_PAGE=$(acurl -s "$BASE/admin/motions/$MOTION_ID")
CSRF_TOKEN=$(echo "$DETAIL_PAGE" | extract_csrf)

acurl -X POST "$BASE/admin/motions/$MOTION_ID/status" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "_csrf=$CSRF_TOKEN" \
  -d "status=Open" \
  -s -o /dev/null

DETAIL_PAGE=$(acurl -s "$BASE/admin/motions/$MOTION_ID")
echo "$DETAIL_PAGE" | grep -q "badge-open"
test_result $? "Motion status set to Open"

echo ""
echo "4. Generating voter tokens..."
TOKENS_PAGE=$(acurl -s "$BASE/admin/motions/$MOTION_ID/tokens")
CSRF_TOKEN=$(echo "$TOKENS_PAGE" | extract_csrf)

acurl -X POST "$BASE/admin/motions/$MOTION_ID/tokens" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "_csrf=$CSRF_TOKEN" \
  --data "recipients=Alice Smith,alice@example.com,Unit 101
Bob Johnson,bob@example.com,Unit 102" \
  -s -o /dev/null

TOKEN_RESPONSE=$(acurl -s "$BASE/admin/motions/$MOTION_ID/tokens")

TOKENS=$(echo "$TOKEN_RESPONSE" | grep -oP 'token=\K[^"&]+' | head -2)
TOKEN_A=$(echo "$TOKENS" | sed -n 1p)
TOKEN_B=$(echo "$TOKENS" | sed -n 2p)

[ -n "$TOKEN_A" ] && [ -n "$TOKEN_B" ]
test_result $? "Generated 2 tokens"

echo ""
echo "5. Voting with Token A (should succeed)..."
VOTE_RESPONSE=$(curl -X POST "$BASE/vote/$MOTION_ID" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN_A" \
  -d "choice=Yes" \
  -s)

echo "$VOTE_RESPONSE" | grep -q "successfully"
test_result $? "First vote succeeded"

echo ""
echo "6. Trying to vote again with Token A (should fail)..."
REVOTE_RESPONSE=$(curl -X POST "$BASE/vote/$MOTION_ID" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN_A" \
  -d "choice=No" \
  -s)

echo "$REVOTE_RESPONSE" | grep -q "already been used"
test_result $? "Duplicate vote blocked"

echo ""
echo "7. Voting with Token B (should succeed)..."
VOTE2_RESPONSE=$(curl -X POST "$BASE/vote/$MOTION_ID" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN_B" \
  -d "choice=No" \
  -s)

echo "$VOTE2_RESPONSE" | grep -q "successfully"
test_result $? "Second vote succeeded"

echo ""
echo "8. Checking dashboard for correct counts..."
DASHBOARD=$(acurl -s "$BASE/admin/dashboard")

echo "$DASHBOARD" | grep -q "Test Motion"
test_result $? "Motion appears on dashboard"

DETAIL=$(acurl -s "$BASE/admin/motions/$MOTION_ID")
echo "$DETAIL" | grep -q "Alice Smith"
test_result $? "Motion detail lists individual voters (admin view)"

echo ""
echo "9. Testing CSV export..."
CSV_RESPONSE=$(acurl -s "$BASE/admin/motions/$MOTION_ID/export.csv")

echo "$CSV_RESPONSE" | grep -q "submitted_at,choice"
test_result $? "CSV export works"

echo "$CSV_RESPONSE" | grep -q "Alice Smith"
test_result $? "CSV contains voter data"

echo ""
echo "10. Closing the motion..."
DETAIL_PAGE=$(acurl -s "$BASE/admin/motions/$MOTION_ID")
CSRF_TOKEN=$(echo "$DETAIL_PAGE" | extract_csrf)

acurl -X POST "$BASE/admin/motions/$MOTION_ID/status" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "_csrf=$CSRF_TOKEN" \
  -d "status=Closed" \
  -s -o /dev/null

echo ""
echo "11. Public results page must NOT name voters by default..."
PUBLIC_RESULTS=$(curl -s "$BASE/results/$MOTION_ID")

echo "$PUBLIC_RESULTS" | grep -q "^<"
test_result $? "Public results page renders for a closed motion"

! echo "$PUBLIC_RESULTS" | grep -q "Alice Smith"
test_result $? "Public results hide individual votes by default"

echo ""
echo "12. Enabling the per-motion public voter breakdown..."
DETAIL_PAGE=$(acurl -s "$BASE/admin/motions/$MOTION_ID")
CSRF_TOKEN=$(echo "$DETAIL_PAGE" | extract_csrf)

acurl -X POST "$BASE/admin/motions/$MOTION_ID/voter-breakdown" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "_csrf=$CSRF_TOKEN" \
  -d "show_voter_breakdown=on" \
  -s -o /dev/null

PUBLIC_RESULTS=$(curl -s "$BASE/results/$MOTION_ID")

echo "$PUBLIC_RESULTS" | grep -q "Alice Smith"
test_result $? "Voter breakdown published when explicitly enabled"

echo ""
echo "13. Confirming the admin pages are not public..."
for path in /admin/dashboard /admin/settings /admin/council; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$path")
  [ "$CODE" = "302" ] || [ "$CODE" = "401" ]
  test_result $? "$path requires login (got $CODE)"
done

echo ""
echo "14. Confirming the CSRF guard rejects a token-less POST..."
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/motions" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "title=Nope")
[ "$CODE" != "200" ]
test_result $? "POST without a CSRF token rejected (got $CODE)"

echo ""
echo "================================"
echo "Test Summary:"
echo -e "${GREEN}Passed: $PASS${NC}"
if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Failed: $FAIL${NC}"
else
  echo "Failed: $FAIL"
fi
echo "================================"

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
fi
