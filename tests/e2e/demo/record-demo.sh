#!/bin/bash
# Record the README demo GIF: real pi TUI + deterministic mock model + VHS.
# Storyboard: tests/e2e/demo/STORYBOARD.md. Output: assets/demo.gif.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
E2E="$(mktemp -d /tmp/grill-demo.XXXXXX)"
PORT=$((20000 + RANDOM % 20000))
PI_BIN="${PI_BIN:-$(command -v pi || echo /opt/homebrew/bin/pi)}"
SERVER_PID=""

cleanup() {
	[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
	rm -rf "$E2E"
}
trap cleanup EXIT

mkdir -p "$E2E/home/.pi/agent" "$E2E/proj/docs/plans" "$REPO/assets"
cat > "$E2E/home/.pi/agent/models.json" <<EOF
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:$PORT/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "models": [
        { "id": "mock-1", "name": "Mock One", "input": ["text"], "contextWindow": 200000, "maxTokens": 32000 }
      ]
    }
  }
}
EOF
printf '{"%s": true, "/private%s": true}\n' "$E2E/proj" "$E2E/proj" > "$E2E/home/.pi/agent/trust.json"

MOCK_MODEL_PORT=$PORT MOCK_SCENARIO=demo bun "$REPO/tests/e2e/mock-model-server.ts" &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/state" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/state" >/dev/null || { echo "FAIL: mock server did not start"; exit 1; }

TAPE="$E2E/demo.tape"
cat > "$TAPE" <<EOF
Output "$REPO/assets/demo.gif"
Set FontSize 14
Set Width 1200
Set Height 800
Set Padding 12
Set Framerate 15
Set TypingSpeed 40ms

Hide
Type "cd $E2E/proj && env HOME=$E2E/home $PI_BIN --no-session --no-extensions --no-skills --no-prompt-templates -e $REPO/grill.ts --model mock/mock-1"
Enter
Sleep 5s
Show

Type "/grill sync engine for the team snippets CLI"
Sleep 500ms
Enter
Sleep 4.5s

Enter
Sleep 1.2s
Down
Sleep 800ms
Down
Sleep 800ms
Up
Sleep 500ms
Up
Sleep 900ms
Enter
Sleep 4s

Ctrl+N
Sleep 900ms
Type "encryption is out of scope for v1"
Sleep 700ms
Enter
Sleep 2.5s

Left
Sleep 1s
Ctrl+S
Sleep 2.5s

Type "/grill-panel"
Sleep 400ms
Enter
Sleep 1.8s

Down
Sleep 600ms
Down
Sleep 900ms
Enter
Sleep 1s
Type "CRDT log over SSH"
Sleep 800ms
Enter
Sleep 4s

Enter
Sleep 1.8s
Enter
Sleep 5s

Hide
Ctrl+D
Sleep 1.5s
Show
Type "cat docs/plans/snippets-cli-20260818-sync-engine.md"
Enter
Sleep 5s
EOF

vhs "$TAPE"
[[ -s "$REPO/assets/demo.gif" ]] || { echo "FAIL: gif not produced"; exit 1; }
STATE="$(curl -sf "http://127.0.0.1:$PORT/state")"
echo "$STATE" | jq -e '.published and .converged and .planWritten' >/dev/null || { echo "FAIL: demo turns incomplete: $STATE"; exit 1; }
echo "DEMO OK: $(du -h "$REPO/assets/demo.gif" | cut -f1) assets/demo.gif"
