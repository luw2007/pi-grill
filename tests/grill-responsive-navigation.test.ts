import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	applyAnswerBatch,
	chooseResponsiveLayout,
	getInitialOptionIndex,
	commitAnswerBatch,
	consumeConvergenceAnswer,
	createAnswerEventBatcher,
	deriveSections,
	getLedgerRows,
	joinRenderedColumns,
	migrateState,
	normalizeUiState,
	runConvergenceConfirmation,
	validateAnswerBatchTransition,
	type GrillState,
} from "/Users/luwei.will/.pi/agent/extensions/grill.ts";

function v1Fixture() {
	return JSON.parse(readFileSync(new URL("./fixtures/grill-v1.json", import.meta.url), "utf8"));
}

describe("v1 → v2 migration", () => {
	test("adds recoverable UI state without changing interview facts", () => {
		const source = v1Fixture();
		const migrated = migrateState(source) as GrillState;

		expect(migrated.schemaVersion).toBe(2);
		expect(migrated.ui).toEqual({
			focusedPane: "questions",
			selectedQuestionId: "Q1",
			selectedOptionByQuestion: {},
			listScrollOffset: 0,
			activeSurface: "question",
			revision: 0,
		});
		expect(migrated.questions).toEqual(source.questions);
		expect(migrated).not.toHaveProperty("sections");
		expect(migrated.createdAt).toBe(source.createdAt);
	});

	test("is idempotent for valid v2 state", () => {
		const first = migrateState(v1Fixture()) as GrillState;
		expect(migrateState(first)).toEqual(first);
	});

	test("rejects unsupported schema versions", () => {
		expect(() => migrateState({ ...v1Fixture(), schemaVersion: 99 })).toThrow("schemaVersion");
	});
});

describe("UI state normalization", () => {
	test("repairs missing selection and clamps indices and scroll offset", () => {
		const state = migrateState(v1Fixture()) as GrillState;
		state.ui = {
			focusedPane: "answer",
			selectedQuestionId: "missing",
			selectedOptionByQuestion: { Q1: 99, Q2: -2, stale: 3 },
			listScrollOffset: 99,
			activeSurface: "question",
			revision: 4,
		};

		expect(normalizeUiState(state)).toEqual({
			focusedPane: "answer",
			selectedQuestionId: "Q1",
			selectedOptionByQuestion: { Q1: 2, Q2: 0 },
			listScrollOffset: 9,
			activeSurface: "question",
			revision: 4,
		});
	});

	test("preserves submit surface with no selected question", () => {
		const state = migrateState(v1Fixture()) as GrillState;
		state.ui.activeSurface = "submit";
		state.ui.selectedQuestionId = null;
		expect(normalizeUiState(state).selectedQuestionId).toBeNull();
	});
});

describe("atomic answer batches", () => {
	test("does not mutate or partially answer when a later answer is invalid", () => {
		const source = migrateState(v1Fixture()) as GrillState;
		const before = structuredClone(source);
		expect(() => applyAnswerBatch(source, [
			{ id: "Q1", value: "A", label: "选项一", index: 1, reason: "first" },
			{ id: "missing", value: "yes", label: "Yes", index: 1, reason: "second" },
		])).toThrow("问题不存在：missing");
		expect(source).toEqual(before);
		expect(source.questions[0]?.status).toBe("current");
	});

	test("answers the whole batch in one derived state", () => {
		const source = migrateState(v1Fixture()) as GrillState;
		const next = applyAnswerBatch(source, [
			{ id: "Q1", value: "A", label: "选项一", index: 1, reason: "first" },
			{ id: "Q2", value: "yes", label: "Yes", index: 1, reason: "" },
		]);
		expect(next.questions.slice(0, 2).map((question) => question.status)).toEqual(["answered", "answered"]);
		const sections = deriveSections(next);
		expect(sections["① 背景与问题"]).toContain("选项一");
		expect(sections["② 目标与非目标"]).toContain("Yes");
		expect(validateAnswerBatchTransition(next, source, ["Q1", "Q2"])).toBeUndefined();
		expect(source.questions.slice(0, 2).map((question) => question.status)).toEqual(["current", "pending"]);
	});

	test("commits current + pending answers with exactly one write", () => {
		const source = migrateState(v1Fixture()) as GrillState;
		const writes: GrillState[] = [];
		const next = commitAnswerBatch(source, [
			{ id: "Q1", value: "A", label: "选项一", index: 1, reason: "" },
			{ id: "Q2", value: "yes", label: "Yes", index: 1, reason: "" },
		], { write: (state) => writes.push(structuredClone(state)) });
		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual(next);
		expect(next.questions.slice(0, 2).map((question) => question.status)).toEqual(["answered", "answered"]);
	});

	test("overwrites an answered choice in place; derived sections reflect only current answers", () => {
		const source = migrateState(v1Fixture()) as GrillState;
		const answered = source.questions.find((question) => question.id === "Q3")!;
		answered.section = "① 背景与问题";
		const writes: GrillState[] = [];
		const next = commitAnswerBatch(source, [
			{ id: "Q3", value: "new", label: "New", index: 2, reason: "latest" },
		], { write: (state) => writes.push(structuredClone(state)) });
		expect(writes).toHaveLength(1);
		expect(next.questions.find((question) => question.id === "Q3")?.userChoice).toBe("New");
		const sections = deriveSections(next);
		expect(sections["① 背景与问题"]).toContain("用户选择：New；理由：latest");
		expect(sections["① 背景与问题"]).not.toContain("Old");
		expect(validateAnswerBatchTransition(next, source, ["Q3"])).toBeUndefined();
	});

	test("keeps deprecated and removed questions read-only", () => {
		const source = migrateState(v1Fixture()) as GrillState;
		for (const id of ["Q4", "Q5"]) {
			expect(() => applyAnswerBatch(source, [
				{ id, value: "new", label: "New", index: 1, reason: "" },
			])).toThrow("已无法回答");
		}
	});

	test("rejects pending → answered outside the declared batch", () => {
		const source = migrateState(v1Fixture()) as GrillState;
		const next = applyAnswerBatch(source, [
			{ id: "Q2", value: "yes", label: "Yes", index: 1, reason: "" },
		]);
		expect(validateAnswerBatchTransition(next, source, ["Q1"])).toContain("pending -> answered");
	});
});

