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
	deriveSectionIndex,
	normalizeSection,
	getLedgerRows,
	joinRenderedColumns,
	migrateState,
	normalizeOptionViewport,
	normalizeUiState,
	parseGrillConfig,
	parseGrillConfigText,
	resolveGrillConfig,
	runConvergenceConfirmation,
	validateAnswerBatchTransition,
	validateState,
	canConverge,
	type GrillState,
} from "../grill.ts";

function v4Fixture(): GrillState {
	return JSON.parse(readFileSync(new URL("./fixtures/grill-state.json", import.meta.url), "utf8")) as GrillState;
}

describe("schema v4 incompatible state", () => {
	test("accepts valid v4 state without changing interview facts", () => {
		const source = v4Fixture();
		expect(migrateState(source)).toEqual(source);
	});

	test("rejects older schemas, unknown versions, and missing required fields with repair guidance", () => {
		for (const schemaVersion of [1, 2, 3, 99]) {
			expect(() => migrateState({ ...v4Fixture(), schemaVersion })).toThrow("delete or repair the state file");
		}
		const missing = v4Fixture() as any;
		delete missing.ui.optionScrollOffsetByQuestion;
		expect(() => migrateState(missing)).toThrow("$.ui.optionScrollOffsetByQuestion");
		const noNotes = v4Fixture() as any;
		delete noNotes.notes;
		expect(() => migrateState(noNotes)).toThrow("$.notes");
	});
});

describe("UI state normalization", () => {
	test("repairs missing selection and clamps indices and scroll offset", () => {
		const state = migrateState(v4Fixture()) as GrillState;
		state.ui = {
			focusedPane: "answer",
			selectedQuestionId: "missing",
			selectedOptionByQuestion: { Q1: 99, Q2: -2, stale: 3 },
			optionScrollOffsetByQuestion: { Q1: 99, Q2: -2, stale: 3 },
			listScrollOffset: 99,
			activeSurface: "question",
			revision: 4,
		};

		expect(normalizeUiState(state)).toEqual({
			focusedPane: "answer",
			selectedQuestionId: "Q1",
			selectedOptionByQuestion: { Q1: 2, Q2: 0 },
			optionScrollOffsetByQuestion: { Q1: 0, Q2: 0 },
			listScrollOffset: 9,
			activeSurface: "question",
			revision: 4,
		});
	});

	test("preserves submit surface with no selected question", () => {
		const state = migrateState(v4Fixture()) as GrillState;
		state.ui.activeSurface = "submit";
		state.ui.selectedQuestionId = null;
		expect(normalizeUiState(state).selectedQuestionId).toBeNull();
	});
});

describe("option viewport and config", () => {
	test("keeps selection visible and clamps offset across shrinking option lists", () => {
		expect(normalizeOptionViewport(0, 9, 10, 8, true)).toEqual({ selectedIndex: 0, offset: 0 });
		expect(normalizeOptionViewport(8, 0, 10, 8, true)).toEqual({ selectedIndex: 8, offset: 1 });
		expect(normalizeOptionViewport(9, 2, 4, 8, false)).toEqual({ selectedIndex: 3, offset: 0 });
	});

	test("uses a configurable valid toggle shortcut and rejects invalid formats", () => {
		expect(parseGrillConfig(undefined).toggleShortcut).toBe("ctrl+alt+g");
		expect(parseGrillConfig({ toggleShortcut: "alt+f8" }).toggleShortcut).toBe("alt+f8");
		for (const toggleShortcut of ["", "ctrl+ctrl+g", "meta+g", "ctrl+unknown", "ctrl+shift"]) {
			expect(() => parseGrillConfig({ toggleShortcut })).toThrow("toggleShortcut");
		}
	});

	test("uses default values and rejects unsafe thresholds", () => {
		const defaults = parseGrillConfig(undefined);
		expect(defaults.convergeKeywords).toEqual(["confirm", "converge", "yes", "确认", "生成"]);
		expect(defaults.optionScrollThreshold).toBe(8);
		expect(parseGrillConfig({ optionScrollThreshold: 12 }).optionScrollThreshold).toBe(12);
		expect(() => parseGrillConfigText("{")).toThrow();
		const notifications: string[] = [];
		expect(resolveGrillConfig("{", (message) => notifications.push(message)).optionScrollThreshold).toBe(8);
		expect(notifications).toHaveLength(1);
		for (const value of [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER]) {
			expect(() => parseGrillConfig({ optionScrollThreshold: value })).toThrow("optionScrollThreshold");
		}
	});
});

