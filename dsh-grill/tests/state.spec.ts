import { describe, expect, it } from "vitest";
import {
	addQuestions,
	applyAnswerBatch,
	applyNote,
	applyRefineAnswer,
	applySkip,
	canConverge,
	consumeConvergenceAnswer,
	defaultGrillConfig,
	deprecateQuestions,
	deriveSectionIndex,
	derivedState,
	getLedgerRows,
	initialState,
	migrateState,
	normalizeSection,
	removeQuestions,
	stateSummary,
	validateState,
	type AskQuestion,
	type GrillState,
} from "../src/state.ts";

const q = (id: string, section = "Scope", question = "Q " + id): AskQuestion => ({
	id,
	section,
	question,
	options: [
		{ value: "a", label: "Option A", recommended: true, recommendationReason: "cheap" },
		{ value: "b", label: "Option B", description: "the other one" },
	],
	recommended: "a",
	recommendationReason: "cheap",
});

const base = (): GrillState => initialState("topic", "/work");

describe("state machine", () => {
	it("publishes a batch with the first question current", () => {
		const state = addQuestions(base(), [q("one"), q("two")]);
		expect(state.questions.map((x) => [x.id, x.status])).toEqual([
			["one", "current"],
			["two", "pending"],
		]);
		expect(state.currentQuestionId).toBe("one");
		expect(validateState(state)).toBeUndefined();
	});

	it("a new batch supersedes the previous current question", () => {
		let state = addQuestions(base(), [q("one")]);
		state = addQuestions(state, [q("two")]);
		const one = state.questions.find((x) => x.id === "one")!;
		expect(one.status).toBe("pending");
		expect(one.statusNote).toContain("superseded");
		expect(state.currentQuestionId).toBe("two");
	});

	it("rejects duplicate ids and invalid shapes", () => {
		expect(() => addQuestions(base(), [q("dup"), q("dup")])).toThrow(/duplicate/);
		const bad = q("bad");
		bad.options = [{ value: "x", label: "" }];
		expect(() => addQuestions(base(), [bad])).toThrow(/empty option/);
		const dupOptions = q("dupOpt");
		dupOptions.options = [{ value: "x", label: "X" }, { value: "x", label: "Y" }];
		expect(() => addQuestions(base(), [dupOptions])).toThrow(/duplicate option values/);
	});

	it("answers a question and pins it", () => {
		let state = addQuestions(base(), [q("one")]);
		state = applyAnswerBatch(state, [{ id: "one", value: "a", label: "Option A", index: 1, reason: "because" }]);
		const one = state.questions.find((x) => x.id === "one")!;
		expect(one.status).toBe("answered");
		expect(one.userChoice).toBe("Option A");
		expect(one.reason).toBe("because");
		expect(one.pinned?.question).toBe("Q one");
		expect(state.answeredCount).toBe(1);
		expect(state.currentQuestionId).toBeNull();
		expect(validateState(state)).toBeUndefined();
	});

	it("refine keeps the old answer as deprecated", () => {
		let state = addQuestions(base(), [q("one")]);
		state = applyAnswerBatch(state, [{ id: "one", value: "a", label: "Option A", index: 1, reason: "" }]);
		state = applyRefineAnswer(state, { id: "one", value: "b", label: "Option B", index: 2, reason: "changed my mind" });
		const one = state.questions.find((x) => x.id === "one")!;
		expect(one.status).toBe("answered");
		expect(one.userChoice).toBe("Option B");
		expect(one.pinned).toBeDefined();
		const deprecated = state.questions.find((x) => x.status === "deprecated")!;
		expect(deprecated.userChoice).toBe("Option A");
		expect(deprecated.id).toBe("one#1");
		expect(deprecated.statusNote).toContain("re-answer");
		expect(state.questions.length).toBe(2);
		expect(validateState(state)).toBeUndefined();
	});

	it("skip and note transitions", () => {
		let state = addQuestions(base(), [q("one")]);
		state = applySkip(state, "one");
		expect(state.questions[0]!.status).toBe("skipped");
		state = applyNote(state, "  remember this  ");
		expect(state.notes).toEqual(["remember this"]);
		expect(validateState(state)).toBeUndefined();
	});

	it("agent deprecate/remove", () => {
		let state = addQuestions(base(), [q("one"), q("two")]);
		state = applyAnswerBatch(state, [{ id: "one", value: "a", label: "Option A", index: 1, reason: "" }]);
		state = deprecateQuestions(state, ["one"]);
		expect(state.questions[0]!.status).toBe("deprecated");
		state = removeQuestions(state, ["two"]);
		expect(state.questions[1]!.status).toBe("removed");
		expect(validateState(state)).toBeUndefined();
	});

	it("convergence is dependency-driven", () => {
		let state = addQuestions(base(), [q("one")]);
		expect(canConverge(state)).toBe(false);
		state = applySkip(state, "one");
		expect(canConverge(state)).toBe(true);
	});

	it("consumeConvergenceAnswer matches keywords", () => {
		const pending = new Set(["final"]);
		expect(consumeConvergenceAnswer(pending, { id: "final", value: "confirm", label: "Confirm", index: 1, reason: "" }, true, ["confirm", "yes"])).toBe(true);
		expect(consumeConvergenceAnswer(pending, { id: "final", value: "later", label: "Later", index: 2, reason: "" }, true, ["confirm", "yes"])).toBe(false);
		expect(consumeConvergenceAnswer(pending, { id: "final", value: "confirm", label: "Confirm", index: 1, reason: "" }, false, ["confirm"])).toBe(false);
	});

	it("ledger rows and section index", () => {
		let state = addQuestions(base(), [q("one"), q("two", "Design")]);
		state = applyAnswerBatch(state, [{ id: "one", value: "a", label: "Option A", index: 1, reason: "" }]);
		const rows = getLedgerRows(state);
		expect(rows.find((r) => r.id === "one")!.answerable).toBe(true);
		expect(rows.find((r) => r.id === "one")!.choice).toBe("Option A");
		const index = deriveSectionIndex(state);
		expect(Object.keys(index).sort()).toEqual(["Design", "Scope"]);
		expect(stateSummary(state)).toContain("Section index");
	});

	it("migrateState round-trips persisted state", () => {
		let state = addQuestions(base(), [q("one")]);
		state = applyAnswerBatch(state, [{ id: "one", value: "a", label: "Option A", index: 1, reason: "" }]);
		state = derivedState(state);
		const restored = migrateState(JSON.parse(JSON.stringify(state)));
		expect(restored.questions[0]!.status).toBe("answered");
		expect(validateState(restored)).toBeUndefined();
		expect(() => migrateState({ schemaVersion: 3 })).toThrow(/schemaVersion/);
	});

	it("normalizeSection strips control characters", () => {
		expect(normalizeSection("  Scope\t\n  ")).toBe("Scope");
	});

	it("config defaults", () => {
		const config = defaultGrillConfig();
		expect(config.directory).toBe(".dsh-grill");
		expect(config.convergeKeywords).toContain("确认");
	});
});