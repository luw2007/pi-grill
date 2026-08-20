/**
 * Pure ledger grouping for the answer-audit view: split refine chains
 * (`<id>#N` deprecated rows produced by a re-answer) away from the visible
 * ledger list and index them by their parent question id, oldest first.
 * Agent-deprecated single rows (no #N suffix, or no live parent) are left
 * untouched in the visible list.
 * @module dsh-grill/client/ledger-groups
 */

import type { GrillQuestionView } from "./port.ts";

export type LedgerGroups = {
	/** The ledger's primary rows, with refine-chain history rows removed. */
	visible: GrillQuestionView[];
	/** Parent question id -> its refine history, oldest (#1) first. */
	historyByParentId: Record<string, GrillQuestionView[]>;
};

const CHAIN_SUFFIX = /#(\d+)$/;

/**
 * Group refine-chain history rows under their parent question.
 * @param questions - the session's full question list, in ledger order.
 * @returns the visible ledger rows plus a parent-id -> history index.
 */
export function groupLedgerHistory(questions: readonly GrillQuestionView[]): LedgerGroups {
	const byId = new Map(questions.map((question) => [question.id, question]));
	const historyByParentId: Record<string, GrillQuestionView[]> = {};
	const historyIds = new Set<string>();
	for (const question of questions) {
		const match = CHAIN_SUFFIX.exec(question.id);
		if (!match) continue;
		const parentId = question.id.slice(0, match.index);
		if (!byId.has(parentId)) continue; // no live parent: an agent-deprecated single row, not a chain
		historyIds.add(question.id);
		(historyByParentId[parentId] ??= []).push(question);
	}
	for (const history of Object.values(historyByParentId)) {
		history.sort((left, right) => chainIndex(left.id) - chainIndex(right.id));
	}
	const visible = questions.filter((question) => !historyIds.has(question.id));
	return { visible, historyByParentId };
}

function chainIndex(id: string): number {
	const match = CHAIN_SUFFIX.exec(id);
	return match ? Number(match[1]) : 0;
}