describe("atomic answer batches", () => {
	test("does not mutate or partially answer when a later answer is invalid", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		const before = structuredClone(source);
		expect(() => applyAnswerBatch(source, [
			{ id: "Q1", value: "A", label: "Option one", index: 1, reason: "first" },
			{ id: "missing", value: "yes", label: "Yes", index: 1, reason: "second" },
		])).toThrow("question not found: missing");
		expect(source).toEqual(before);
		expect(source.questions[0]?.status).toBe("current");
	});

	test("answers the whole batch in one derived state", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		const next = applyAnswerBatch(source, [
			{ id: "Q1", value: "A", label: "Option one", index: 1, reason: "first" },
			{ id: "Q2", value: "yes", label: "Yes", index: 1, reason: "" },
		]);
		expect(next.questions.slice(0, 2).map((question) => question.status)).toEqual(["answered", "answered"]);
		const index = deriveSectionIndex(next);
		expect(index["1. Background"]).toContainEqual({ id: "Q1", status: "answered" });
		expect(index["2. Goals"]).toContainEqual({ id: "Q2", status: "answered" });
		expect(validateAnswerBatchTransition(next, source, ["Q1", "Q2"])).toBeUndefined();
		expect(source.questions.slice(0, 2).map((question) => question.status)).toEqual(["current", "pending"]);
	});

	test("commits current + pending answers with exactly one write", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		const writes: GrillState[] = [];
		const next = commitAnswerBatch(source, [
			{ id: "Q1", value: "A", label: "Option one", index: 1, reason: "" },
			{ id: "Q2", value: "yes", label: "Yes", index: 1, reason: "" },
		], { write: (state) => writes.push(structuredClone(state)) });
		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual(next);
		expect(next.questions.slice(0, 2).map((question) => question.status)).toEqual(["answered", "answered"]);
	});

	test("overwrites an answered choice in place; section index stays a ledger map", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		const answered = source.questions.find((question) => question.id === "Q3")!;
		answered.section = "1. Background";
		const writes: GrillState[] = [];
		const next = commitAnswerBatch(source, [
			{ id: "Q3", value: "new", label: "New", index: 2, reason: "latest" },
		], { write: (state) => writes.push(structuredClone(state)) });
		expect(writes).toHaveLength(1);
		expect(next.questions.find((question) => question.id === "Q3")?.userChoice).toBe("New");
		const index = deriveSectionIndex(next);
		expect(index["1. Background"]).toContainEqual({ id: "Q3", status: "answered" });
		expect(JSON.stringify(index)).not.toContain("New");
		expect(validateAnswerBatchTransition(next, source, ["Q3"])).toBeUndefined();
	});

	test("indexes free-form sections in ledger order and normalizes section text", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		source.questions[0].section = "Custom Track";
		source.questions[1].section = "Custom Track";
		const index = deriveSectionIndex(source);
		expect(index["Custom Track"].map((entry) => entry.id)).toEqual(["Q1", "Q2"]);
		expect(normalizeSection("  custom\tgroup ")).toBe("custom group");
	});

	test("keeps deprecated and removed questions read-only", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		for (const id of ["Q4", "Q5"]) {
			expect(() => applyAnswerBatch(source, [
				{ id, value: "new", label: "New", index: 1, reason: "" },
			])).toThrow("can no longer be answered");
		}
	});

	test("rejects pending → answered outside the declared batch", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		const next = applyAnswerBatch(source, [
			{ id: "Q2", value: "yes", label: "Yes", index: 1, reason: "" },
		]);
		expect(validateAnswerBatchTransition(next, source, ["Q1"])).toContain("pending -> answered");
	});
});

describe("asynchronous panel model", () => {
	test("uses the complete ledger and marks terminal rows read-only", () => {
		const state = migrateState(v4Fixture()) as GrillState;
		const rows = getLedgerRows(state);
		expect(rows).toHaveLength(state.questions.length);
		expect(rows.map((row) => row.id)).toEqual(state.questions.map((question) => question.id));
		expect(rows.find((row) => row.id === "Q1")?.answerable).toBe(true);
		expect(rows.find((row) => row.id === "Q3")?.answerable).toBe(true);
		expect(rows.find((row) => row.id === "Q4")?.answerable).toBe(false);
		expect(rows.find((row) => row.id === "Q5")?.answerable).toBe(false);
	});

	test("selects an existing editable answer, then recommendation, then first; custom answers map to virtual other", () => {
		const state = migrateState(v4Fixture()) as GrillState;
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

	test("matches convergence only for published converge questions and keeps them re-triggerable", () => {
		const pending = new Set(["Q1"]);
		const answer = { id: "Q1", value: "yes", label: "Yes", index: 1, reason: "" };
		expect(consumeConvergenceAnswer(pending, answer, true, ["yes"])).toBe(true);
		expect(pending.has("Q1")).toBe(true);
		expect(consumeConvergenceAnswer(pending, { ...answer, label: "Not yet", value: "later" }, true, ["yes"])).toBe(false);
		expect(pending.has("Q1")).toBe(true);
		expect(consumeConvergenceAnswer(pending, answer, false, ["yes"])).toBe(false);
		expect(consumeConvergenceAnswer(pending, answer, true, ["yes"])).toBe(true);
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
		const left = ["Question one", "\u001b[32mQ2\u001b[0m", "👩‍💻 e\u0301"];
		const right = ["右侧内容 CJK", "second line", "x".repeat(100), "third"];
		const lines = joinRenderedColumns(left, right, 12, 20, 3);
		expect(lines).toHaveLength(4);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(35);
	});

	test("stays within tiny width allocations", () => {
		for (const width of [0, 1, 2, 8]) {
			const lines = joinRenderedColumns(["宽字符测试"], ["answer"], width, width, 0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width * 2);
		}
	});
});

describe("dependency-driven interview mechanics", () => {
	test("rejects empty, overlong, and unnormalized sections but accepts free-form labels", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		const withSection = (section: string) => {
			const next = structuredClone(source);
			next.questions[0].section = section;
			return next;
		};

		expect(validateState(withSection("any custom group"))).toBeUndefined();
		expect(validateState(withSection("  "))).toContain("empty section");
		expect(validateState(withSection(" padded "))).toContain("normalized");
		expect(validateState(withSection("x".repeat(121)))).toContain("exceeds");
	});

	test("converges on open questions alone, regardless of section coverage", () => {
		const source = migrateState(v4Fixture()) as GrillState;
		expect(canConverge(source)).toBe(false);

		const closed = structuredClone(source);
		for (const question of closed.questions) {
			if (question.status === "pending" || question.status === "current") {
				question.status = "removed";
				question.statusNote = "closed for test";
			}
			question.section = "single group";
		}
		expect(canConverge(closed)).toBe(true);
		expect(Object.keys(deriveSectionIndex(closed))).toEqual(["single group"]);
	});
});
