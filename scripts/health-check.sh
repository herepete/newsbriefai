#!/bin/bash

# Health check script for feedback server
# Verifies the feedback server is running and responding

FEEDBACK_SERVER="http://127.0.0.1:3001"
STATUS_FILE="/tmp/feedback-health-$(date +%s).json"

# Check 1: Service status
echo "=== Feedback Server Health Check ==="
echo ""
echo "1. Checking systemd service status..."
if systemctl is-active --quiet feedback-server.service; then
    echo "   ✓ Service is running"
else
    echo "   ✗ Service is NOT running"
    echo "   Start with: systemctl start feedback-server.service"
    exit 1
fi

# Check 2: Port is listening
echo ""
echo "2. Checking if port 3001 is listening..."
if netstat -tlnp 2>/dev/null | grep -q ":3001"; then
    echo "   ✓ Port 3001 is listening"
elif ss -tlnp 2>/dev/null | grep -q ":3001"; then
    echo "   ✓ Port 3001 is listening"
else
    echo "   ✗ Port 3001 is not responding"
    exit 1
fi

# Check 3: Test feedback endpoint
echo ""
echo "3. Testing feedback API endpoint..."
RESPONSE=$(curl -s -X POST "$FEEDBACK_SERVER/api/feedback" \
    -H "Content-Type: application/json" \
    -d "{\"ymd\":\"$(date +%Y-%m-%d)\",\"tab\":\"health-check\",\"vote\":\"up\",\"anonId\":\"health-check-$(date +%s)\"}" \
    -w "\n%{http_code}" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
    echo "   ✓ API endpoint responding with HTTP $HTTP_CODE"
else
    echo "   ✗ API endpoint returned HTTP $HTTP_CODE"
    exit 1
fi

# Check 4: Verify feedback data directory
echo ""
echo "4. Checking feedback data directory..."
FEEDBACK_DIR="/opt/bitnami/apache/htdocs/public/data/feedback"
if [ -d "$FEEDBACK_DIR" ] && [ -w "$FEEDBACK_DIR" ]; then
    echo "   ✓ Feedback directory exists and is writable"
    FILE_COUNT=$(find "$FEEDBACK_DIR" -type f -name "feedback-*.json" 2>/dev/null | wc -l)
    echo "   ✓ Found $FILE_COUNT feedback files"
else
    echo "   ✗ Feedback directory not accessible"
    exit 1
fi

# Check 5: Recent feedback files
echo ""
echo "5. Recent feedback activity..."
LATEST_FILE=$(find "$FEEDBACK_DIR" -type f -name "feedback-*.json" 2>/dev/null -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
if [ -n "$LATEST_FILE" ]; then
    VOTE_COUNT=$(grep -o '"vote"' "$LATEST_FILE" 2>/dev/null | wc -l)
    LATEST_DATE=$(basename "$LATEST_FILE" | sed 's/feedback-//;s/.json//')
    echo "   ✓ Latest file: $LATEST_DATE ($VOTE_COUNT votes)"
else
    echo "   ⓘ No feedback files found yet"
fi

echo ""
echo "=== Health Check Complete ==="
echo "Status: All systems operational ✓"
