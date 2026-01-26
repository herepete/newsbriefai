#!/bin/bash

# Vote counting script for feedback analysis
# Parses feedback JSON files and generates vote statistics

FEEDBACK_DIR="/opt/bitnami/apache/htdocs/public/data/feedback"
OUTPUT_DIR="/home/bitnami/htdocs/vote-reports"

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "=== Feedback Vote Counter ==="
echo ""

# Check if feedback directory exists
if [ ! -d "$FEEDBACK_DIR" ]; then
    echo "Error: Feedback directory not found at $FEEDBACK_DIR"
    exit 1
fi

# Get all feedback files
FILES=$(find "$FEEDBACK_DIR" -name "feedback-*.json" -type f | sort)

if [ -z "$FILES" ]; then
    echo "No feedback files found in $FEEDBACK_DIR"
    exit 1
fi

# Create a temporary file to hold all votes in a format we can process
TEMP_VOTES="/tmp/all_votes_$$.jsonl"
> "$TEMP_VOTES"

# Extract all votes from all files
while IFS= read -r FILE; do
    if [ -f "$FILE" ]; then
        jq -r '.votes[] | "\(.ymd)|\(.tab)|\(.vote)"' "$FILE" 2>/dev/null >> "$TEMP_VOTES"
    fi
done <<< "$FILES"

# Count overall totals
TOTAL_UP=$(grep -c '|up$' "$TEMP_VOTES" 2>/dev/null)
TOTAL_DOWN=$(grep -c '|down$' "$TEMP_VOTES" 2>/dev/null)
[ -z "$TOTAL_UP" ] && TOTAL_UP=0
[ -z "$TOTAL_DOWN" ] && TOTAL_DOWN=0
TOTAL_VOTES=$((TOTAL_UP + TOTAL_DOWN))

# Generate text report
REPORT_FILE="$OUTPUT_DIR/vote-report-$(date +%Y-%m-%d_%H%M%S).txt"

{
    echo "=== Vote Report Generated: $(date) ==="
    echo ""

    # Overall totals
    echo "OVERALL TOTALS"
    echo "=============="
    echo "Total Votes: $TOTAL_VOTES"
    echo "Thumbs Up (👍): $TOTAL_UP"
    echo "Thumbs Down (👎): $TOTAL_DOWN"

    if [ $TOTAL_VOTES -gt 0 ]; then
        UP_PERCENT=$((TOTAL_UP * 100 / TOTAL_VOTES))
        DOWN_PERCENT=$((TOTAL_DOWN * 100 / TOTAL_VOTES))
        echo "Positive Rate: $UP_PERCENT%"
        echo "Negative Rate: $DOWN_PERCENT%"
    fi

    echo ""
    echo "BY TAB"
    echo "====="

    # Count votes per tab
    cut -d'|' -f2 "$TEMP_VOTES" | sort -u | while read TAB; do
        [ -z "$TAB" ] && continue
        UP=$(grep "^[^|]*|$TAB|up$" "$TEMP_VOTES" | wc -l)
        DOWN=$(grep "^[^|]*|$TAB|down$" "$TEMP_VOTES" | wc -l)
        SUBTOTAL=$((UP + DOWN))

        if [ $SUBTOTAL -gt 0 ]; then
            PERCENT=$((UP * 100 / SUBTOTAL))
            printf "%-20s Up: %3d  Down: %3d  Total: %3d  Positive: %3d%%\n" "$TAB" "$UP" "$DOWN" "$SUBTOTAL" "$PERCENT"
        fi
    done

    echo ""
    echo "BY DATE"
    echo "======="

    # Count votes per date
    cut -d'|' -f1 "$TEMP_VOTES" | sort -u | while read DATE; do
        [ -z "$DATE" ] && continue
        UP=$(grep "^$DATE|.*|up$" "$TEMP_VOTES" | wc -l)
        DOWN=$(grep "^$DATE|.*|down$" "$TEMP_VOTES" | wc -l)
        SUBTOTAL=$((UP + DOWN))

        if [ $SUBTOTAL -gt 0 ]; then
            PERCENT=$((UP * 100 / SUBTOTAL))
            printf "%-12s Up: %3d  Down: %3d  Total: %3d  Positive: %3d%%\n" "$DATE" "$UP" "$DOWN" "$SUBTOTAL" "$PERCENT"
        fi
    done

} | tee "$REPORT_FILE"

echo ""
echo "Report saved to: $REPORT_FILE"

# Also output as JSON for programmatic access
JSON_REPORT="$OUTPUT_DIR/vote-report-$(date +%Y-%m-%d_%H%M%S).json"

# Build JSON report
{
    echo "{"
    echo "  \"generated_at\": \"$(date -Iseconds)\","
    echo "  \"totals\": {"
    echo "    \"up\": $TOTAL_UP,"
    echo "    \"down\": $TOTAL_DOWN,"
    echo "    \"total\": $TOTAL_VOTES,"

    if [ $TOTAL_VOTES -gt 0 ]; then
        UP_PERCENT=$((TOTAL_UP * 100 / TOTAL_VOTES))
        echo "    \"positive_rate_percent\": $UP_PERCENT"
    else
        echo "    \"positive_rate_percent\": 0"
    fi

    echo "  },"
    echo "  \"by_tab\": {"

    FIRST=true
    cut -d'|' -f2 "$TEMP_VOTES" | sort -u | while read TAB; do
        [ -z "$TAB" ] && continue
        UP=$(grep "^[^|]*|$TAB|up$" "$TEMP_VOTES" | wc -l)
        DOWN=$(grep "^[^|]*|$TAB|down$" "$TEMP_VOTES" | wc -l)
        SUBTOTAL=$((UP + DOWN))

        if [ $SUBTOTAL -gt 0 ]; then
            PERCENT=$((UP * 100 / SUBTOTAL))
            [ "$FIRST" = false ] && echo ","
            echo -n "    \"$TAB\": {\"up\": $UP, \"down\": $DOWN, \"total\": $SUBTOTAL, \"positive_percent\": $PERCENT}"
            FIRST=false
        fi
    done

    echo ""
    echo "  },"
    echo "  \"by_date\": {"

    FIRST=true
    cut -d'|' -f1 "$TEMP_VOTES" | sort -u | while read DATE; do
        [ -z "$DATE" ] && continue
        UP=$(grep "^$DATE|.*|up$" "$TEMP_VOTES" | wc -l)
        DOWN=$(grep "^$DATE|.*|down$" "$TEMP_VOTES" | wc -l)
        SUBTOTAL=$((UP + DOWN))

        if [ $SUBTOTAL -gt 0 ]; then
            PERCENT=$((UP * 100 / SUBTOTAL))
            [ "$FIRST" = false ] && echo ","
            echo -n "    \"$DATE\": {\"up\": $UP, \"down\": $DOWN, \"total\": $SUBTOTAL, \"positive_percent\": $PERCENT}"
            FIRST=false
        fi
    done

    echo ""
    echo "  }"
    echo "}"
} > "$JSON_REPORT"

echo "JSON report saved to: $JSON_REPORT"

# Cleanup
rm -f "$TEMP_VOTES"
