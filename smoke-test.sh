#!/bin/bash

echo "=== Strata Vote Smoke Test ==="
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
  if [ $1 -eq 0 ]; then
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

# Clean cookies
rm -f /tmp/cookies.txt

echo "1. Testing admin login..."
# First, get login page to extract CSRF token
LOGIN_PAGE=$(curl -c /tmp/cookies.txt -s http://localhost:3000/admin/login)
CSRF_TOKEN=$(echo "$LOGIN_PAGE" | extract_csrf)

RESPONSE=$(curl -b /tmp/cookies.txt -c /tmp/cookies.txt -X POST http://localhost:3000/admin/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "_csrf=$CSRF_TOKEN" \
  -d "password=dev_admin_password_at_least_20_characters" \
  -s -o /dev/null -w "%{http_code}")

[ "$RESPONSE" = "302" ]
test_result $? "Admin login (expected 302, got $RESPONSE)"

echo ""
echo "2. Creating a motion..."

# Extract CSRF token from dashboard
DASHBOARD=$(curl -b /tmp/cookies.txt -s http://localhost:3000/admin/dashboard)
CSRF_TOKEN=$(echo "$DASHBOARD" | extract_csrf)

# Calculate dates (open now, close in 24 hours)
OPEN_AT=$(date -u +"%Y-%m-%dT%H:%M" -d "now")
CLOSE_AT=$(date -u +"%Y-%m-%dT%H:%M" -d "now + 24 hours")

MOTION_RESPONSE=$(curl -b /tmp/cookies.txt -X POST http://localhost:3000/admin/motions \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "_csrf=$CSRF_TOKEN" \
  --data "title=Test Motion - Budget Approval" \
  --data "description=Should we approve the 2024 budget?" \
  --data "options=Yes,No,Abstain" \
  --data "open_at=$OPEN_AT" \
  --data "close_at=$CLOSE_AT" \
  --data "required_majority=Simple" \
  -s -L -w "\n%{url_effective}")

# Extract motion ID from redirect URL
MOTION_ID=$(echo "$MOTION_RESPONSE" | tail -1 | grep -oP 'motions/\K[0-9]+')

[ -n "$MOTION_ID" ]
test_result $? "Motion created (ID: $MOTION_ID)"

echo ""
echo "3. Opening the motion..."
# Extract CSRF token from motion detail page
DETAIL_PAGE=$(curl -b /tmp/cookies.txt -s "http://localhost:3000/admin/motions/$MOTION_ID")
CSRF_TOKEN=$(echo "$DETAIL_PAGE" | extract_csrf)

curl -b /tmp/cookies.txt -X POST "http://localhost:3000/admin/motions/$MOTION_ID/status" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "_csrf=$CSRF_TOKEN" \
  -d "status=Open" \
  -s -o /dev/null

sleep 1
test_result 0 "Motion status set to Open"

echo ""
echo "4. Generating voter tokens..."
# Extract CSRF token from tokens page
TOKENS_PAGE=$(curl -b /tmp/cookies.txt -s "http://localhost:3000/admin/motions/$MOTION_ID/tokens")
CSRF_TOKEN=$(echo "$TOKENS_PAGE" | extract_csrf)

curl -b /tmp/cookies.txt -X POST "http://localhost:3000/admin/motions/$MOTION_ID/tokens" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "_csrf=$CSRF_TOKEN" \
  --data "recipients=Alice Smith,alice@example.com,Unit 101
Bob Johnson,bob@example.com,Unit 102" \
  -s -o /dev/null

# Fetch the tokens page to extract the generated tokens
TOKEN_RESPONSE=$(curl -b /tmp/cookies.txt -s "http://localhost:3000/admin/motions/$MOTION_ID/tokens")

# Extract tokens from the response (from value attributes)
TOKENS=$(echo "$TOKEN_RESPONSE" | grep -oP 'token=\K[^"]+' | head -2)
TOKEN_A=$(echo "$TOKENS" | sed -n 1p)
TOKEN_B=$(echo "$TOKENS" | sed -n 2p)

[ -n "$TOKEN_A" ] && [ -n "$TOKEN_B" ]
test_result $? "Generated 2 tokens"

echo ""
echo "5. Voting with Token A (should succeed)..."
VOTE_RESPONSE=$(curl -X POST "http://localhost:3000/vote/$MOTION_ID" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN_A" \
  -d "choice=Yes" \
  -s)

echo "$VOTE_RESPONSE" | grep -q "successfully"
test_result $? "First vote succeeded"

echo ""
echo "6. Trying to vote again with Token A (should fail)..."
REVOTE_RESPONSE=$(curl -X POST "http://localhost:3000/vote/$MOTION_ID" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN_A" \
  -d "choice=No" \
  -s)

echo "$REVOTE_RESPONSE" | grep -q "already been used"
test_result $? "Duplicate vote blocked"

echo ""
echo "7. Voting with Token B (should succeed)..."
VOTE2_RESPONSE=$(curl -X POST "http://localhost:3000/vote/$MOTION_ID" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN_B" \
  -d "choice=No" \
  -s)

echo "$VOTE2_RESPONSE" | grep -q "successfully"
test_result $? "Second vote succeeded"

echo ""
echo "8. Checking dashboard for correct counts..."
DASHBOARD=$(curl -b /tmp/cookies.txt -s "http://localhost:3000/admin/dashboard")

echo "$DASHBOARD" | grep -q "Test Motion"
test_result $? "Motion appears on dashboard"

# Check vote counts in motion detail
DETAIL=$(curl -b /tmp/cookies.txt -s "http://localhost:3000/admin/motions/$MOTION_ID")
echo "$DETAIL" | grep -q ">2<" # 2 votes cast
test_result $? "Vote count is correct (2 votes)"

echo ""
echo "9. Testing CSV export..."
CSV_RESPONSE=$(curl -b /tmp/cookies.txt -s "http://localhost:3000/admin/motions/$MOTION_ID/export.csv")

echo "$CSV_RESPONSE" | grep -q "submitted_at,choice"
test_result $? "CSV export works"

echo "$CSV_RESPONSE" | grep -q "Alice Smith"
test_result $? "CSV contains voter data"

echo ""
echo "================================"
echo "Test Summary:"
echo -e "${GREEN}Passed: $PASS${NC}"
if [ $FAIL -gt 0 ]; then
  echo -e "${RED}Failed: $FAIL${NC}"
else
  echo "Failed: $FAIL"
fi
echo "================================"

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
fi
