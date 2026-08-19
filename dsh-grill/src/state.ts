/**
 * Grill interview state machine, ported from pi-grill (grill.ts) with the TUI
 * stripped out and the Web panel as the only surface.
 *
 * The persisted JSON shape stays byte-compatible with pi-grill schema v4 so a
 * session started in pi can resume here and vice versa.
 * @module dsh-grill/state
 */

export const SCHEMA_VERSION = 4;
export const STATUS_VALUES = ["pending", "current", "answered", "skipped", "deprecated", "removed"] as const;
export type GrillStatus = (typeof STATUS_VALUES)[number];

export type GrillOption = {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
	recommendationReason?: string;
	requiresText?: boolean;
};

export type AskQuestion = {
	id: string;
	section: string;
	question: string;
	context?: string;
	options: GrillOption[];
	recommended?: string;
	recommendationReason?: string;
};

export type AskAnswer = {
	id: string;
	value: string;
	label: string;
	index: number;
	other?: boolean;
	reason: string;
};

export type PinnedQuestion = {
	question: string;
	context?: string;
	options: GrillOption[];
	recommended?: string;
	recommendationReason?: string;
	section?: string;
};

export type GrillQuestion = {
	id: string;
	section: string;
	status: GrillStatus;
	question: string;
	context?: string;
	options: GrillOption[];
	recommended?: string;
	recommendationReason?: string;
	userChoice?: string;
	reason?: string;
	statusNote?: string;
	pinned?: PinnedQuestion;
};

export type GrillUiState = {
	focusedPane: "questions" | "answer";
	selectedQuestionId: string | null;
	selectedOptionByQuestion: Record<string, number>;
	optionScrollOffsetByQuestion: Record<string, number>;
	listScrollOffset: number;
	activeSurface: "question" | "submit";
	revision: number;
};

export type GrillState = {
	schemaVersion: number;
	content: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	questions: GrillQuestion[];
	notes: string[];
	currentQuestionId: string | null;
	answeredCount: number;
	validQuestionCount: number;
	ui: GrillUiState;
};

export type SectionIndexEntry = { id: string; status: GrillStatus };

export type LedgerRow = {
	id: string;
	section: string;
	status: GrillStatus;
	question: string;
	answerable: boolean;
	choice?: string;
	reason?: string;
	statusNote?: string;
};

export const DEFAULT_CONVERGE_KEYWORDS = ["confirm", "converge", "yes", "确认", "生成"];
export const SKIP_STATUS_NOTE = "skipped by the user";
export const REFINE_STATUS_NOTE = "superseded by a user re-answer";
export const SUPERSEDED_STATUS_NOTE = "superseded by a newer question batch";
export const REMOVE_STATUS_NOTE = "removed by the agent";
export const MAX_SECTION_LENGTH = 120;

export type GrillConfig = {
	directory: string;
	convergeKeywords: string[];
};

export function defaultGrillConfig(): GrillConfig {
	return { directory: ".dsh-grill", convergeKeywords: [...DEFAULT_CONVERGE_KEYWORDS] };
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
	return JSON.stringify(value);
}

/** Question content that must never change once pinned. */
export function immutableQuestion(question: GrillQuestion | PinnedQuestion): PinnedQuestion {
	return {
		question: question.question,
		context: question.context,
		options: clone(question.options),
		recommended: question.recommended,
		recommendationReason: question.recommendationReason,
		section: question.section,
	};
}

export function normalizeSection(section: string): string {
	return section.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function defaultUiState(selectedQuestionId: string | null = null): GrillUiState {
	return {
		focusedPane: "questions",
		selectedQuestionId,
		selectedOptionByQuestion: {},
		optionScrollOffsetByQuestion: {},
		listScrollOffset: 0,
		activeSurface: selectedQuestionId ? "question" : "submit",
		revision: 0,
	};
}

export function initialState(content: string, cwd: string): GrillState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SCHEMA_VERSION,
		content,
		cwd,
		createdAt: now,
		updatedAt: now,
		questions: [],
		notes: [],
		currentQuestionId: null,
		answeredCount: 0,
		validQuestionCount: 0,
		ui: defaultUiState(),
	};
}

