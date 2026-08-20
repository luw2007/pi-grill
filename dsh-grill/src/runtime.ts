/**
 * One live interview runtime: owns the state machine, persistence, answer
 * batching, steer delivery and convergence handling for a single agent.
 * @module dsh-grill/runtime
 */

import { existsSync } from "node:fs";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
	applyAnswerBatch,
	applyNote,
	applyRefineAnswer,
	applySkip,
	canConverge,
	consumeConvergenceAnswer,
	derivedState,
	incrementalSummary,
	initialState,
	stateSummary,
	validateState,
	type AskAnswer,
	type AskQuestion,
	type GrillConfig,
	type GrillState,
} from "./state.ts";
import { buildInterviewPrompt, planPrompt } from "./prompts.ts";
import { readJsonState, sessionPaths, writeAtomic, type SessionPaths } from "./persist.ts";
import {
	addQuestions as addQuestionsLocal,
	deprecateQuestions as deprecateLocal,
	removeQuestions as removeLocal,
} from "./state.ts";

export type AgentsService = { get(id: string): Agent | undefined };

export type GrillRuntimeDeps = {
	agents: AgentsService;
	config: GrillConfig;
	logger: { warn(message: string): void };
	/** Notify every connected web panel that this session changed. */
	broadcast: (sessionId: string) => void;
};

export type GrillActionResult = { ok: true } | { ok: false; message: string };

const ANSWER_BATCH_MS = 500;

export class GrillRuntime {
	readonly agentId: string;
	readonly cwd: string;
	readonly paths: SessionPaths;
	state: GrillState;
	readonly pendingConvergenceQuestionIds = new Set<string>();

