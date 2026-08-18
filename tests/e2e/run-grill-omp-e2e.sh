#!/bin/bash
# OMP host-contract regression for pi-grill against a REAL Oh My Pi TUI.
#
# Guards the crash class found on OMP 17.3.4: overlay handles expose only
# {hide, setHidden, isHidden} and the host input dispatch has no try/catch
# around extension components, so one unguarded handle call (the original
# `handle?.unfocus()`) killed the whole OMP process on Esc.
#
# Asserts, against a live OMP with a deterministic local mock model:
#   1. /grill starts and grill_ask opens the panel (needs a typed user message:
#      OMP queues idle followUp messages instead of starting a turn).
#   2. Esc while the panel is focused hides it (widget flips to [hidden])
#      and the host process survives — no "Uncaught Exception".
#   3. A second Esc interrupts the in-flight turn without tearing the panel
#      session down — no "closed unexpectedly".
#   4. /grill-panel reopens the same panel.
#
# Usage: npm run e2e:omp   (skips cleanly when omp is not installed)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# Prefer the real compiled binary: under `bun run`, PATH is prefixed with every
# ancestor node_modules/.bin, where an omp JS shim shadows it and dies on spawn.
OMP_BIN="${OMP_BIN:-$([[ -x "$HOME/.bun/bin/omp" ]] && echo "$HOME/.bun/bin/omp" || command -v omp || true)}"
if [[ ! -x "$OMP_BIN" ]]; then
	echo "SKIP: omp not installed"
	exit 0
fi

E2E="$(mktemp -d /tmp/grill-omp-e2e.XXXXXX)"
PORT=$((20000 + RANDOM % 20000))
SERVER_PID=""
LOG="$E2E/session.log"

cleanup() {
	[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
	rm -rf "$E2E"
}
trap cleanup EXIT

mkdir -p "$E2E/home/.omp/agent" "$E2E/proj"
cat > "$E2E/home/.omp/agent/config.yml" <<EOF
startup:
  quiet: true
  showSplash: false
  setupWizard: false
  checkUpdate: false
EOF
cat > "$E2E/home/.omp/agent/models.json" <<EOF
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

MOCK_MODEL_PORT=$PORT MOCK_SCENARIO=omp bun "$REPO/tests/e2e/mock-model-server.ts" &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/state" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/state" >/dev/null || { echo "FAIL: mock server did not start"; exit 1; }

# env -i: `bun run` injects BUN_* vars that break the bun-compiled omp binary
# under expect; a clean environment keeps the run hermetic either way.
env -i HOME="$E2E/home" PATH="$PATH" TERM=xterm-256color OMP_SKIP_SETUP=1 expect <<EXP
set timeout 40
log_file -noappend "$LOG"
cd "$E2E/proj"
spawn "$OMP_BIN" --no-session --no-extensions --no-skills --no-rules -e "$REPO/grill.ts" --model mock/mock-1
proc drain {seconds} {
	global spawn_id
	expect -timeout \$seconds {
		"zzz-never-matches-zzz" {}
		timeout {}
	}
}
drain 8
send "/grill demo storage feature\r"
expect {
	"grill state started" {}
	timeout { puts "FAIL: /grill never ran"; exit 1 }
}
# OMP queues idle followUps without starting a turn; a typed message starts it.
drain 1
send "go\r"
expect {
	"Which storage layer should the demo use?" {}
	timeout { puts "FAIL: Q1 never published"; exit 1 }
}
drain 2
send "\x1b"
expect {
	"hidden] /grill-panel to open" {}
	timeout { puts "FAIL: Esc did not hide the panel"; exit 1 }
}
send "\x1b"
drain 2
send "/grill-panel\r"
expect {
	"Which storage layer should the demo use?" {}
	timeout { puts "FAIL: /grill-panel did not reopen the panel"; exit 1 }
}
send "\x04"
drain 1
catch { close }
exit 0
EXP

if grep -aq "Uncaught Exception" "$LOG"; then
	echo "FAIL: host crashed with an uncaught exception"
	grep -a -A6 "Uncaught Exception" "$LOG" | head -10
	exit 1
fi
if grep -aq "closed unexpectedly" "$LOG"; then
	echo "FAIL: panel session was torn down by the interrupt"
	exit 1
fi
echo "OMP E2E PASS: panel opened, Esc hid without crashing the host, interrupt kept the session, /grill-panel reopened"
