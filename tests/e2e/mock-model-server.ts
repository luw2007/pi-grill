// Deterministic OpenAI-completions mock for the grill E2E: three scripted turns
// (publish Q1 -> publish converge QF after the answers steer -> write the plan
// after the plan prompt). State is inferred from conversation content, not turn
// counters, so host retries stay harmless.
const port = Number(process.env.MOCK_MODEL_PORT ?? 8123);

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[] };

let published = false;
let converged = false;
let planWritten = false;
const seen: string[] = [];

function textOf(message: ChatMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
	return "";
}

function sse(events: object[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: object, finish: string | null): object {
	return { id: "mock", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] };
}

function toolCall(name: string, args: object): Response {
	return sse([
		chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null),
		chunk({}, "tool_calls"),
	]);
}

function say(text: string): Response {
	return sse([chunk({ role: "assistant", content: text }, null), chunk({}, "stop")]);
}

const scenario = process.env.MOCK_SCENARIO ?? "e2e";
let refined = false;

function demoTurn(transcript: string): Response | undefined {
	if (!published && transcript.includes("You are running a /grill design interview")) {
		published = true;
		return toolCall("grill_ask", {
			questions: [
				{
					id: "Q1",
					section: "1. Storage",
					question: "Which storage layer should the sync engine use?",
					options: [
						{ value: "sqlite", label: "SQLite", description: "single file, transactional", recommendationReason: "zero-ops and every target platform ships it" },
						{ value: "flat", label: "Flat JSON files", description: "diff-friendly, slow at scale" },
						{ value: "postgres", label: "Postgres", description: "needs a server per team" },
					],
					recommended: "sqlite",
				},
				{
					id: "Q2",
					section: "2. Sync semantics",
					question: "How should concurrent edits be reconciled?",
					options: [
						{ value: "lww", label: "Last write wins", description: "simple, may lose edits" },
						{ value: "merge", label: "Three-way merge", description: "keeps everything, needs conflict UI" },
					],
					recommended: "lww",
				},
			],
			converge: false,
		});
	}
	if (published && !refined && transcript.includes("Q1: ")) {
		refined = true;
		return toolCall("grill_ask", {
			questions: [{
				id: "Q3",
				section: "1. Storage",
				question: "SQLite it is — which transport should replicate it between teammates?",
				context: "Follows from Q1: the transport decides offline behaviour and infra cost.",
				options: [
					{ value: "poll", label: "HTTPS polling", description: "boring, works everywhere" },
					{ value: "push", label: "WebSocket push", description: "instant, needs a broker" },
				],
			}],
			converge: false,
		});
	}
	if (refined && !converged && transcript.includes("Q3: ") && transcript.includes("skipped by the user") && transcript.includes("User note:")) {
		converged = true;
		return toolCall("grill_ask", {
			questions: [{
				id: "QF",
				section: "9. Final",
				question: "Ready to write the plan?",
				options: [{ value: "confirm", label: "确认生成 plan" }],
				recommended: "confirm",
			}],
			converge: true,
		});
	}
	if (!planWritten && transcript.includes("The user confirmed convergence")) {
		planWritten = true;
		return toolCall("write", {
			path: "docs/plans/snippets-cli-20260818-sync-engine.md",
			content: [
				"# Sync engine for the team snippets CLI",
				"",
				"## Storage",
				"SQLite — zero-ops, transactional, ships everywhere.",
				"",
				"## Replication transport",
				"Custom: CRDT log over SSH (user-provided answer).",
				"",
				"## Deferred",
				"Conflict policy skipped for now; encryption out of scope for v1 (user note).",
				"",
				"## Interview transcript",
				"- Q1 [answered] Which storage layer should the sync engine use? -> SQLite",
				"- Q2 [skipped] How should concurrent edits be reconciled? (skipped by the user; still re-answerable)",
				"- Q3 [answered] Which transport should replicate it between teammates? -> CRDT log over SSH (custom)",
				"- QF [answered] Ready to write the plan? -> 确认生成 plan",
				"- Note: encryption is out of scope for v1",
				"",
			].join("\n"),
		});
	}
	return undefined;
}

Bun.serve({
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/state") return Response.json({ published, converged, planWritten, seen });
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const payload = (await request.json()) as { messages: ChatMessage[] };
		const transcript = payload.messages.map((message) => `${message.role}: ${textOf(message)}`).join("\n---\n");
		seen.push(transcript.slice(-2000));

		if (scenario === "demo") {
			const demo = demoTurn(transcript);
			return demo ?? say("Noted — investigating while you answer.");
		}
		if (scenario === "omp") {
			// OMP host-contract regression: publish Q1, then keep the follow-up turn
			// in flight for 8s so the driver can press Esc against a live turn.
			if (!published && transcript.includes("design interview")) {
				published = true;
				return toolCall("grill_ask", {
					questions: [{
						id: "Q1",
						section: "1. Scope",
						question: "Which storage layer should the demo use?",
						options: [
							{ value: "alpha", label: "Alpha store" },
							{ value: "beta", label: "Beta store" },
						],
						recommended: "beta",
					}],
					converge: false,
				});
			}
			await new Promise((resolve) => setTimeout(resolve, 8000));
			return say("still thinking");
		}
		if (!published && transcript.includes("You are running a /grill design interview")) {
			published = true;
			return toolCall("grill_ask", {
				questions: [{
					id: "Q1",
					section: "1. Scope",
					question: "Which storage layer should the demo use?",
					options: [
						{ value: "alpha", label: "Alpha store", description: "simple" },
						{ value: "beta", label: "Beta store", description: "fast", recommendationReason: "fits the demo" },
					],
					recommended: "beta",
				}],
				converge: false,
			});
		}
		if (published && !converged && transcript.includes("Q1: ")) {
			converged = true;
			return toolCall("grill_ask", {
				questions: [{
					id: "QF",
					section: "9. Final",
					question: "Ready to write the plan?",
					options: [{ value: "confirm", label: "确认生成 plan" }],
					recommended: "confirm",
				}],
				converge: true,
			});
		}
		if (!planWritten && transcript.includes("The user confirmed convergence")) {
			planWritten = true;
			return toolCall("write", {
				path: "docs/plans/e2e-20260818-grill-demo.md",
				content: [
					"# E2E grill demo plan",
					"",
					"## Decision",
					"Beta store, per the interview.",
					"",
					"## Interview transcript",
					"- Q1 [answered] Which storage layer should the demo use? -> Beta store",
					"- QF [answered] Ready to write the plan? -> 确认生成 plan",
					"",
				].join("\n"),
			});
		}
		return say("ok, standing by.");
	},
});

console.log(`mock model listening on :${port}`);