	private readonly deps: GrillRuntimeDeps;
	private answerQueue: AskAnswer[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private started = false;

	constructor(agentId: string, cwd: string, content: string, deps: GrillRuntimeDeps, existing?: GrillState) {
		this.agentId = agentId;
		this.cwd = cwd;
		this.deps = deps;
		this.paths = sessionPaths(cwd, content, deps.config.directory);
		this.state = existing ?? initialState(content, cwd);
	}

	get isStarted(): boolean {
		return this.started;
	}

	/** The JSON path, exposed to model-facing results and prompts. */
	get statePath(): string {
		return this.paths.json;
	}

	private liveAgent(): Agent | undefined {
		return this.deps.agents.get(this.agentId);
	}

	private persist(next: GrillState, atomicAnswerIds: ReadonlySet<string> = new Set()): string | undefined {
		const error = validateState(next, this.state, atomicAnswerIds);
		if (error) return error;
		writeAtomic(this.paths.json, JSON.stringify(next, null, 2) + "\n");
		this.state = next;
		this.deps.broadcast(this.agentId);
		return undefined;
	}

	/** Start or resume from disk; returns a user-facing status line. */
	start(content: string): { ok: true; resumed: boolean } | { ok: false; message: string } {
		if (this.started) return { ok: false, message: "interview already started" };
		let state: GrillState;
		let resumed = false;
		if (existsSync(this.paths.json)) {
			try {
				state = readJsonState(this.paths.json);
				resumed = true;
			} catch (error) {
				return { ok: false, message: "existing grill JSON could not be restored: " + (error instanceof Error ? error.message : String(error)) + "; delete or repair the state file, then start again" };
			}
		} else {
			state = initialState(content, this.cwd);
		}
		const next = derivedState(state);
		const error = validateState(next);
		if (error) return { ok: false, message: error };
		writeAtomic(this.paths.json, JSON.stringify(next, null, 2) + "\n");
		this.state = next;
		this.started = true;
		this.deps.broadcast(this.agentId);
		return { ok: true, resumed };
	}

	/** The /grill interview brief, sent as a follow-up turn. */
	interviewPrompt(): string {
		return buildInterviewPrompt({
			content: this.state.content,
			statePath: this.paths.json,
			state: this.state,
		});
	}

	/** Publish a question batch (grill_ask); the first question becomes current. */
	publish(questions: AskQuestion[], converge: boolean): { ok: true; published: string[] } | { ok: false; message: string } {
		if (!this.started) return { ok: false, message: "no active /grill session; start one with /grill <topic>" };
		try {
			const next = addQuestionsLocal(this.state, questions);
			const error = this.persist(next);
			if (error) return { ok: false, message: error };
			if (converge) for (const question of questions) this.pendingConvergenceQuestionIds.add(question.id);
			return { ok: true, published: questions.map((question) => question.id) };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Agent-side deprecate/remove of published questions. */
	deprecate(ids: readonly string[]): GrillActionResult {
		if (!this.started) return { ok: false, message: "no active /grill session" };
		try {
			const next = deprecateLocal(this.state, ids);
			const error = this.persist(next);
			if (error) return { ok: false, message: error };
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	remove(ids: readonly string[]): GrillActionResult {
		if (!this.started) return { ok: false, message: "no active /grill session" };
		try {
			const next = removeLocal(this.state, ids);
			const error = this.persist(next);
			if (error) return { ok: false, message: error };
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** User answer from the web panel; refine=true preserves the old answer as deprecated. */
	answer(answer: AskAnswer, refine: boolean): GrillActionResult {
		if (!this.started) return { ok: false, message: "no active /grill session" };
		try {
			const next = refine ? applyRefineAnswer(this.state, answer) : applyAnswerBatch(this.state, [answer]);
			const error = this.persist(next, new Set([answer.id]));
			if (error) return { ok: false, message: error };
			this.enqueueAnswer(answer, "answered");
			this.maybeConverge(answer);
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** User skip from the web panel. */
	skip(id: string): GrillActionResult {
		if (!this.started) return { ok: false, message: "no active /grill session" };
		try {
			const next = applySkip(this.state, id);
			const error = this.persist(next);
			if (error) return { ok: false, message: error };
			this.pendingConvergenceQuestionIds.delete(id);
			this.enqueueAnswer({ id, value: "__skipped__", label: "skipped by the user", index: 0, reason: "" }, "skipped");
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Free-form user note from the web panel. */
	note(text: string): GrillActionResult {
		if (!this.started) return { ok: false, message: "no active /grill session" };
		try {
			const next = applyNote(this.state, text);
			const error = this.persist(next);
			if (error) return { ok: false, message: error };
			const latest = next.notes[next.notes.length - 1] ?? text.trim();
			const delivery = this.deliver("User note: " + latest + "\n\n" + incrementalSummary(next, this.paths.json));
			if (!delivery.ok) this.deps.logger.warn("grill: " + delivery.message);
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Steer one message into the agent loop; empty agent => failure. */
	private deliver(content: string): GrillActionResult {
		const agent = this.liveAgent();
		if (!agent) return { ok: false, message: "agent is no longer live; the answer was saved but not delivered" };
		try {
			const message = createUserMessage({
				content: [{ type: "text", text: content }],
				source: { kind: "plugin", plugin: "grill" },
			});
			agent.steer(message);
			return { ok: true };
		} catch (error) {
			return { ok: false, message: "delivery failed: " + (error instanceof Error ? error.message : String(error)) };
		}
	}

	private enqueueAnswer(answer: AskAnswer, status: string): void {
		void status;
		this.answerQueue.push(answer);
		if (this.flushTimer === undefined) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = undefined;
				this.flushAnswers();
			}, ANSWER_BATCH_MS);
		}
	}

	private flushAnswers(): void {
		if (this.answerQueue.length === 0) return;
		const answers = this.answerQueue;
		this.answerQueue = [];
		const content = answers.map((answer) => answer.id + ": " + answer.label + (answer.reason ? " (reason: " + answer.reason + ")" : "")).join("\n")
			+ "\n\n" + incrementalSummary(this.state, this.paths.json);
		const delivery = this.deliver(content);
		if (!delivery.ok) this.deps.logger.warn("grill: " + delivery.message);
	}

	/** An answer to a converge question carrying a confirm keyword confirms convergence. */
	private maybeConverge(answer: AskAnswer): void {
		if (!consumeConvergenceAnswer(this.pendingConvergenceQuestionIds, answer, canConverge(this.state), this.deps.config.convergeKeywords)) return;
		const agent = this.liveAgent();
		if (!agent) return;
		try {
			const message = createUserMessage({
				content: [{ type: "text", text: planPrompt(this.paths.json, this.cwd) }],
				source: { kind: "plugin", plugin: "grill" },
			});
			// Always followUp: an idle check races the agent starting a run; followUp runs
			// immediately when idle and queues when streaming (same reasoning as pi-grill).
			agent.followup(message);
		} catch (error) {
			this.deps.logger.warn("grill: plan prompt delivery failed: " + (error instanceof Error ? error.message : String(error)));
		}
	}

	/** Current model-facing summary; also the tool result text. */
	summary(): string {
		return stateSummary(this.state);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.answerQueue = [];
	}
}

// Local re-imports keep the top import block short and the module boundary explicit.

import { buildInterviewPrompt as buildInterviewPromptLocal } from "./prompts.ts";