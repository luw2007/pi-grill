/**
 * Model-facing prompts: the /grill interview brief and the final plan brief,
 * ported from pi-grill with the pi/TUI-specific instructions replaced by the
 * DSH Web equivalents.
 * @module dsh-grill/prompts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GrillState } from "./state.ts";
import { stateSummary } from "./state.ts";

export type InterviewFacts = {
	content: string;
	statePath: string;
	state: GrillState;
};

export function buildInterviewPrompt(facts: InterviewFacts): string {
	return `You are running a /grill design interview inside the DeepSeek Harness web GUI.

Hard constraints:
- Initial idea: ${facts.content}
- Single source of truth (JSON): ${facts.statePath}
- Every grill_ask result carries the latest state summary (section index + open questions). Use it to continue; only read the full JSON when auditing deprecated/removed history or right before writing the plan.
- You may edit the JSON with the built-in write tool, but you must preserve schemaVersion, questions, notes, ui, and the status machine. \`ui\` is required recoverable UI state. The wording and options of answered questions are immutable. Invalid JSON is rejected by the extension.
- Always use grill_ask to ask the user; never substitute plain text for the interactive panel. Publish every decision whose dependencies are already resolved in one batch instead of waiting question by question.
- Ask dependency-first: look up facts yourself (codebase, files, tools) and only put real decisions to the user. Every question must carry a recommended option and the reasoning behind it. Ask downstream questions only after their upstream decision is settled.
- \`section\` is a free-form grouping label used only to index questions. Never ask a question just to fill a section or reach a question count, and never split one decision across several questions.
- Generate the final plan's body headings freely from substantive content. There is no fixed heading pool, required order, minimum section count, or N/A placeholders.
- If the environment offers reusable multi-agent or subagent capabilities, use them to check facts; otherwise verify synchronously before moving on.
- In the panel the user can skip a question (status becomes \`skipped\`; it does not block convergence and stays re-answerable), send a note that is not tied to any question, and re-answer an answered question (the old answer becomes \`deprecated\`). When you receive a skip, a note or a re-answer, decide whether to ask a better question or change direction instead of repeating the same one.
- Convergence is dependency-driven: once there are no pending/current questions and no unresolved dependencies, use grill_ask with converge=true to ask the final "write the plan?" question. Only write the plan with write/edit after the user confirms.
- The final "## Interview transcript" section is always required and must be the final level-2 heading.

${stateSummary(facts.state)}`;
}

export function planDirectory(cwd: string): string {
	const candidates = [path.join(cwd, "docs", "plans"), path.join(cwd, "plans")];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

export function planPrompt(statePath: string, cwd: string): string {
	return `The user confirmed convergence. Use the built-in write/edit tools to write the final plan.

JSON state source: ${statePath}
Target directory: ${planDirectory(cwd)} (first existing of docs/plans/ then plans/; create docs/plans/ if neither exists; do not write anywhere else)
File name: <project>-<YYYYMMDD>-<short-topic>.md
Choose the body's level-2 headings and their order freely from substantive content in the interview and verified repository facts. Do not use a fixed heading pool, require a minimum section count, add empty sections, or write N/A placeholders. Regardless of which body headings are chosen, always append a final "## Interview transcript" heading.
The transcript must preserve every question in the JSON \`questions\` array, including answered, skipped, deprecated and removed, recording at least id, status, question, options, recommendation, the user's choice, the reason and the status note. If \`notes\` is non-empty, list every user note at the end of the transcript. Do not omit, rewrite or fabricate anything. After writing, read the file back and confirm every question id is present, and confirm "## Interview transcript" is the final level-2 heading.`;
}