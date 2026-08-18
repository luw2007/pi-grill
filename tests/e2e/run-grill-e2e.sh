#!/bin/bash
# Full E2E regression for pi-grill against a REAL pi TUI:
# real overlay rendering, real terminal key encoding, real steer delivery,
# real built-in write tool. The model is a deterministic local mock
# (tests/e2e/mock-model-server.ts), so no LLM cost and no flakiness.
#
# Usage: bash tests/e2e/run-grill-e2e.sh   (or: npm run e2e)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="$(mktemp -d /tmp/grill-e2e.XXXXXX)"
PORT=$((20000 + RANDOM % 20000))
PI_BIN="${PI_BIN:-$(command -v pi || echo /opt/homebrew/bin/pi)}"
SERVER_PID=""

cleanup() {
	[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
	rm -rf "$E2E"
}
trap cleanup EXIT

mkdir -p "$E2E/home/.pi/agent" "$E2E/proj/docs/plans"
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

MOCK_MODEL_PORT=$PORT bun "$REPO/tests/e2e/mock-model-server.ts" &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/state" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/state" >/dev/null || { echo "FAIL: mock server did not start"; exit 1; }

# Drive the real TUI. Sequence learned from a live run:
# panel opens focused on the ledger -> Enter enters the answer pane ->
# Enter submits the preselected recommended option; the converge batch
# reopens with the answer pane already focused; ui.confirm preselects Yes.
env HOME="$E2E/home" expect <<EXP
set timeout 40
cd "$E2E/proj"
spawn "$PI_BIN" --no-session --no-extensions --no-skills --no-prompt-templates -e "$REPO/grill.ts" --model mock/mock-1
expect {
	"grill.ts" {}
	timeout { puts "FAIL: extension never loaded"; exit 1 }
}
sleep 1
send "/grill demo storage feature\r"
expect {
	"Which storage layer should the demo use?" {}
	timeout { puts "FAIL: Q1 never published"; exit 1 }
}
sleep 0.5
send "\r"
expect {
	-re {Enter submit} {}
	timeout { puts "FAIL: answer pane never focused"; exit 1 }
}
sleep 0.3
send "\r"
expect {
	"Ready to write the plan?" {}
	timeout { puts "FAIL: converge question never published"; exit 1 }
}
sleep 0.5
send "\r"
expect {
	"Write the plan?" {}
	timeout { puts "FAIL: confirm dialog never opened"; exit 1 }
}
sleep 0.3
send "\r"
expect {
	"interview converged" {}
	timeout { puts "FAIL: convergence never completed"; exit 1 }
}
expect {
	"Plan written" {}
	"standing by" {}
	timeout {}
}
sleep 1
send "\x04"
expect eof
EXP

PLAN="$E2E/proj/docs/plans/e2e-20260818-grill-demo.md"
STATE_DIR="$(find "${TMPDIR:-/tmp}" -maxdepth 2 -type d -name 'proj-*' -newer "$E2E/home" 2>/dev/null | head -1)"

fail=0
grep -q '## Interview transcript' "$PLAN" || { echo "FAIL: plan file missing or lacks transcript"; fail=1; }
STATE_JSON="$(find "${TMPDIR:-/tmp}/grill" -name '*.json' -newer "$E2E/home/.pi/agent/models.json" 2>/dev/null | head -1)"
if [[ -n "$STATE_JSON" ]]; then
	[[ "$(jq -r '.answeredCount' "$STATE_JSON")" == "2" ]] || { echo "FAIL: answeredCount != 2"; fail=1; }
	[[ "$(jq -r '.questions[0].userChoice' "$STATE_JSON")" == "Beta store" ]] || { echo "FAIL: Q1 answer wrong"; fail=1; }
else
	echo "FAIL: state JSON not found"; fail=1
fi
STATE_FLAGS="$(curl -sf "http://127.0.0.1:$PORT/state")"
echo "$STATE_FLAGS" | jq -e '.published and .converged and .planWritten' >/dev/null || { echo "FAIL: mock turns incomplete: $STATE_FLAGS"; fail=1; }

if [[ $fail -eq 0 ]]; then
	echo "E2E PASS: plan written, state 2/2 answered, all mock turns exercised"
else
	exit 1
fi
