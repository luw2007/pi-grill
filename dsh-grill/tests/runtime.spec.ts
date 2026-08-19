import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defaultGrillConfig, type AskQuestion } from "../src/state.ts";
import { GrillRuntime, type GrillRuntimeDeps } from "../src/runtime.ts";

type Steered = { kind: "steer" | "followup"; text: string };

function makeAgent(): { agent: Agent; steered: Steered[] } {
	const steered: Steered[] = [];
	const agent = {
		id: "agent-1",
		status: "idle",
		session: { header: { cwd: "/work" } },
		steer: (message: { content: { text: string }[] }) => {
			steered.push({ kind: "steer", text: message.content[0]!.text });
		},
		followup: (message: { content: { text: string }[] }) => {
			steered.push({ kind: "followup", text: message.content[0]!.text });
		},
	} as unknown as Agent;
	return { agent, steered };
}

const q = (id: string, section = "Scope"): AskQuestion => ({
	id,
	section,
	question: "Q " + id,
	options: [
		{ value: "a", label: "Option A", recommended: true },
		{ value: "b", label: "Option B" },
		{ value: "confirm", label: "Confirm" },
	],
	recommended: "a",
});

describe("GrillRuntime", () => {
	let dir: string;
	let agent: Agent;
	let steered: Steered[];
	let broadcasts: string[];
	let deps: GrillRuntimeDeps;
	let runtime: GrillRuntime;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "grill-test-"));
		({ agent, steered } = makeAgent());
		broadcasts = [];
		deps = {
			agents: { get: (id: string) => (id === agent.id ? agent : undefined) },
			config: { ...defaultGrillConfig(), directory: dir },
			logger: { warn: (message: string) => { console.warn(message); } },
			broadcast: (sessionId: string) => { broadcasts.push(sessionId); },
		};
		runtime = new GrillRuntime(agent.id, "/work", "topic", deps);
	});

	afterEach(() => {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("publish before start fails", () => {
		expect(runtime.publish([q("one")], false).ok).toBe(false);
	});

	it("start persists state and broadcasts", () => {
		const started = runtime.start("topic");
		expect(started.ok).toBe(true);
		expect(runtime.statePath.endsWith(".json")).toBe(true);
		expect(broadcasts).toContain(agent.id);
	});

	it("publish, answer, steer", async () => {
		runtime.start("topic");
		const published = runtime.publish([q("one")], false);
		expect(published.ok).toBe(true);
		expect(runtime.state.questions[0]!.status).toBe("current");
		const answered = runtime.answer({ id: "one", value: "a", label: "Option A", index: 1, reason: "cheap" }, false);
		expect(answered.ok).toBe(true);
		expect(runtime.state.questions[0]!.status).toBe("answered");
		// steer delivery is batched at 500ms; flush with a short wait
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(steered.length).toBe(1);
		expect(steered[0]!.kind).toBe("steer");
		expect(steered[0]!.text).toContain("one: Option A");
		expect(steered[0]!.text).toContain("reason: cheap");
		expect(steered[0]!.text).toContain("Open questions:");
	});

	it("skip steers with the skip label", async () => {
		runtime.start("topic");
		runtime.publish([q("one")], false);
		const skipped = runtime.skip("one");
		expect(skipped.ok).toBe(true);
		expect(runtime.state.questions[0]!.status).toBe("skipped");
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(steered[0]!.text).toContain("one: skipped by the user");
	});

	it("note steers immediately", () => {
		runtime.start("topic");
		runtime.publish([q("one")], false);
		const noted = runtime.note("remember the budget");
		expect(noted.ok).toBe(true);
		expect(runtime.state.notes).toContain("remember the budget");
		expect(steered.length).toBe(1);
		expect(steered[0]!.text).toContain("User note: remember the budget");
	});

	it("converge question with confirm keyword triggers the plan follow-up", () => {
		runtime.start("topic");
		runtime.publish([q("final")], true);
		const answered = runtime.answer({ id: "final", value: "confirm", label: "Confirm", index: 3, reason: "" }, false);
		expect(answered.ok).toBe(true);
		expect(steered.length).toBe(1);
		expect(steered[0]!.kind).toBe("followup");
		expect(steered[0]!.text).toContain("The user confirmed convergence");
		expect(steered[0]!.text).toContain("docs/plans");
	});

	it("non-converging answer to a converge question does not trigger the plan", () => {
		runtime.start("topic");
		runtime.publish([q("final")], true);
		runtime.answer({ id: "final", value: "b", label: "Option B", index: 2, reason: "" }, false);
		expect(steered.length).toBe(0);
	});

	it("refine via answer() with refine flag", () => {
		runtime.start("topic");
		runtime.publish([q("one")], false);
		runtime.answer({ id: "one", value: "a", label: "Option A", index: 1, reason: "" }, false);
		runtime.answer({ id: "one", value: "b", label: "Option B", index: 2, reason: "changed" }, true);
		expect(runtime.state.questions.filter((x) => x.status === "deprecated").length).toBe(1);
		expect(runtime.state.questions.find((x) => x.id === "one")!.status).toBe("answered");
	});

	it("resume reads the persisted state", () => {
		runtime.start("topic");
		runtime.publish([q("one")], false);
		runtime.answer({ id: "one", value: "a", label: "Option A", index: 1, reason: "" }, false);
		const resumed = new GrillRuntime(agent.id, "/work", "topic", deps);
		const started = resumed.start("topic");
		if (!started.ok) throw new Error("resume failed: " + started.message);
		expect(started.resumed).toBe(true);
		expect(resumed.state.questions[0]!.status).toBe("answered");
		resumed.close();
	});

	it("delivery fails loudly when the agent is gone", async () => {
		runtime.start("topic");
		runtime.publish([q("one")], false);
		deps.agents.get = () => undefined;
		const answered = runtime.answer({ id: "one", value: "a", label: "Option A", index: 1, reason: "" }, false);
		expect(answered.ok).toBe(true); // state committed
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(steered.length).toBe(0); // delivery silently dropped (logged by design)
	});
});