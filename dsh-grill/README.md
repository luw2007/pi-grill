# dsh-grill

A dependency-driven design interview plugin for the DeepSeek Harness **web GUI**, ported from pi-grill (`../grill.ts`). The agent interviews you one decision at a time through an **asynchronous panel** — publishing questions never blocks the agent, so it keeps investigating while you answer.

## What you get

- **`grill_ask` tool** — the agent publishes question batches (sections, options, recommendations, `requiresText`, convergence questions) and keeps working.
- **Global floating panel** (`shell.overlay`) — badge with the open-question count; a ledger of every question grouped by section, the current question with options, recommendation badges, custom answers, skip, re-answer (the old answer stays as a `deprecated` row), and free-form notes for the agent.
- **Answer delivery** — answers, skips and notes are steered into the agent loop as user messages (same wording as pi-grill), so the interview transcript stays coherent.
- **Convergence** — once nothing is pending/current, the agent asks the final write-the-plan question; confirming hands the agent the plan prompt and it writes the implementation plan to `docs/plans/` (or `plans/`) with the full interview transcript.
- **Durable state** — JSON + HTML mirror per interview, schema v4 compatible with pi-grill, under `<cwd>/.dsh-grill/` (configurable). A session started in pi can resume here and vice versa.

## Install

The bundle ships a `dsh.bundle` patch layer plus a web client half (`dsh.client`). Two ways:

### Via `dsh plugin add` (recommended)

```sh
cd dsh-grill && npm run build   # build lib/index.js + lib/client.js
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /absolute/path/to/dsh-grill
pnpm dsh web                    # restart your web GUI
```

The profile now activates the bundle on every boot; the web page fetches the client half automatically.

### Via `--patch` overlay (development)

```sh
cd /path/to/deepseek-harness
pnpm dsh web --patch /absolute/path/to/dsh-grill/cordis.yml --port 3180
```

The dev overlay loads `src/index.ts` directly (the loader resolves plugin rows against the profile directory, so the path must be absolute).

## Usage

1. In the GUI composer, type `/grill <describe the feature or idea you want to design>`.
2. The agent receives the interview brief and starts publishing questions with `grill_ask`.
3. The 🍖 badge (top-right) shows open questions; click it to open the panel. New question batches open it automatically.
4. Answer, skip, re-answer, or send a note; each action is steered back to the agent immediately.
5. When the agent asks the convergence question, answer with a confirm keyword (defaults: `confirm`, `converge`, `yes`, `确认`, `生成`) and it writes the plan.

## Configuration (plugin `config`)

| key | default | meaning |
| --- | --- | --- |
| `directory` | `.dsh-grill` | where per-interview JSON + HTML files live (relative to the session cwd) |
| `convergeKeywords` | `[confirm, converge, yes, 确认, 生成]` | answer keywords that confirm convergence |

## Architecture

- **Host half** (`src/`): `state.ts` state machine (ported from pi-grill, no TUI), `runtime.ts` per-agent interview runtime (persistence, answer batching, steer delivery, convergence), `tool.ts` (`grill_ask`), `command.ts` (`/grill`), `routes.ts` (`/grill/state`, `/grill/answer`, `/grill/skip`, `/grill/note`, `/grill/events` SSE), `persist.ts` (JSON + HTML mirror), `prompts.ts`.
- **Browser half** (`src/client/`): `port.ts` (fetch + SSE client), `GrillOverlay.tsx` (badge + panel) registered into the `shell.overlay` slot.
- **Transport**: plain HTTP routes on the host `webServer` service plus an SSE change channel — no in-tree Typert/Remote wiring needed (out-of-tree bundles cannot enter the compiled remote allowlist). The host is the single authority; the panel re-reads `/grill/state` after every change event.

## Development

```sh
bun install          # typescript/esbuild/vitest + types
# node_modules/@deepseek-ai/* are symlinks into the deepseek-harness checkout
npm run check        # typecheck + vitest + build
```

`build.mjs` mirrors the DSH `clientBundle` contract: the browser half is a CJS closure-factory bundle (`window.__ModuleLoader__.load`) whose externals are the platform module table (`react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`, …) and whose CSS modules are inlined as `<style data-plugin>` injection with hashed class maps.

## Known limitations

- The panel drafts (selected option, typed text) are not durable across reloads; the interview state itself is.
- Any open browser page can answer any interview (frame-wide by design, like the cordis panel).
- Multi-page concurrency: the host is authoritative; a stale page action fails loudly instead of being applied twice.