describe("asynchronous panel model", () => {
	test("uses the complete ledger and marks terminal rows read-only", () => {
		const state = migrateState(v1Fixture()) as GrillState;
		const rows = getLedgerRows(state);
		expect(rows).toHaveLength(state.questions.length);
		expect(rows.map((row) => row.id)).toEqual(state.questions.map((question) => question.id));
		expect(rows.find((row) => row.id === "Q1")?.answerable).toBe(true);
		expect(rows.find((row) => row.id === "Q3")?.answerable).toBe(true);
		expect(rows.find((row) => row.id === "Q4")?.answerable).toBe(false);
		expect(rows.find((row) => row.id === "Q5")?.answerable).toBe(false);
	});

	test("selects an existing editable answer, then recommendation, then first; custom answers map to virtual other", () => {
		const state = migrateState(v1Fixture()) as GrillState;
		const answered = state.questions.find((item) => item.id === "Q3")!;
		expect(getInitialOptionIndex(answered)).toBe(0);
		answered.userChoice = "custom prior answer";
		expect(getInitialOptionIndex(answered)).toBe(answered.options.length);
		const current = state.questions.find((item) => item.id === "Q1")!;
		current.recommended = current.options[1]!.value;
		expect(getInitialOptionIndex(current)).toBe(1);
		delete current.recommended;
		expect(getInitialOptionIndex(current)).toBe(0);
	});

	test("batches complete answers in stable order without sleeping", () => {
		type Event = { id: string; value: string; label: string; index: number; other?: boolean; reason: string; status?: string };
		let callback: (() => void) | undefined;
		const sent: Event[][] = [];
		const batcher = createAnswerEventBatcher<Event>({
			schedule: (flush) => { callback = flush; return 1; },
			cancel: () => {},
			send: (answers) => sent.push(answers),
		});
		const first = { id: "Q1", value: "A", label: "Alpha", index: 1, other: true, reason: "why", status: "answered" };
		const second = { id: "Q2", value: "B", label: "Beta", index: 2, reason: "", status: "answered" };
		batcher.enqueue(first);
		batcher.enqueue(second);
		expect(sent).toHaveLength(0);
		callback?.();
		expect(sent).toEqual([[first, second]]);
	});

	test("does not lose a re-entrant enqueue while flushing", () => {
		type Event = { id: string };
		const callbacks: Array<() => void> = [];
		const sent: Event[][] = [];
		let batcher: ReturnType<typeof createAnswerEventBatcher<Event>>;
		batcher = createAnswerEventBatcher<Event>({
			schedule: (flush) => { callbacks.push(flush); return callbacks.length; },
			cancel: () => {},
			send: (answers) => {
				sent.push(answers);
				if (answers[0]?.id === "Q1") batcher.enqueue({ id: "Q2" });
			},
		});
		batcher.enqueue({ id: "Q1" });
		callbacks.shift()?.();
		expect(sent).toEqual([[{ id: "Q1" }]]);
		callbacks.shift()?.();
		expect(sent).toEqual([[{ id: "Q1" }], [{ id: "Q2" }]]);
	});

	test("consumes convergence only for the associated published question", () => {
		const pending = new Set(["Q1"]);
		const answer = { id: "Q1", value: "yes", label: "Yes", index: 1, reason: "" };
		expect(consumeConvergenceAnswer(pending, answer, true, ["yes"])).toBe(true);
		expect(pending.size).toBe(0);
		expect(consumeConvergenceAnswer(pending, { ...answer, id: "Q-later" }, true, ["yes"])).toBe(false);
	});

	test("catches rejected convergence confirmation and notifies", async () => {
		const notifications: string[] = [];
		let refocused = false;
		await runConvergenceConfirmation({
			confirm: () => Promise.reject(new Error("dialog failed")),
			onConfirmed: () => { throw new Error("must not run"); },
			notify: (message) => notifications.push(message),
			refocus: () => { refocused = true; },
		});
		expect(notifications[0]).toContain("dialog failed");
		expect(refocused).toBe(true);
	});
});

describe("responsive layout", () => {
	test("uses content-driven required width and a hysteresis band", () => {
		const metrics = { listWidth: 28, answerMinWidth: 64, gap: 3 };
		expect(chooseResponsiveLayout(94, metrics, "stacked")).toBe("stacked");
		expect(chooseResponsiveLayout(99, metrics, "stacked")).toBe("columns");
		expect(chooseResponsiveLayout(94, metrics, "columns")).toBe("columns");
		expect(chooseResponsiveLayout(89, metrics, "columns")).toBe("stacked");
	});

	test("joins ANSI, CJK, emoji and long content without exceeding terminal width", () => {
		const left = ["问题一", "\u001b[32mQ2\u001b[0m", "👩‍💻 e\u0301"];
		const right = ["这是右侧内容", "second line", "x".repeat(100), "third"];
		const lines = joinRenderedColumns(left, right, 12, 20, 3);
		expect(lines).toHaveLength(4);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(35);
	});

	test("stays within tiny width allocations", () => {
		for (const width of [0, 1, 2, 8]) {
			const lines = joinRenderedColumns(["中文很长"], ["answer"], width, width, 0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width * 2);
		}
	});
});
