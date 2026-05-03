#!/usr/bin/env bash
# Record a 20-second promo of `mini` automatically.
#
# Requires:
#   - macOS 11+ (for `screencapture -v -V`)
#   - Screen Recording permission for Terminal/iTerm
#     (System Settings → Privacy & Security → Screen Recording)
#   - Accessibility permission for Terminal/iTerm
#     (System Settings → Privacy & Security → Accessibility)
#   - `mini` installed at /Applications/mini.app  *or*  the `mini` CLI shim
#
# Usage:
#   ./record-promo.sh                 # writes promo.mov in cwd
#   ./record-promo.sh out.mov         # custom output path

set -euo pipefail

DURATION=20
OUT="${1:-promo.mov}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLESCRIPT="$SCRIPT_DIR/demo.applescript"

if [[ ! -f "$APPLESCRIPT" ]]; then
	echo "✗ Missing $APPLESCRIPT" >&2
	exit 1
fi

# 1. Fresh empty markdown file so the demo always starts from zero.
TMPFILE="$(mktemp -t mini-promo).md"
: > "$TMPFILE"
trap 'rm -f "$TMPFILE"' EXIT

# 2. Launch mini with the empty file.
if [[ -d "/Applications/mini.app" ]]; then
	open -a "mini" "$TMPFILE"
elif command -v mini >/dev/null 2>&1; then
	mini "$TMPFILE" &
else
	echo "✗ mini is not installed."
	echo "  Run 'npm run package' first, or start it manually with 'npm start'"
	echo "  and re-run this script with the app already focused."
	exit 1
fi

# 3. Give the window time to open and settle.
sleep 2

# 4. Start screen recording in the background.
echo "● Recording ${DURATION}s → $OUT"
screencapture -v -V "$DURATION" -x "$OUT" &
REC_PID=$!

# 5. Tiny grace period so the first frame is clean (no terminal flicker).
sleep 0.4

# 6. Run the choreography. AppleScript blocks until the demo is done.
osascript "$APPLESCRIPT"

# 7. Wait for the recorder to hit its time limit and flush the file.
wait "$REC_PID" || true

echo "✓ Done: $OUT"
echo
echo "Next steps:"
echo "  • Crop to the mini window in your editor (CapCut, Resolve, Final Cut)."
echo "  • Add music + key overlays (KeyCastr can pre-render keys if you re-shoot)."
echo "  • Export 1080p H.264 for social, ProRes if you want to keep mastering."
