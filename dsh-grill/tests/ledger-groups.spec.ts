import { describe, expect, it } from "vitest";
import { groupLedgerHistory } from "../src/client/ledger-groups.ts";
import type { GrillQuestionView } from "../src/client/port.ts";

function q(id: string, status: GrillQuestionView["status"], userChoice?: string): GrillQuestionView {
	return {
		id,
		section: "Scope",
		status,
		question: "Q " + id,
		options: [{ value: "a", label: "Option A" }],
		userChoice,
	};
}

describe("groupLedgerHistory", () => {
	it("passes through questions with no refine chain unchanged", () => {
		const questions = [q("one", "answered", "A"), q("two", "pending")];
		const { visible, historyByParentId } = groupLedgerHistory(questions);
		expect(visible).toEqual(questions);
		expect(historyByParentId).toEqual({});
	});

	it("removes #N chain rows from visible and indexes them by parent, oldest first", () => {
		const questions = [
			q("one#2", "deprecated", "C"),
			q("one", "answered", "D"),
			q("one#1", "deprecated", "B"),
			q("two", "pending"),
		];
		const { visible, historyByParentId } = groupLedgerHistory(questions);
		expect(visible.map((x) => x.id)).toEqual(["one", "two"]);
		expect(historyByParentId["one"]!.map((x) => x.id)).toEqual(["one#1", "one#2"]);
		expect(historyByParentId["two"]).toBeUndefined();
	});

	it("leaves an agent-deprecated single row visible when it has no live parent", () => {
		const questions = [q("orphan", "deprecated", "X"), q("two", "pending")];
		const { visible, historyByParentId } = groupLedgerHistory(questions);
		expect(visible.map((x) => x.id)).toEqual(["orphan", "two"]);
		expect(historyByParentId).toEqual({});
	});

	it("id containing a literal # with no live parent is not treated as a chain row", () => {
		const questions = [q("weird#9", "deprecated", "X")];
		const { visible, historyByParentId } = groupLedgerHistory(questions);
		expect(visible.map((x) => x.id)).toEqual(["weird#9"]);
		expect(historyByParentId).toEqual({});
	});

	it("handles a mix of chained and orphaned deprecated rows together", () => {
		const questions = [
			q("a", "answered", "A2"),
			q("a#1", "deprecated", "A1"),
			q("b", "deprecated", "B"), // agent-deprecated, no chain
		];
		const { visible, historyByParentId } = groupLedgerHistory(questions);
		expect(visible.map((x) => x.id)).toEqual(["a", "b"]);
		expect(historyByParentId["a"]!.map((x) => x.id)).toEqual(["a#1"]);
	});
});