function statusTransitionAllowed(previous: GrillStatus, next: GrillStatus): boolean {
	const allowed: Record<GrillStatus, readonly GrillStatus[]> = {
		pending: ["pending", "current", "skipped", "removed"],
		current: ["current", "pending", "answered", "skipped", "removed"],
		answered: ["answered", "skipped", "deprecated"],
		skipped: ["skipped", "answered", "removed", "deprecated"],
		deprecated: ["deprecated"],
		removed: ["removed", "deprecated"],
	};
	return allowed[previous].includes(next);
}

// ---- hand-rolled shape checks (Typebox is a pi-grill dep we do not carry) ----

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkString(value: unknown): boolean {
	return typeof value === "string";
}

function checkOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function checkOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function checkOptionalInteger(value: unknown): boolean {
	return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function checkOptionalStringOrNull(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "string";
}

function checkGrillOption(value: unknown): boolean {
	return isRecord(value)
		&& checkString(value.value)
		&& checkString(value.label)
		&& checkOptionalString(value.description)
		&& checkOptionalBoolean(value.recommended)
		&& checkOptionalString(value.recommendationReason)
		&& checkOptionalBoolean(value.requiresText);
}

function checkGrillOptionArray(value: unknown): boolean {
	return Array.isArray(value) && value.every(checkGrillOption);
}

function checkPinnedQuestion(value: unknown): boolean {
	return isRecord(value)
		&& checkString(value.question)
		&& checkOptionalString(value.context)
		&& checkGrillOptionArray(value.options)
		&& checkOptionalString(value.recommended)
		&& checkOptionalString(value.recommendationReason)
		&& checkOptionalString(value.section);
}

function checkStatus(value: unknown): boolean {
	return typeof value === "string" && (STATUS_VALUES as readonly string[]).includes(value);
}

function checkGrillQuestion(value: unknown): boolean {
	return isRecord(value)
		&& checkString(value.id)
		&& checkString(value.section)
		&& checkStatus(value.status)
		&& checkString(value.question)
		&& checkOptionalString(value.context)
		&& checkGrillOptionArray(value.options)
		&& checkOptionalString(value.recommended)
		&& checkOptionalString(value.recommendationReason)
		&& checkOptionalString(value.userChoice)
		&& checkOptionalString(value.reason)
		&& checkOptionalString(value.statusNote)
		&& (value.pinned === undefined || checkPinnedQuestion(value.pinned));
}

function checkGrillStateShape(candidate: unknown): candidate is GrillState {
	if (!isRecord(candidate)) return false;
	return candidate.schemaVersion === SCHEMA_VERSION
		&& checkString(candidate.content)
		&& checkString(candidate.cwd)
		&& checkString(candidate.createdAt)
		&& checkString(candidate.updatedAt)
		&& Array.isArray(candidate.questions) && candidate.questions.every(checkGrillQuestion)
		&& Array.isArray(candidate.notes) && candidate.notes.every(checkString)
		&& checkOptionalStringOrNull(candidate.currentQuestionId)
		&& typeof candidate.answeredCount === "number" && Number.isInteger(candidate.answeredCount) && candidate.answeredCount >= 0
		&& typeof candidate.validQuestionCount === "number" && Number.isInteger(candidate.validQuestionCount) && candidate.validQuestionCount >= 0
		&& checkUiState(candidate.ui);
}

function checkUiState(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (value.focusedPane === "questions" || value.focusedPane === "answer")
		&& checkOptionalStringOrNull(value.selectedQuestionId)
		&& isRecord(value.selectedOptionByQuestion) && Object.values(value.selectedOptionByQuestion).every(checkOptionalInteger)
		&& isRecord(value.optionScrollOffsetByQuestion) && Object.values(value.optionScrollOffsetByQuestion).every(checkOptionalInteger)
		&& typeof value.listScrollOffset === "number" && Number.isInteger(value.listScrollOffset) && value.listScrollOffset >= 0
		&& (value.activeSurface === "question" || value.activeSurface === "submit")
		&& typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0;
}

// ---- validation ----

export function validateQuestionShape(question: GrillQuestion): string | undefined {
	if (!checkGrillQuestion(question)) return "question does not match schema";
	if (!question.id.trim()) return "question id is empty";
	const section = normalizeSection(question.section);
	if (!section) return question.id + " has an empty section";
	if (section.length > MAX_SECTION_LENGTH) return question.id + " section exceeds " + MAX_SECTION_LENGTH + " characters";
	if (section !== question.section) return question.id + " section must be normalized (no control characters or padded whitespace)";
	const optionValues = new Set<string>();
	for (const option of question.options) {
		if (!option.value.trim() || !option.label.trim()) return question.id + " has an empty option";
		if (optionValues.has(option.value)) return question.id + " has duplicate option values";
		optionValues.add(option.value);
	}
	if (question.recommended !== undefined && !optionValues.has(question.recommended)) return question.id + " recommendation is not an option";
	if (question.status === "current" && (question.userChoice !== undefined || question.reason !== undefined || question.pinned !== undefined)) {
		return question.id + " current state already has answer data";
	}
	if (question.status === "answered" && (!question.userChoice || question.pinned === undefined)) {
		return question.id + " answered state is missing its pinned answer";
	}
	if (question.status === "deprecated" && (!question.userChoice || question.pinned === undefined || !question.statusNote?.trim())) {
		return question.id + " deprecated state is missing its pinned answer or status note";
	}
	if (question.status === "skipped" && !question.statusNote?.trim()) return question.id + " skipped state is missing a status note";
	if (question.status === "removed" && !question.statusNote?.trim()) return question.id + " removed state is missing a status note";
	return undefined;
}

function counts(state: GrillState): { answered: number; valid: number } {
	return {
		answered: state.questions.filter((question) => question.status === "answered" || question.status === "deprecated").length,
		valid: state.questions.filter((question) => question.status !== "deprecated" && question.status !== "removed").length,
	};
}

export function getInitialOptionIndex(question: Pick<GrillQuestion, "options" | "recommended" | "userChoice">): number {
	if (question.userChoice !== undefined) {
		const existing = question.options.findIndex((option) => option.label === question.userChoice);
		return existing >= 0 ? existing : question.options.length;
	}
	const recommended = question.recommended === undefined ? -1 : question.options.findIndex((option) => option.value === question.recommended);
	return recommended >= 0 ? recommended : 0;
}

export function normalizeOptionViewport(
	selectedIndex: number,
	offset: number,
	optionCount: number,
	threshold: number,
	scrollEnabled = optionCount > threshold,
): { selectedIndex: number; offset: number } {
	const normalizedCount = Math.max(0, optionCount);
	const selected = normalizedCount === 0 ? 0 : Math.min(normalizedCount - 1, Math.max(0, selectedIndex));
	if (!scrollEnabled || normalizedCount <= threshold) return { selectedIndex: selected, offset: 0 };
	const maxOffset = Math.max(0, normalizedCount - threshold);
	let normalizedOffset = Math.min(maxOffset, Math.max(0, offset));
	if (selected < normalizedOffset) normalizedOffset = selected;
	if (selected >= normalizedOffset + threshold) normalizedOffset = selected - threshold + 1;
	return { selectedIndex: selected, offset: normalizedOffset };
}

export function normalizeUiState(state: GrillState, optionScrollThreshold = 8): GrillUiState {
	const ledgerIds = new Set(state.questions.map((question) => question.id));
	const activeSurface = state.ui.activeSurface;
	const fallbackId = state.questions.find((question) => question.status === "current")?.id
		?? state.questions.find((question) => question.status === "pending")?.id
		?? state.questions[0]?.id
		?? null;
	const selectedQuestionId = activeSurface === "submit" && state.ui.selectedQuestionId === null
		? null
		: state.ui.selectedQuestionId && ledgerIds.has(state.ui.selectedQuestionId)
			? state.ui.selectedQuestionId
			: fallbackId;
	const selectedOptionByQuestion: Record<string, number> = {};
	const optionScrollOffsetByQuestion: Record<string, number> = {};
	for (const question of state.questions) {
		if (question.status !== "pending" && question.status !== "current" && question.status !== "answered") continue;
		const rawSelected = state.ui.selectedOptionByQuestion[question.id];
		const rawOffset = state.ui.optionScrollOffsetByQuestion[question.id];
		if (rawSelected === undefined && rawOffset === undefined) continue;
		const viewport = normalizeOptionViewport(
			rawSelected ?? getInitialOptionIndex(question),
			rawOffset ?? 0,
			question.options.length + 1,
			optionScrollThreshold,
			question.options.length > optionScrollThreshold,
		);
		selectedOptionByQuestion[question.id] = viewport.selectedIndex;
		optionScrollOffsetByQuestion[question.id] = viewport.offset;
	}
	return {
		focusedPane: state.ui.focusedPane,
		selectedQuestionId,
		selectedOptionByQuestion,
		optionScrollOffsetByQuestion,
		listScrollOffset: Math.min(Math.max(0, state.questions.length - 1), Math.max(0, state.ui.listScrollOffset)),
		activeSurface,
		revision: Math.max(0, state.ui.revision),
	};
}

export function migrateState(raw: unknown): GrillState {
	const guidance = "delete or repair the state file, then start again";
	if (!isRecord(raw)) throw new Error("$ must be an object; " + guidance);
	const candidate = clone(raw) as Record<string, unknown>;
	if (candidate.schemaVersion !== SCHEMA_VERSION) throw new Error("$.schemaVersion must be " + SCHEMA_VERSION + ", received " + String(candidate.schemaVersion) + "; " + guidance);
	if (!Array.isArray(candidate.notes)) throw new Error("$.notes is required in schema v" + SCHEMA_VERSION + "; " + guidance);
	if (!isRecord(candidate.ui) || !("optionScrollOffsetByQuestion" in candidate.ui)) {
		throw new Error("$.ui.optionScrollOffsetByQuestion is required in schema v" + SCHEMA_VERSION + "; " + guidance);
	}
	if (!checkGrillStateShape(candidate)) {
		throw new Error("state does not match schema v" + SCHEMA_VERSION + "; " + guidance);
	}
	return candidate as GrillState;
}

export function validateState(
	candidate: GrillState,
	previous?: GrillState,
	atomicAnswerIds: ReadonlySet<string> = new Set(),
): string | undefined {
	if (!checkGrillStateShape(candidate)) return "state does not match schema";
	if (!candidate.content.trim()) return "content is empty";
	if (!candidate.cwd.trim()) return "cwd is empty";
	if (!candidate.createdAt.trim() || !candidate.updatedAt.trim()) return "state timestamps are empty";

	const ids = new Set<string>();
	let currentCount = 0;
	for (const question of candidate.questions) {
		const error = validateQuestionShape(question);
		if (error) return error;
		if (ids.has(question.id)) return "duplicate question id: " + question.id;
		ids.add(question.id);
		if (question.status === "current") currentCount += 1;
		if ((question.status === "answered" || question.status === "deprecated") && question.pinned) {
			if (stableJson(immutableQuestion(question)) !== stableJson(question.pinned)) return question.id + " changed pinned question content";
		}
	}
	if (currentCount > 1) return "more than one current question";
	const expectedCurrent = candidate.questions.find((question) => question.status === "current")?.id ?? null;
	if (candidate.currentQuestionId !== expectedCurrent) return "currentQuestionId is inconsistent with current status";
	const expectedCounts = counts(candidate);
	if (candidate.answeredCount !== expectedCounts.answered) return "answeredCount is inconsistent with question statuses";
	if (candidate.validQuestionCount !== expectedCounts.valid) return "validQuestionCount is inconsistent with question statuses";
	if (stableJson(candidate.ui) !== stableJson(normalizeUiState(candidate))) return "ui state is not normalized";
	if (!previous) return undefined;
	if (candidate.content !== previous.content || candidate.cwd !== previous.cwd || candidate.createdAt !== previous.createdAt) return "session identity is immutable";
	if (candidate.ui.revision < previous.ui.revision) return "ui revision moved backwards";
	if (candidate.notes.length < previous.notes.length || previous.notes.some((note, index) => candidate.notes[index] !== note)) return "notes are append-only";
	for (const oldQuestion of previous.questions) {
		const nextQuestion = candidate.questions.find((question) => question.id === oldQuestion.id);
		if (!nextQuestion) return oldQuestion.id + " was deleted; keep the ledger row and mark it removed";
		const atomicPendingAnswer = oldQuestion.status === "pending" && (nextQuestion.status === "answered" || nextQuestion.status === "skipped") && atomicAnswerIds.has(oldQuestion.id);
		if (!statusTransitionAllowed(oldQuestion.status, nextQuestion.status) && !atomicPendingAnswer) {
			return "illegal status transition for " + oldQuestion.id + ": " + oldQuestion.status + " -> " + nextQuestion.status;
		}
		if (oldQuestion.status === "answered" || oldQuestion.status === "deprecated" || oldQuestion.status === "removed") {
			if (stableJson(immutableQuestion(oldQuestion)) !== stableJson(immutableQuestion(nextQuestion))) return oldQuestion.id + " changed after becoming terminal";
		}
		if (oldQuestion.status === "skipped" && nextQuestion.status === "skipped") {
			if (stableJson(immutableQuestion(oldQuestion)) !== stableJson(immutableQuestion(nextQuestion))) return oldQuestion.id + " changed after being skipped";
		}
		if (oldQuestion.status === "answered" || oldQuestion.status === "deprecated") {
			const atomicOverwrite = oldQuestion.status === "answered" && (nextQuestion.status === "answered" || nextQuestion.status === "skipped") && atomicAnswerIds.has(oldQuestion.id);
			if (!atomicOverwrite && (oldQuestion.userChoice !== nextQuestion.userChoice || oldQuestion.reason !== nextQuestion.reason)) {
				return oldQuestion.id + " answer content changed after being pinned";
			}
		}
	}
	return undefined;
}

export function derivedState(state: GrillState): GrillState {
	const next = clone(state);
	const current = next.questions.find((question) => question.status === "current");
	const stateCounts = counts(next);
	next.currentQuestionId = current?.id ?? null;
	next.answeredCount = stateCounts.answered;
	next.validQuestionCount = stateCounts.valid;
	next.ui = normalizeUiState(next);
	next.updatedAt = new Date().toISOString();
	return next;
}

export function getLedgerRows(state: GrillState): LedgerRow[] {
	return state.questions.map((question) => ({
		id: question.id,
		section: question.section,
		status: question.status,
		question: question.question,
		answerable: question.status === "pending" || question.status === "current" || question.status === "answered" || question.status === "skipped",
		choice: question.userChoice,
		reason: question.reason,
		statusNote: question.statusNote,
	}));
}

// ---- mutations ----

export function addQuestions(state: GrillState, questions: AskQuestion[]): GrillState {
	if (questions.length === 0) throw new Error("at least one question is required");
	const next = clone(state);
	const existingIds = new Set(next.questions.map((question) => question.id));
	const batchIds = questions.map((question) => question.id);
	if (new Set(batchIds).size !== batchIds.length) throw new Error("duplicate question ids in this batch");
	for (const question of questions) {
		if (existingIds.has(question.id)) throw new Error("question id already exists: " + question.id);
		const error = validateQuestionShape({ ...question, status: "pending" });
		if (error) throw new Error(error);
	}
	const current = next.questions.find((question) => question.status === "current");
	if (current) {
		current.status = "pending";
		current.statusNote = (current.statusNote ? current.statusNote + "; " : "") + SUPERSEDED_STATUS_NOTE;
	}
	questions.forEach((question, index) => next.questions.push({ ...question, status: index === 0 ? "current" : "pending" }));
	return derivedState(next);
}

export function deprecateQuestions(state: GrillState, ids: readonly string[]): GrillState {
	if (ids.length === 0) throw new Error("at least one deprecate target is required");
	const next = clone(state);
	for (const id of ids) {
		const question = next.questions.find((candidate) => candidate.id === id);
		if (!question) throw new Error("question not found: " + id);
		if (question.status !== "answered" && question.status !== "skipped") {
			throw new Error(id + " cannot be deprecated in state " + question.status + "; only answered or skipped questions can");
		}
		const wasSkipped = question.status === "skipped";
		question.status = "deprecated";
		question.statusNote = wasSkipped ? "skipped, then deprecated by the agent" : "deprecated by the agent";
		if (!question.pinned) question.pinned = immutableQuestion(question);
	}
	return derivedState(next);
}

export function removeQuestions(state: GrillState, ids: readonly string[]): GrillState {
	if (ids.length === 0) throw new Error("at least one remove target is required");
	const next = clone(state);
	for (const id of ids) {
		const question = next.questions.find((candidate) => candidate.id === id);
		if (!question) throw new Error("question not found: " + id);
		if (question.status === "deprecated" || question.status === "removed") throw new Error(id + " is already terminal");
		question.status = "removed";
		question.statusNote = REMOVE_STATUS_NOTE;
		question.userChoice = undefined;
		question.reason = undefined;
		question.pinned = undefined;
	}
	return derivedState(next);
}

export function applyAnswerBatch(state: GrillState, answers: AskAnswer[]): GrillState {
	if (answers.length === 0) throw new Error("at least one answer is required");
	const ids = answers.map((answer) => answer.id);
	if (new Set(ids).size !== ids.length) throw new Error("duplicate answers for the same question");
	for (const answer of answers) {
		const question = state.questions.find((candidate) => candidate.id === answer.id);
		if (!question) throw new Error("question not found: " + answer.id);
		if (question.status !== "current" && question.status !== "pending" && question.status !== "answered" && question.status !== "skipped") {
			throw new Error(question.id + " can no longer be answered: " + question.status);
		}
	}
	const next = clone(state);
	for (const answer of answers) {
		const question = next.questions.find((candidate) => candidate.id === answer.id);
		if (!question) throw new Error("question not found: " + answer.id);
		const pinned = immutableQuestion(question);
		question.userChoice = answer.label;
		question.reason = answer.reason;
		question.pinned = pinned;
		question.statusNote = undefined;
		question.status = "answered";
	}
	return derivedState(next);
}

export function applyRefineAnswer(state: GrillState, answer: AskAnswer): GrillState {
	// Re-answering a previously answered question keeps the old answer as a
	// NEW deprecated ledger row (one row cannot hold two answers); a skipped
	// question is simply answered.
	const existing = state.questions.find((question) => question.id === answer.id);
	if (!existing) throw new Error("question not found: " + answer.id);
	if (existing.status !== "answered" && existing.status !== "skipped" && existing.status !== "pending" && existing.status !== "current") {
		throw new Error(answer.id + " can no longer be answered: " + existing.status);
	}
	const next = clone(state);
	const question = next.questions.find((candidate) => candidate.id === answer.id)!;
	if (question.status === "answered" && question.userChoice !== undefined) {
		const copyIndex = next.questions.filter((candidate) => candidate.id.startsWith(answer.id + "#")).length + 1;
		next.questions.push({
			id: answer.id + "#" + copyIndex,
			section: question.section,
			status: "deprecated",
			question: question.question,
			context: question.context,
			options: clone(question.options),
			recommended: question.recommended,
			recommendationReason: question.recommendationReason,
			userChoice: question.userChoice,
			reason: question.reason,
			pinned: immutableQuestion(question),
			statusNote: REFINE_STATUS_NOTE,
		});
	}
	const pinned = immutableQuestion(question);
	question.userChoice = answer.label;
	question.reason = answer.reason;
	question.pinned = pinned;
	question.statusNote = undefined;
	question.status = "answered";
	return derivedState(next);
}

export function applySkip(state: GrillState, id: string): GrillState {
	const existing = state.questions.find((question) => question.id === id);
	if (!existing) throw new Error("question not found: " + id);
	if (existing.status !== "pending" && existing.status !== "current" && existing.status !== "answered" && existing.status !== "skipped") {
		throw new Error(id + " can no longer be skipped: " + existing.status);
	}
	const next = clone(state);
	const question = next.questions.find((candidate) => candidate.id === id)!;
	question.status = "skipped";
	question.statusNote = SKIP_STATUS_NOTE;
	question.userChoice = undefined;
	question.reason = undefined;
	question.pinned = undefined;
	return derivedState(next);
}

export function applyNote(state: GrillState, note: string): GrillState {
	const trimmed = note.trim();
	if (!trimmed) throw new Error("a note cannot be empty");
	const next = clone(state);
	next.notes = [...next.notes, trimmed];
	return derivedState(next);
}

export function canConverge(state: GrillState): boolean {
	return !state.questions.some((question) => question.status === "pending" || question.status === "current");
}

export function deriveSectionIndex(state: GrillState): Record<string, SectionIndexEntry[]> {
	const index: Record<string, SectionIndexEntry[]> = {};
	for (const question of state.questions) {
		const section = normalizeSection(question.section);
		if (!section) continue;
		(index[section] ??= []).push({ id: question.id, status: question.status });
	}
	return index;
}

// ---- model-facing summaries ----

export function stateSummary(state: GrillState): string {
	const index = deriveSectionIndex(state);
	const sectionKeys = Object.keys(index);
	const sections = sectionKeys.length
		? sectionKeys.map((key) => "- " + key + ": " + index[key]!.map((entry) => entry.id + "[" + entry.status + "]").join(", ")).join("\n")
		: "(no questions yet)";
	const open = state.questions.filter((question) => question.status === "pending" || question.status === "current");
	const openList = open.length
		? open.map((question) => "- [" + question.status + "] " + question.id + " (" + question.section + "): " + question.question).join("\n")
		: "(no pending/current questions)";
	const skipped = state.questions.filter((question) => question.status === "skipped");
	const skippedLine = skipped.length ? "\n\nSkipped (user chose to skip; does not block convergence; still re-answerable):\n" + skipped.map((question) => "- " + question.id + " (" + question.section + "): " + question.question).join("\n") : "";
	const notesLine = state.notes.length ? "\n\nUser notes (not tied to a question):\n" + state.notes.map((note) => "- " + note).join("\n") : "";
	return "State summary (answered " + state.answeredCount + " / active " + state.validQuestionCount + "). This summary is the latest state; you normally do not need to read the JSON.\n\nSection index:\n" + sections + "\n\nOpen questions:\n" + openList + skippedLine + notesLine;
}

export function incrementalSummary(state: GrillState, statePath: string): string {
	const open = state.questions.filter((question) => question.status === "pending" || question.status === "current");
	const openList = open.length
		? open.map((question) => "- [" + question.status + "] " + question.id + " (" + question.section + "): " + question.question).join("\n")
		: "(no pending/current questions)";
	return "Open questions:\n" + openList + "\n\nAnswered " + state.answeredCount + " / active " + state.validQuestionCount + ". Full state (sections, skipped, notes): " + statePath;
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function consumeConvergenceAnswer(
	pendingQuestionIds: Set<string>,
	answer: AskAnswer,
	canConvergeNow: boolean,
	keywords: readonly string[]
): boolean {
	if (!pendingQuestionIds.has(answer.id)) return false;
	if (!canConvergeNow) return false;
	const pattern = new RegExp(keywords.map(escapeRegExp).join("|"), "i");
	return pattern.test(answer.value + " " + answer.label);
}