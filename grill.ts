import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type OverlayHandle,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

const STATUS_KEY = "grill";
const SCHEMA_VERSION = 4;
const LIST_VIEW_SIZE = 10;
const DEFAULT_OPTION_SCROLL_THRESHOLD = 8;
const MAX_OPTION_SCROLL_THRESHOLD = 100;
const LAYOUT_HYSTERESIS = 4;
const UI_CHECKPOINT_DEBOUNCE_MS = 120;
const MAX_SECTION_LENGTH = 120;
const STATUS_VALUES = ["pending", "current", "answered", "skipped", "deprecated", "removed"] as const;
type GrillStatus = (typeof STATUS_VALUES)[number];

type GrillOption = {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
	recommendationReason?: string;
	requiresText?: boolean;
};

type PinnedQuestion = {
	question: string;
	context?: string;
	options: GrillOption[];
	recommended?: string;
	recommendationReason?: string;
	section?: string;
};

type GrillQuestion = {
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

type SessionPaths = {
	directory: string;
	json: string;
	html: string;
};

type AskQuestion = {
	id: string;
	section: string;
	question: string;
	context?: string;
	options: GrillOption[];
	recommended?: string;
	recommendationReason?: string;
};

type AskAnswer = {
	id: string;
	value: string;
	label: string;
	index: number;
	other?: boolean;
	reason: string;
};

type PanelController = {
	generation: number;
	hidden: boolean;
	handle?: OverlayHandle;
	promise: Promise<void>;
	refresh?: (state: GrillState) => void;
	revealCurrent?: (id: string) => void;
	flushUiCheckpoint?: () => void;
	finish?: () => void;
};

type AnswerEvent = AskAnswer & {
	status: GrillStatus;
};

type Runtime = {
	paths: SessionPaths;
	cwd: string;
	context: ExtensionContext;
	state: GrillState;
	watcher: fs.FSWatcher;
	closed: boolean;
	panel?: PanelController;
	panelGeneration: number;
	answerEvents?: ReturnType<typeof createAnswerEventBatcher<AnswerEvent>>;
	pendingConvergenceQuestionIds: Set<string>;
	config: GrillConfig;
};

const GrillOptionSchema = Type.Object({
	value: Type.String(),
	label: Type.String(),
	description: Type.Optional(Type.String()),
	recommended: Type.Optional(Type.Boolean()),
	recommendationReason: Type.Optional(Type.String()),
	requiresText: Type.Optional(Type.Boolean()),
});
const AskQuestionSchema = Type.Object({
	id: Type.String(),
	section: Type.String(),
	question: Type.String(),
	context: Type.Optional(Type.String()),
	options: Type.Array(GrillOptionSchema),
	recommended: Type.Optional(Type.String()),
	recommendationReason: Type.Optional(Type.String()),
});
const GrillAskParams = Type.Object({
	questions: Type.Array(AskQuestionSchema),
	converge: Type.Optional(Type.Boolean()),
});
const GrillStatusSchema = Type.Union(STATUS_VALUES.map((value) => Type.Literal(value)));
const PinnedQuestionSchema = Type.Object({
	question: Type.String(),
	context: Type.Optional(Type.String()),
	options: Type.Array(GrillOptionSchema),
	recommended: Type.Optional(Type.String()),
	recommendationReason: Type.Optional(Type.String()),
	section: Type.Optional(Type.String()),
});
const GrillQuestionSchema = Type.Object({
	id: Type.String(),
	section: Type.String(),
	status: GrillStatusSchema,
	question: Type.String(),
	context: Type.Optional(Type.String()),
	options: Type.Array(GrillOptionSchema),
	recommended: Type.Optional(Type.String()),
	recommendationReason: Type.Optional(Type.String()),
	userChoice: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	statusNote: Type.Optional(Type.String()),
	pinned: Type.Optional(PinnedQuestionSchema),
});
const GrillUiStateSchema = Type.Object({
	focusedPane: Type.Union([Type.Literal("questions"), Type.Literal("answer")]),
	selectedQuestionId: Type.Union([Type.String(), Type.Null()]),
	selectedOptionByQuestion: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
	optionScrollOffsetByQuestion: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
	listScrollOffset: Type.Integer({ minimum: 0 }),
	activeSurface: Type.Union([Type.Literal("question"), Type.Literal("submit")]),
	revision: Type.Integer({ minimum: 0 }),
});
const GrillStateSchema = Type.Object({
	schemaVersion: Type.Literal(SCHEMA_VERSION),
	content: Type.String(),
	cwd: Type.String(),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	questions: Type.Array(GrillQuestionSchema),
	notes: Type.Array(Type.String()),
	currentQuestionId: Type.Union([Type.String(), Type.Null()]),
	answeredCount: Type.Integer({ minimum: 0 }),
	validQuestionCount: Type.Integer({ minimum: 0 }),
	ui: GrillUiStateSchema,
});

const DEFAULT_CONVERGE_KEYWORDS = ["confirm", "converge", "yes", "确认", "生成"];

type GrillConfig = { convergeKeywords: string[]; optionScrollThreshold: number };
const GrillConfigSchema = Type.Object({
	convergeKeywords: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
	optionScrollThreshold: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OPTION_SCROLL_THRESHOLD })),
}, { additionalProperties: false });

export function parseGrillConfig(raw: unknown): GrillConfig {
	if (raw === undefined) return { convergeKeywords: [...DEFAULT_CONVERGE_KEYWORDS], optionScrollThreshold: DEFAULT_OPTION_SCROLL_THRESHOLD };
	if (!Value.Check(GrillConfigSchema, raw)) throw new Error(`optionScrollThreshold must be a safe integer in 1-${MAX_OPTION_SCROLL_THRESHOLD}; convergeKeywords must be a non-empty array of non-empty strings`);
	const candidate = raw as { convergeKeywords?: string[]; optionScrollThreshold?: number };
	if (candidate.convergeKeywords?.some((keyword) => !keyword.trim())) throw new Error("convergeKeywords must be a non-empty array of non-empty strings");
	return {
		convergeKeywords: candidate.convergeKeywords ?? [...DEFAULT_CONVERGE_KEYWORDS],
		optionScrollThreshold: candidate.optionScrollThreshold ?? DEFAULT_OPTION_SCROLL_THRESHOLD,
	};
}

export function parseGrillConfigText(text?: string): GrillConfig {
	return parseGrillConfig(text === undefined ? undefined : JSON.parse(text));
}

export function resolveGrillConfig(text: string | undefined, onInvalid: (message: string) => void): GrillConfig {
	try {
		return parseGrillConfigText(text);
	} catch (error) {
		onInvalid(error instanceof Error ? error.message : String(error));
		return parseGrillConfig(undefined);
	}
}

function grillConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "grill.config.json");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadGrillConfig(context: ExtensionContext): GrillConfig {
	const file = grillConfigPath();
	return resolveGrillConfig(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined, (message) => {
		notify(context, `Invalid grill.config.json; falling back to safe defaults: ${message}`, "error");
	});
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
	return JSON.stringify(value);
}

type AnswerEventBatcherOptions<T> = {
	schedule: (flush: () => void) => unknown;
	cancel: (token: unknown) => void;
	send: (items: T[]) => void;
};

export function createAnswerEventBatcher<T>(options: AnswerEventBatcherOptions<T>) {
	let queue: T[] = [];
	let token: unknown;
	const flush = () => {
		token = undefined;
		if (queue.length === 0) return;
		const items = queue;
		queue = [];
		options.send(items);
	};
	return {
		enqueue(item: T) {
			const id = item && typeof item === "object" && "id" in item ? (item as { id?: unknown }).id : undefined;
			const existingIndex = id === undefined ? -1 : queue.findIndex((queued) => queued && typeof queued === "object" && "id" in queued && (queued as { id?: unknown }).id === id);
			if (existingIndex >= 0) queue[existingIndex] = item;
			else queue.push(item);
			if (token === undefined) token = options.schedule(flush);
		},
		flush,
		dispose() {
			if (token !== undefined) options.cancel(token);
			token = undefined;
			queue = [];
		},
	};
}

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

function immutableQuestion(question: GrillQuestion | PinnedQuestion): PinnedQuestion {
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

function defaultUiState(selectedQuestionId: string | null = null): GrillUiState {
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

function initialState(content: string, cwd: string): GrillState {
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

function sessionPaths(cwd: string, content: string): SessionPaths {
	const directory = path.join(os.tmpdir(), "grill", path.basename(cwd) || "root");
	const digest = createHash("sha1").update(content).digest("hex");
	return {
		directory,
		json: path.join(directory, `${digest}.json`),
		html: path.join(directory, `${digest}.html`),
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

function validateQuestionShape(question: GrillQuestion): string | undefined {
	if (!Value.Check(GrillQuestionSchema, question)) return "question does not match schema";
	if (!question.id.trim()) return "question id is empty";
	const section = normalizeSection(question.section);
	if (!section) return `${question.id} has an empty section`;
	if (section.length > MAX_SECTION_LENGTH) return `${question.id} section exceeds ${MAX_SECTION_LENGTH} characters`;
	if (section !== question.section) return `${question.id} section must be normalized (no control characters or padded whitespace)`;
	const optionValues = new Set<string>();
	for (const option of question.options) {
		if (!option.value.trim() || !option.label.trim()) return `${question.id} has an empty option`;
		if (optionValues.has(option.value)) return `${question.id} has duplicate option values`;
		optionValues.add(option.value);
	}
	if (question.recommended !== undefined && !optionValues.has(question.recommended)) return `${question.id} recommendation is not an option`;
	if (question.status === "current" && (question.userChoice !== undefined || question.reason !== undefined || question.pinned !== undefined)) {
		return `${question.id} current state already has answer data`;
	}
	if (question.status === "answered" && (!question.userChoice || question.pinned === undefined)) {
		return `${question.id} answered state is missing its pinned answer`;
	}
	if (question.status === "deprecated" && (!question.userChoice || question.pinned === undefined || !question.statusNote?.trim())) {
		return `${question.id} deprecated state is missing its pinned answer or status note`;
	}
	if (question.status === "skipped" && !question.statusNote?.trim()) return `${question.id} skipped state is missing a status note`;
	if (question.status === "removed" && !question.statusNote?.trim()) return `${question.id} removed state is missing a status note`;
	return undefined;
}

function counts(state: GrillState): { answered: number; valid: number } {
	return {
		answered: state.questions.filter((question) => question.status === "answered" || question.status === "deprecated").length,
		valid: state.questions.filter((question) => question.status !== "deprecated" && question.status !== "removed").length,
	};
}
export function normalizeOptionViewport(selectedIndex: number, offset: number, optionCount: number, threshold: number, scrollEnabled = optionCount > threshold): { selectedIndex: number; offset: number } {
	const normalizedCount = Math.max(0, optionCount);
	const selected = normalizedCount === 0 ? 0 : Math.min(normalizedCount - 1, Math.max(0, selectedIndex));
	if (!scrollEnabled || normalizedCount <= threshold) return { selectedIndex: selected, offset: 0 };
	const maxOffset = Math.max(0, normalizedCount - threshold);
	let normalizedOffset = Math.min(maxOffset, Math.max(0, offset));
	if (selected < normalizedOffset) normalizedOffset = selected;
	if (selected >= normalizedOffset + threshold) normalizedOffset = selected - threshold + 1;
	return { selectedIndex: selected, offset: normalizedOffset };
}

export function normalizeUiState(state: GrillState, optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillUiState {
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
		const viewport = normalizeOptionViewport(rawSelected ?? getInitialOptionIndex(question), rawOffset ?? 0, question.options.length + 1, optionScrollThreshold, question.options.length > optionScrollThreshold);
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
	if (!raw || typeof raw !== "object") throw new Error(`$ must be an object; ${guidance}`);
	const candidate = clone(raw as Record<string, unknown>) as Record<string, unknown>;
	if (candidate.schemaVersion !== SCHEMA_VERSION) throw new Error(`$.schemaVersion must be ${SCHEMA_VERSION}, received ${String(candidate.schemaVersion)}; ${guidance}`);
	if (!Array.isArray(candidate.notes)) throw new Error(`$.notes is required in schema v${SCHEMA_VERSION}; ${guidance}`);
	if (!candidate.ui || typeof candidate.ui !== "object" || !("optionScrollOffsetByQuestion" in candidate.ui)) {
		throw new Error(`$.ui.optionScrollOffsetByQuestion is required in schema v${SCHEMA_VERSION}; ${guidance}`);
	}
	if (!Value.Check(GrillStateSchema, candidate)) {
		const first = [...Value.Errors(GrillStateSchema, candidate)][0] as { path?: string; message?: string } | undefined;
		throw new Error(`${first?.path || "$"} is missing or conflicts with schema v${SCHEMA_VERSION}: ${first?.message ?? "validation failed"}; ${guidance}`);
	}
	return candidate as unknown as GrillState;
}

export function validateState(candidate: GrillState, previous?: GrillState, atomicAnswerIds: ReadonlySet<string> = new Set(), optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): string | undefined {
	if (!Value.Check(GrillStateSchema, candidate)) return "state does not match schema";
	if (!candidate.content.trim()) return "content is empty";
	if (!candidate.cwd.trim()) return "cwd is empty";
	if (!candidate.createdAt.trim() || !candidate.updatedAt.trim()) return "state timestamps are empty";

	const ids = new Set<string>();
	let currentCount = 0;
	for (const question of candidate.questions) {
		const error = validateQuestionShape(question);
		if (error) return error;
		if (ids.has(question.id)) return `duplicate question id: ${question.id}`;
		ids.add(question.id);
		if (question.status === "current") currentCount += 1;
		if ((question.status === "answered" || question.status === "deprecated") && question.pinned) {
			if (stableJson(immutableQuestion(question)) !== stableJson(question.pinned)) return `${question.id} changed pinned question content`;
		}
	}
	if (currentCount > 1) return "more than one current question";
	const expectedCurrent = candidate.questions.find((question) => question.status === "current")?.id ?? null;
	if (candidate.currentQuestionId !== expectedCurrent) return "currentQuestionId is inconsistent with current status";
	const expectedCounts = counts(candidate);
	if (candidate.answeredCount !== expectedCounts.answered) return "answeredCount is inconsistent with question statuses";
	if (candidate.validQuestionCount !== expectedCounts.valid) return "validQuestionCount is inconsistent with question statuses";
	if (stableJson(candidate.ui) !== stableJson(normalizeUiState(candidate, optionScrollThreshold))) return "ui state is not normalized";
	if (!previous) return undefined;
	if (candidate.content !== previous.content || candidate.cwd !== previous.cwd || candidate.createdAt !== previous.createdAt) return "session identity is immutable";
	if (candidate.ui.revision < previous.ui.revision) return "ui revision moved backwards";
	if (candidate.notes.length < previous.notes.length || previous.notes.some((note, index) => candidate.notes[index] !== note)) return "notes are append-only";
	for (const oldQuestion of previous.questions) {
		const nextQuestion = candidate.questions.find((question) => question.id === oldQuestion.id);
		if (!nextQuestion) return `${oldQuestion.id} was deleted; keep the ledger row and mark it removed`;
		const atomicPendingAnswer = oldQuestion.status === "pending" && (nextQuestion.status === "answered" || nextQuestion.status === "skipped") && atomicAnswerIds.has(oldQuestion.id);
		if (!statusTransitionAllowed(oldQuestion.status, nextQuestion.status) && !atomicPendingAnswer) return `illegal status transition for ${oldQuestion.id}: ${oldQuestion.status} -> ${nextQuestion.status}`;
		if (oldQuestion.status === "answered" || oldQuestion.status === "deprecated" || oldQuestion.status === "removed") {
			if (stableJson(immutableQuestion(oldQuestion)) !== stableJson(immutableQuestion(nextQuestion))) return `${oldQuestion.id} changed after becoming terminal`;
		}
		if (oldQuestion.status === "skipped" && nextQuestion.status === "skipped") {
			if (stableJson(immutableQuestion(oldQuestion)) !== stableJson(immutableQuestion(nextQuestion))) return `${oldQuestion.id} changed after being skipped`;
		}
		if (oldQuestion.status === "answered" || oldQuestion.status === "deprecated") {
			const atomicOverwrite = oldQuestion.status === "answered" && (nextQuestion.status === "answered" || nextQuestion.status === "skipped") && atomicAnswerIds.has(oldQuestion.id);
			if (!atomicOverwrite && (oldQuestion.userChoice !== nextQuestion.userChoice || oldQuestion.reason !== nextQuestion.reason)) return `${oldQuestion.id} answer content changed after being pinned`;
		}
	}
	return undefined;
}

function derivedState(state: GrillState, optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillState {
	const next = clone(state);
	const current = next.questions.find((question) => question.status === "current");
	const stateCounts = counts(next);
	next.currentQuestionId = current?.id ?? null;
	next.answeredCount = stateCounts.answered;
	next.validQuestionCount = stateCounts.valid;
	next.ui = normalizeUiState(next, optionScrollThreshold);
	next.updatedAt = new Date().toISOString();
	return next;
}

function readJsonState(file: string): GrillState {
	return migrateState(JSON.parse(fs.readFileSync(file, "utf8")));
}

function writeAtomic(file: string, content: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, content, "utf8");
	fs.renameSync(temporary, file);
}

function htmlEscape(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function questionHtml(question: GrillQuestion): string {
	const statusLabel = {
		pending: "Pending",
		current: "◀ Current",
		answered: "🔒 Answered",
		skipped: "↷ Skipped",
		deprecated: "Deprecated",
		removed: "Removed",
	}[question.status];
	const options = question.options.map((option) => {
		const recommended = option.value === question.recommended ? ' class="recommended"' : "";
		const marker = option.value === question.recommended ? " <strong>Recommended</strong>" : "";
		const description = option.description ? `<small>${htmlEscape(option.description)}</small>` : "";
		return `<li${recommended}>${htmlEscape(option.label)}${marker}${description}</li>`;
	}).join("");
	const choice = question.userChoice ? `<p class="choice">Answer: ${htmlEscape(question.userChoice)}${question.reason ? `<br>Reason: ${htmlEscape(question.reason)}` : ""}</p>` : "";
	const note = question.statusNote ? `<p class="note">Status note: ${htmlEscape(question.statusNote)}</p>` : "";
	return `<article id="${htmlEscape(question.id)}" class="card ${question.status}"><header><code>${htmlEscape(question.id)}</code><span class="status">${statusLabel}</span></header><h2>${htmlEscape(question.question)}</h2><ol>${options}</ol>${question.recommendationReason ? `<p class="recommendation">Why recommended: ${htmlEscape(question.recommendationReason)}</p>` : ""}${choice}${note}</article>`;
}

function renderHtml(paths: SessionPaths, state: GrillState): void {
	const cards = state.questions.map(questionHtml).join("\n");
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>Grill · ${htmlEscape(state.content)}</title><style>:root{--canvas:#f4efe5;--paper:#fffdf8;--ink:#2c2924;--muted:#746c61;--rule:#d8cfbf;--ok:#e5eee0;--green:#4e714f;--current:#f7ead0;--danger:#ead6cf;--pending:#eef0f1}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif}main{max-width:960px;margin:auto;padding:36px 20px 72px}header.page{border-bottom:1px solid var(--ink);padding-bottom:20px;margin-bottom:22px}h1{font:700 clamp(28px,5vw,46px)/1.15 Georgia,"Songti SC",serif;margin:8px 0}.meta,code,small{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.progress{display:inline-block;background:#eadfca;padding:5px 9px;border-radius:5px}.card{background:var(--paper);border:1px solid var(--rule);border-radius:10px;padding:16px 18px;margin:12px 0;scroll-margin-top:16px}.card.current{background:var(--current);border:2px solid #a15e1d}.card.answered{background:var(--ok);border-color:#9db28e}.card.deprecated{background:var(--danger);opacity:.7}.card.removed{opacity:.5}.card header{display:flex;gap:8px;align-items:center}.card h2{font-size:18px;margin:8px 0}.card ol{margin:0;padding-left:20px}.card li{margin:5px 0}.card li small{display:block;margin-left:4px}.card li.recommended{color:var(--green);font-weight:700}.status{font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#d0dec8;color:var(--green);padding:2px 6px;border-radius:4px}.current .status{background:#f0d4a0;color:#8b4e15}.deprecated .status,.removed .status{background:#e5c7be;color:#7b4032}.choice{font-weight:700;color:var(--green)}.note{font-size:12px;color:#7b4032}@media(prefers-color-scheme:dark){:root{--canvas:#201d19;--paper:#2b2722;--ink:#eee8dd;--muted:#b7afa2;--rule:#554d43;--ok:#34402d;--current:#493a26;--danger:#4a3029;--pending:#312f2b}.progress{background:#40372c}.status{background:#42543a;color:#c8d9bb}}@media print{body{background:#fff}.card{break-inside:avoid}}</style></head><body><main><header class="page"><div class="meta">PI EXTENSION · LIVE DESIGN INTERVIEW</div><h1>${htmlEscape(state.content)}</h1><p class="progress">Answered ${state.answeredCount} / active ${state.validQuestionCount}</p><p class="meta">Rendered ${htmlEscape(state.updatedAt)} · refreshes every 3s</p></header>${cards}</main></body></html>`;
	writeAtomic(paths.html, html);
}

function notify(context: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (context.hasUI) context.ui.notify(message, type);
}

function setWidget(runtime: Runtime): void {
	const openQuestionId = runtime.state.currentQuestionId ?? runtime.state.questions.find((question) => question.status === "pending")?.id;
	const current = openQuestionId ?? (runtime.state.questions.length === 0 ? "none" : "converged");
	const visibility = runtime.panel && !runtime.panel.hidden
		? "[open] Esc to hide"
		: "[hidden] /grill-panel to open";
	runtime.context.ui.setWidget(STATUS_KEY, [`grill · answered ${runtime.state.answeredCount} / active ${runtime.state.validQuestionCount} · current ${current} · ${visibility}`, runtime.paths.json]);
}

function persist(runtime: Runtime, state: GrillState): void {
	const next = derivedState(state, runtime.config.optionScrollThreshold);
	const error = validateState(next, runtime.state, new Set(), runtime.config.optionScrollThreshold);
	if (error) throw new Error(error);
	writeAtomic(runtime.paths.json, `${JSON.stringify(next, null, 2)}\n`);
	renderHtml(runtime.paths, next);
	runtime.state = next;
	setWidget(runtime);
}

function persistUiCheckpoint(runtime: Runtime, ui: GrillUiState): void {
	let base = runtime.state;
	try {
		const disk = readJsonState(runtime.paths.json);
		const businessError = validateState(disk, runtime.state, new Set(), runtime.config.optionScrollThreshold);
		if (businessError && businessError !== "ui revision moved backwards") return;
		base = disk;
	} catch {
		// A partial/invalid external edit must not be overwritten by a UI-only checkpoint.
		return;
	}
	const normalized = normalizeUiState({ ...base, ui: { ...ui, revision: base.ui.revision } }, runtime.config.optionScrollThreshold);
	if (stableJson(normalized) === stableJson(base.ui)) {
		if (stableJson(base) !== stableJson(runtime.state)) {
			runtime.state = base;
			renderHtml(runtime.paths, base);
			setWidget(runtime);
			runtime.panel?.refresh?.(base);
		}
		return;
	}
	const next = clone(base);
	next.ui = { ...normalized, revision: Math.max(base.ui.revision, runtime.state.ui.revision) + 1 };
	const derived = derivedState(next, runtime.config.optionScrollThreshold);
	const error = validateState(derived, base, new Set(), runtime.config.optionScrollThreshold);
	if (error) throw new Error(error);
	writeAtomic(runtime.paths.json, `${JSON.stringify(derived, null, 2)}\n`);
	renderHtml(runtime.paths, derived);
	runtime.state = derived;
	setWidget(runtime);
	runtime.panel?.refresh?.(derived);
}

function syncFromDisk(runtime: Runtime): void {
	if (runtime.closed) return;
	try {
		const candidate = readJsonState(runtime.paths.json);
		candidate.ui = normalizeUiState(candidate, runtime.config.optionScrollThreshold);
		if (stableJson(candidate) === stableJson(runtime.state)) return;
		const error = validateState(candidate, runtime.state, new Set(), runtime.config.optionScrollThreshold);
		if (error) {
			notify(runtime.context, `grill JSON change rejected; keeping the previous projection: ${error}`, "error");
			return;
		}
		runtime.state = candidate;
		renderHtml(runtime.paths, candidate);
		setWidget(runtime);
		runtime.panel?.refresh?.(candidate);
	} catch (error) {
		notify(runtime.context, `grill JSON could not be parsed; keeping the previous projection: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function startRuntime(paths: SessionPaths, cwd: string, context: ExtensionContext, state: GrillState, config: GrillConfig): Runtime {
	let runtime: Runtime | undefined;
	const watcher = fs.watch(paths.directory, { persistent: false }, (_event, filename) => {
		if (runtime && (!filename || filename.toString() === path.basename(paths.json))) syncFromDisk(runtime);
	});
	runtime = { paths, cwd, context, state, watcher, closed: false, panelGeneration: 0, pendingConvergenceQuestionIds: new Set(), config };
	return runtime;
}

function closeRuntime(runtime: Runtime): void {
	if (runtime.closed) return;
	const panel = runtime.panel;
	runtime.panel = undefined;
	runtime.answerEvents?.dispose();
	runtime.answerEvents = undefined;
	try {
		panel?.flushUiCheckpoint?.();
	} finally {
		panel?.handle?.hide();
		panel?.finish?.();
		runtime.closed = true;
		runtime.watcher.close();
		runtime.context.ui.setWidget(STATUS_KEY, undefined);
	}
}

function addQuestions(runtime: Runtime, questions: AskQuestion[]): void {
	if (questions.length === 0) throw new Error("at least one question is required");
	const next = clone(runtime.state);
	const existingIds = new Set(next.questions.map((question) => question.id));
	const batchIds = questions.map((question) => question.id);
	if (new Set(batchIds).size !== batchIds.length) throw new Error("duplicate question ids in this batch");
	for (const question of questions) {
		if (existingIds.has(question.id)) throw new Error(`question id already exists: ${question.id}`);
		const error = validateQuestionShape({ ...question, status: "pending" });
		if (error) throw new Error(error);
	}
	const current = next.questions.find((question) => question.status === "current");
	if (current) {
		current.status = "pending";
		current.statusNote = `${current.statusNote ? `${current.statusNote}; ` : ""}superseded by a newer question batch`;
	}
	questions.forEach((question, index) => next.questions.push({ ...question, status: index === 0 ? "current" : "pending" }));
	persist(runtime, next);
}

export type SectionIndexEntry = { id: string; status: GrillStatus };

export function deriveSectionIndex(state: GrillState): Record<string, SectionIndexEntry[]> {
	const index: Record<string, SectionIndexEntry[]> = {};
	for (const question of state.questions) {
		const section = normalizeSection(question.section);
		if (!section) continue;
		(index[section] ??= []).push({ id: question.id, status: question.status });
	}
	return index;
}

export function validateAnswerBatchTransition(candidate: GrillState, previous: GrillState, answerIds: readonly string[], optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): string | undefined {
	return validateState(candidate, previous, new Set(answerIds), optionScrollThreshold);
}

export function applyAnswerBatch(state: GrillState, answers: AskAnswer[], optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillState {
	if (answers.length === 0) throw new Error("at least one answer is required");
	const ids = answers.map((answer) => answer.id);
	if (new Set(ids).size !== ids.length) throw new Error("duplicate answers for the same question");
	for (const answer of answers) {
		const question = state.questions.find((candidate) => candidate.id === answer.id);
		if (!question) throw new Error(`question not found: ${answer.id}`);
		if (question.status !== "current" && question.status !== "pending" && question.status !== "answered" && question.status !== "skipped") {
			throw new Error(`${question.id} can no longer be answered: ${question.status}`);
		}
	}
	const next = clone(state);
	for (const answer of answers) {
		const question = next.questions.find((candidate) => candidate.id === answer.id);
		if (!question) throw new Error(`question not found: ${answer.id}`);
		const pinned = immutableQuestion(question);
		question.userChoice = answer.label;
		question.reason = answer.reason;
		question.pinned = pinned;
		question.statusNote = undefined;
		question.status = "answered";
	}
	return derivedState(next, optionScrollThreshold);
}

type AnswerBatchCommitEffects = {
	write: (state: GrillState) => void;
	afterWrite?: (state: GrillState) => void;
};

export function commitAnswerBatch(state: GrillState, answers: AskAnswer[], effects: AnswerBatchCommitEffects, optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillState {
	const next = applyAnswerBatch(state, answers, optionScrollThreshold);
	const error = validateAnswerBatchTransition(next, state, answers.map((answer) => answer.id), optionScrollThreshold);
	if (error) throw new Error(error);
	effects.write(next);
	effects.afterWrite?.(next);
	return next;
}

export const SKIP_STATUS_NOTE = "skipped by the user";

export function applySkip(state: GrillState, id: string, optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillState {
	const existing = state.questions.find((question) => question.id === id);
	if (!existing) throw new Error(`question not found: ${id}`);
	if (existing.status !== "pending" && existing.status !== "current" && existing.status !== "answered" && existing.status !== "skipped") {
		throw new Error(`${id} can no longer be skipped: ${existing.status}`);
	}
	const next = clone(state);
	const question = next.questions.find((candidate) => candidate.id === id);
	if (!question) throw new Error(`question not found: ${id}`);
	question.status = "skipped";
	question.statusNote = SKIP_STATUS_NOTE;
	question.userChoice = undefined;
	question.reason = undefined;
	question.pinned = undefined;
	return derivedState(next, optionScrollThreshold);
}

export function commitSkip(state: GrillState, id: string, effects: AnswerBatchCommitEffects, optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillState {
	const next = applySkip(state, id, optionScrollThreshold);
	const error = validateState(next, state, new Set([id]), optionScrollThreshold);
	if (error) throw new Error(error);
	effects.write(next);
	effects.afterWrite?.(next);
	return next;
}

export function applyNote(state: GrillState, note: string, optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillState {
	const trimmed = note.trim();
	if (!trimmed) throw new Error("a note cannot be empty");
	const next = clone(state);
	next.notes = [...next.notes, trimmed];
	return derivedState(next, optionScrollThreshold);
}

export function commitNote(state: GrillState, note: string, effects: AnswerBatchCommitEffects, optionScrollThreshold = DEFAULT_OPTION_SCROLL_THRESHOLD): GrillState {
	const next = applyNote(state, note, optionScrollThreshold);
	const error = validateState(next, state, new Set(), optionScrollThreshold);
	if (error) throw new Error(error);
	effects.write(next);
	effects.afterWrite?.(next);
	return next;
}

type QuestionPhase = "select" | "other" | "reason" | "note";

export function getInitialOptionIndex(question: Pick<GrillQuestion, "options" | "recommended" | "userChoice">): number {
	if (question.userChoice !== undefined) {
		const existing = question.options.findIndex((option) => option.label === question.userChoice);
		return existing >= 0 ? existing : question.options.length;
	}
	const recommended = question.recommended === undefined ? -1 : question.options.findIndex((option) => option.value === question.recommended);
	return recommended >= 0 ? recommended : 0;
}

function toAskQuestion(question: GrillQuestion): AskQuestion {
	return {
		id: question.id,
		section: question.section,
		question: question.question,
		context: question.context,
		options: question.options,
		recommended: question.recommended,
		recommendationReason: question.recommendationReason,
	};
}

type ResponsiveLayout = "columns" | "stacked";
type LayoutMetrics = { listWidth: number; answerMinWidth: number; gap: number };

export function chooseResponsiveLayout(width: number, metrics: LayoutMetrics, previous: ResponsiveLayout = "stacked"): ResponsiveLayout {
	const required = metrics.listWidth + metrics.answerMinWidth + metrics.gap;
	if (previous === "columns") return width >= required - LAYOUT_HYSTERESIS ? "columns" : "stacked";
	return width >= required + LAYOUT_HYSTERESIS ? "columns" : "stacked";
}

function padToWidth(value: string, width: number): string {
	const fitted = truncateToWidth(value, Math.max(0, width), "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

export function joinRenderedColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, gap: number): string[] {
	const lines: string[] = [];
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const leftLine = padToWidth(left[index] ?? "", leftWidth);
		const rightLine = truncateToWidth(right[index] ?? "", rightWidth, "");
		lines.push(`${leftLine}${" ".repeat(gap)}${rightLine}`);
	}
	return lines;
}

function contentLayoutMetrics(questions: AskQuestion[]): LayoutMetrics {
	const longestListItem = Math.max(18, ...questions.map((question) => visibleWidth(`${question.id} ${question.section}`) + 5));
	const longestAnswer = Math.max(36, ...questions.flatMap((question) => [question.question, ...question.options.map((option) => option.label)]).map(visibleWidth));
	return {
		listWidth: Math.min(34, longestListItem),
		answerMinWidth: Math.min(72, Math.max(36, Math.ceil(longestAnswer * 0.7))),
		gap: 3,
	};
}

function ensureAnswerEvents(runtime: Runtime, pi: ExtensionAPI): ReturnType<typeof createAnswerEventBatcher<AnswerEvent>> {
	if (runtime.answerEvents) return runtime.answerEvents;
	runtime.answerEvents = createAnswerEventBatcher<AnswerEvent>({
		schedule: (flush) => setTimeout(flush, 500),
		cancel: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
		send: (answers) => {
			const content = `${answers.map((answer) => `${answer.id}: ${answer.label}${answer.reason ? ` (reason: ${answer.reason})` : ""}`).join("\n")}\n\n${stateSummary(runtime.state)}`;
			pi.sendMessage({
				customType: "grill-answers",
				content,
				display: true,
				details: { answers, statePath: runtime.paths.json, state: runtime.state },
			}, { triggerTurn: true, deliverAs: "steer" });
		},
	});
	return runtime.answerEvents;
}

export function consumeConvergenceAnswer(
	pendingQuestionIds: Set<string>,
	answer: AskAnswer,
	canConvergeNow: boolean,
	keywords: readonly string[],
): boolean {
	if (!pendingQuestionIds.has(answer.id)) return false;
	// The id stays registered so a later re-answer with a converge keyword can still trigger confirmation.
	if (!canConvergeNow) return false;
	const pattern = new RegExp(keywords.map(escapeRegExp).join("|"), "i");
	return pattern.test(`${answer.value} ${answer.label}`);
}

type ConvergenceConfirmationEffects = {
	confirm: () => Promise<boolean>;
	onConfirmed: () => void;
	notify: (message: string) => void;
	refocus: () => void;
};

export async function runConvergenceConfirmation(effects: ConvergenceConfirmationEffects): Promise<void> {
	try {
		if (await effects.confirm()) effects.onConfirmed();
	} catch (error) {
		effects.notify(`grill convergence confirmation failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		effects.refocus();
	}
}

function maybeConfirmConvergence(runtime: Runtime, pi: ExtensionAPI, answer: AskAnswer, onSessionFinished?: (runtime: Runtime) => void): void {
	if (!consumeConvergenceAnswer(runtime.pendingConvergenceQuestionIds, answer, canConverge(runtime.state), runtime.config.convergeKeywords)) return;
	const generation = runtime.panel?.generation;
	let finished = false;
	runtime.panel?.handle?.unfocus();
	void runConvergenceConfirmation({
		confirm: () => runtime.context.ui.confirm("Write the plan?", "This interview has converged. Confirming lets the agent write the plan with write/edit and closes this panel. The JSON state file is kept."),
		onConfirmed: () => {
			finished = true;
			const statePath = runtime.paths.json;
			pi.sendUserMessage(planPrompt(runtime), runtime.context.isIdle() ? undefined : { deliverAs: "followUp" });
			onSessionFinished?.(runtime);
			notify(runtime.context, `grill interview converged; the panel is closed. State kept at ${statePath} — rerun /grill with the same description to resume, or delete it yourself.`, "info");
		},
		notify: (message) => notify(runtime.context, message, "error"),
		refocus: () => {
			if (finished) return;
			const panel = runtime.panel;
			if (runtime.closed || !panel || panel.generation !== generation) return;
			// The panel was hidden by the answer commit; a decline must bring it back, not focus a hidden overlay.
			panel.handle?.setHidden(false);
			panel.hidden = false;
			panel.handle?.focus?.();
			setWidget(runtime);
		},
	});
}

function commitPanelAnswer(runtime: Runtime, pi: ExtensionAPI, answer: AskAnswer, onSessionFinished?: (runtime: Runtime) => void): boolean {
	try {
		const next = commitAnswerBatch(runtime.state, [answer], {
			write: (state) => writeAtomic(runtime.paths.json, `${JSON.stringify(state, null, 2)}\n`),
			afterWrite: (state) => {
				renderHtml(runtime.paths, state);
				runtime.state = state;
				setWidget(runtime);
			},
		}, runtime.config.optionScrollThreshold);
		const committed = next.questions.find((question) => question.id === answer.id);
		ensureAnswerEvents(runtime, pi).enqueue({
			...answer,
			status: committed?.status ?? "answered",
		});
		maybeConfirmConvergence(runtime, pi, answer, onSessionFinished);
		hideRuntimePanel(runtime);
		return true;
	} catch (error) {
		notify(runtime.context, `grill failed to write the answer: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
}

function commitPanelSkip(runtime: Runtime, pi: ExtensionAPI, id: string): boolean {
	try {
		commitSkip(runtime.state, id, {
			write: (state) => writeAtomic(runtime.paths.json, `${JSON.stringify(state, null, 2)}\n`),
			afterWrite: (state) => {
				renderHtml(runtime.paths, state);
				runtime.state = state;
				setWidget(runtime);
			},
		}, runtime.config.optionScrollThreshold);
		runtime.pendingConvergenceQuestionIds.delete(id);
		ensureAnswerEvents(runtime, pi).enqueue({ id, value: "__skipped__", label: SKIP_STATUS_NOTE, index: 0, reason: "", status: "skipped" });
		hideRuntimePanel(runtime);
		return true;
	} catch (error) {
		notify(runtime.context, `grill failed to write the skip: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
}

function commitPanelNote(runtime: Runtime, pi: ExtensionAPI, note: string): boolean {
	try {
		const next = commitNote(runtime.state, note, {
			write: (state) => writeAtomic(runtime.paths.json, `${JSON.stringify(state, null, 2)}\n`),
			afterWrite: (state) => {
				renderHtml(runtime.paths, state);
				runtime.state = state;
				setWidget(runtime);
			},
		}, runtime.config.optionScrollThreshold);
		const latest = next.notes[next.notes.length - 1] ?? note.trim();
		pi.sendMessage({
			customType: "grill-note",
			content: `User note: ${latest}\n\n${stateSummary(next)}`,
			display: true,
			details: { note: latest, notes: next.notes, statePath: runtime.paths.json, state: next },
		}, { triggerTurn: true, deliverAs: "steer" });
		return true;
	} catch (error) {
		notify(runtime.context, `grill failed to write the note: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
}

function createPanelComponent(
	runtime: Runtime,
	pi: ExtensionAPI,
	tui: { requestRender(): void },
	theme: ExtensionContext["ui"]["theme"],
	controller: PanelController,
	onSessionFinished?: (runtime: Runtime) => void,
): Component & Focusable {
	let state = runtime.state;
	let rows = getLedgerRows(state);
	let selectedQuestionId: string | null = state.ui.selectedQuestionId && rows.some((row) => row.id === state.ui.selectedQuestionId)
		? state.ui.selectedQuestionId
		: rows.find((row) => row.status === "current")?.id ?? rows.find((row) => row.answerable)?.id ?? rows[0]?.id ?? null;
	let focusedPane = state.ui.focusedPane;
	let listScrollOffset = state.ui.listScrollOffset;
	let optionIndex = selectedQuestionId
		? state.ui.selectedOptionByQuestion[selectedQuestionId] ?? getInitialOptionIndex(state.questions.find((question) => question.id === selectedQuestionId)!)
		: 0;
	let optionScrollOffset = selectedQuestionId ? state.ui.optionScrollOffsetByQuestion[selectedQuestionId] ?? 0 : 0;
	let phase: QuestionPhase = "select";
	let pendingOption: GrillOption | undefined;
	let cached: string[] | undefined;
	let cachedWidth: number | undefined;
	let previousLayout: ResponsiveLayout = "stacked";
	let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
	let containerFocused = false;
	const textInput = new Input();
	textInput.focused = false;

	const currentQuestion = () => state.questions.find((question) => question.id === selectedQuestionId);
	const currentRow = () => rows.find((row) => row.id === selectedQuestionId);
	const optionsFor = (question: GrillQuestion) => [...question.options, { value: "__other__", label: "Something else (type it)" }];
	const refresh = () => {
		cached = undefined;
		cachedWidth = undefined;
		tui.requestRender();
	};
	const uiSnapshot = (): GrillUiState => ({
		focusedPane,
		selectedQuestionId,
		selectedOptionByQuestion: {
			...state.ui.selectedOptionByQuestion,
			...(selectedQuestionId && currentRow()?.answerable ? { [selectedQuestionId]: optionIndex } : {}),
		},
		optionScrollOffsetByQuestion: {
			...state.ui.optionScrollOffsetByQuestion,
			...(selectedQuestionId && currentRow()?.answerable ? { [selectedQuestionId]: optionScrollOffset } : {}),
		},
		listScrollOffset,
		activeSurface: selectedQuestionId ? "question" : "submit",
		revision: state.ui.revision,
	});
	const flushCheckpoint = () => {
		if (checkpointTimer) clearTimeout(checkpointTimer);
		checkpointTimer = undefined;
		if (!runtime.closed) persistUiCheckpoint(runtime, uiSnapshot());
		state = runtime.state;
	};
	const checkpoint = (debounced = false) => {
		if (!debounced) return flushCheckpoint();
		if (checkpointTimer) clearTimeout(checkpointTimer);
		checkpointTimer = setTimeout(flushCheckpoint, UI_CHECKPOINT_DEBOUNCE_MS);
	};
	const resetInput = () => {
		phase = "select";
		pendingOption = undefined;
		textInput.focused = false;
	};
	const selectRow = (index: number) => {
		if (rows.length === 0) {
			selectedQuestionId = null;
			return;
		}
		const clamped = Math.max(0, Math.min(rows.length - 1, index));
		resetInput();
		selectedQuestionId = rows[clamped]?.id ?? null;
		const question = currentQuestion();
		optionIndex = question ? state.ui.selectedOptionByQuestion[question.id] ?? getInitialOptionIndex(question) : 0;
		optionScrollOffset = question ? state.ui.optionScrollOffsetByQuestion[question.id] ?? 0 : 0;
		if (question) {
			const viewport = normalizeOptionViewport(optionIndex, optionScrollOffset, question.options.length + 1, runtime.config.optionScrollThreshold, question.options.length > runtime.config.optionScrollThreshold);
			optionIndex = viewport.selectedIndex;
			optionScrollOffset = viewport.offset;
		}
		if (clamped < listScrollOffset) listScrollOffset = clamped;
		if (clamped >= listScrollOffset + LIST_VIEW_SIZE) listScrollOffset = clamped - LIST_VIEW_SIZE + 1;
		checkpoint();
		refresh();
	};
	const moveToNextAnswerable = () => {
		const currentIndex = rows.findIndex((row) => row.id === selectedQuestionId);
		const isOpen = (row: LedgerRow) => row.status === "pending" || row.status === "current";
		const next = rows.slice(currentIndex + 1).find(isOpen) ?? rows.find(isOpen);
		if (next) selectRow(rows.findIndex((row) => row.id === next.id));
		else {
			resetInput();
			selectedQuestionId = null;
			focusedPane = "answer";
			checkpoint();
			refresh();
		}
	};
	const confirmAnswer = (question: GrillQuestion, option: GrillOption, reason: string) => {
		const answer: AskAnswer = { id: question.id, value: option.value, label: option.label, index: optionIndex + 1, other: option.value === "__other__", reason: reason.trim() };
		if (!commitPanelAnswer(runtime, pi, answer, onSessionFinished)) return;
		state = runtime.state;
		rows = getLedgerRows(state);
		resetInput();
		moveToNextAnswerable();
	};
	const wrap = (lines: string[], prefix: string, value: string, width: number) => {
		const prefixWidth = visibleWidth(prefix);
		wrapTextWithAnsi(value, Math.max(1, width - prefixWidth)).forEach((line, index) => lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`));
	};

	// A null selection is the terminal submit surface; it survives only while nothing is open.
	// Adopting an open question never changes panel visibility or focus.
	const adoptOpenQuestion = (): boolean => {
		const newlyOpen = rows.find((row) => row.status === "current") ?? rows.find((row) => row.status === "pending");
		selectedQuestionId = newlyOpen?.id ?? null;
		if (!newlyOpen) return false;
		resetInput();
		focusedPane = "answer";
		const question = state.questions.find((item) => item.id === newlyOpen.id);
		if (question) {
			const viewport = normalizeOptionViewport(
				state.ui.selectedOptionByQuestion[question.id] ?? getInitialOptionIndex(question),
				state.ui.optionScrollOffsetByQuestion[question.id] ?? 0,
				question.options.length + 1,
				runtime.config.optionScrollThreshold,
				question.options.length > runtime.config.optionScrollThreshold,
			);
			optionIndex = viewport.selectedIndex;
			optionScrollOffset = viewport.offset;
		}
		return true;
	};

	controller.refresh = (next) => {
		const previous = currentQuestion();
		const wasEditing = phase !== "select";
		state = next;
		rows = getLedgerRows(next);
		const updated = selectedQuestionId ? next.questions.find((question) => question.id === selectedQuestionId) : undefined;
		if (!updated) {
			if (selectedQuestionId) resetInput(); // the selected row vanished externally; its draft is void
			adoptOpenQuestion();
		} else if (wasEditing && previous && updated && updated.status !== "pending" && updated.status !== "current" && updated.status !== "removed") {
			resetInput();
			notify(runtime.context, `${updated.id} was changed externally to ${updated.status}; the local draft was discarded.`, "warning");
		}
		if (updated) {
			optionIndex = next.ui.selectedOptionByQuestion[updated.id] ?? optionIndex;
			optionScrollOffset = next.ui.optionScrollOffsetByQuestion[updated.id] ?? optionScrollOffset;
			const viewport = normalizeOptionViewport(optionIndex, optionScrollOffset, updated.options.length + 1, runtime.config.optionScrollThreshold, updated.options.length > runtime.config.optionScrollThreshold);
			optionIndex = viewport.selectedIndex;
			optionScrollOffset = viewport.offset;
		}
		refresh();
	};
	controller.revealCurrent = (id) => {
		const index = rows.findIndex((row) => row.id === id);
		if (index >= 0) selectRow(index);
	};
	controller.flushUiCheckpoint = flushCheckpoint;

	const hidePanel = () => {
		flushCheckpoint();
		controller.handle?.setHidden(true);
		controller.hidden = true;
		controller.handle?.unfocus();
		setWidget(runtime);
	};

	const handleInput = (data: string) => {
		if (matchesKey(data, Key.ctrl("c"))) {
			controller.handle?.unfocus();
			runtime.context.abort();
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			controller.handle?.unfocus();
			runtime.context.shutdown();
			return;
		}
		if (phase !== "select") {
			textInput.handleInput(data);
			refresh();
			return;
		}
		if (matchesKey(data, Key.ctrl("n"))) {
			phase = "note";
			textInput.focused = containerFocused;
			textInput.setValue("");
			textInput.onEscape = () => { resetInput(); refresh(); };
			textInput.onSubmit = (value) => {
				if (!value.trim()) return;
				if (!commitPanelNote(runtime, pi, value)) return;
				state = runtime.state;
				rows = getLedgerRows(state);
				resetInput();
				refresh();
			};
			refresh();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			const target = currentRow();
			if (!target || !target.answerable) return;
			if (!commitPanelSkip(runtime, pi, target.id)) return;
			state = runtime.state;
			rows = getLedgerRows(state);
			resetInput();
			moveToNextAnswerable();
			return;
		}
		const directLedgerKeys = [Key.ctrl("1"), Key.ctrl("2"), Key.ctrl("3"), Key.ctrl("4"), Key.ctrl("5"), Key.ctrl("6"), Key.ctrl("7"), Key.ctrl("8"), Key.ctrl("9"), Key.ctrl("0")];
		for (let ledgerIndex = 0; ledgerIndex < directLedgerKeys.length; ledgerIndex += 1) {
			if (!matchesKey(data, directLedgerKeys[ledgerIndex]!)) continue;
			if (ledgerIndex < rows.length) {
				selectRow(ledgerIndex);
				focusedPane = "answer";
				checkpoint();
				refresh();
			}
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			focusedPane = focusedPane === "questions" ? "answer" : "questions";
			checkpoint();
			refresh();
			return;
		}
		if (matchesKey(data, Key.left)) {
			const index = Math.max(0, rows.findIndex((row) => row.id === selectedQuestionId));
			selectRow(index - 1);
			focusedPane = "answer";
			checkpoint();
			refresh();
			return;
		}
		if (focusedPane === "questions") {
			const index = Math.max(0, rows.findIndex((row) => row.id === selectedQuestionId));
			if (matchesKey(data, Key.right)) {
				if (selectedQuestionId === null && rows.length > 0) selectRow(index);
				focusedPane = "answer";
				checkpoint();
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) selectRow(selectedQuestionId === null ? index : index - 1);
			else if (matchesKey(data, Key.down)) selectRow(selectedQuestionId === null ? index : index + 1);
			else if (matchesKey(data, Key.enter)) {
				if (selectedQuestionId === null && rows.length > 0) selectRow(index);
				focusedPane = "answer";
				checkpoint();
				refresh();
			}
			else if (matchesKey(data, Key.escape)) hidePanel();
			return;
		}
		const row = currentRow();
		const question = currentQuestion();
		if (!row || !question || !row.answerable) {
			if (matchesKey(data, Key.escape)) hidePanel();
			return;
		}
		const options = optionsFor(question);
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			optionIndex = matchesKey(data, Key.up) ? Math.max(0, optionIndex - 1) : Math.min(options.length - 1, optionIndex + 1);
			const viewport = normalizeOptionViewport(optionIndex, optionScrollOffset, options.length, runtime.config.optionScrollThreshold, question.options.length > runtime.config.optionScrollThreshold);
			optionIndex = viewport.selectedIndex;
			optionScrollOffset = viewport.offset;
			checkpoint(true);
			refresh();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			const option = options[optionIndex];
			if (option.value === "__other__") {
				phase = "other";
				textInput.focused = containerFocused;
				textInput.setValue("");
				textInput.onEscape = () => { resetInput(); refresh(); };
				textInput.onSubmit = (value) => {
					if (!value.trim()) return;
					confirmAnswer(question, { value: "__other__", label: value.trim() }, "");
				};
			} else if (option.requiresText === true) {
				pendingOption = option;
				phase = "reason";
				textInput.focused = containerFocused;
				textInput.setValue("");
				textInput.onSubmit = (reasonValue) => {
					if (!reasonValue.trim()) return;
					confirmAnswer(question, option, reasonValue);
				};
				textInput.onEscape = () => { resetInput(); refresh(); };
			} else {
				confirmAnswer(question, option, "");
			}
			refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) hidePanel();
	};

	const renderList = (width: number) => {
		const lines = [focusedPane === "questions" ? theme.fg("accent", "Questions ◀") : theme.fg("muted", "Questions")];
		const maxOffset = Math.max(0, rows.length - LIST_VIEW_SIZE);
		listScrollOffset = Math.min(maxOffset, Math.max(0, listScrollOffset));
		for (const row of rows.slice(listScrollOffset, listScrollOffset + LIST_VIEW_SIZE)) {
			const selected = row.id === selectedQuestionId;
			const marker = row.status === "answered" ? "■" : row.status === "skipped" ? "↷" : row.status === "deprecated" ? "△" : row.status === "removed" ? "✕" : "□";
			const label = `${selected ? ">" : " "} ${marker} ${row.id} ${row.section}`;
			lines.push(truncateToWidth(selected ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(row.answerable ? "muted" : "dim", label), width, ""));
		}
		if (rows.length > LIST_VIEW_SIZE) lines.push(theme.fg("dim", `${listScrollOffset + 1}-${Math.min(rows.length, listScrollOffset + LIST_VIEW_SIZE)} / ${rows.length}`));
		return lines;
	};
	const renderAnswer = (width: number) => {
		const lines = [focusedPane === "answer" ? theme.fg("accent", "Answer ◀") : theme.fg("muted", "Answer")];
		const row = currentRow();
		const question = currentQuestion();
		if (!row || !question) {
			if (rows.length > 0 && !rows.some((candidate) => candidate.status === "pending" || candidate.status === "current")) {
				return [
					...lines,
					theme.fg("success", "All questions handled"),
					theme.fg("dim", "Read-only summary"),
					`Answered ${state.answeredCount} / active ${state.validQuestionCount} (skipped ${state.questions.filter((item) => item.status === "skipped").length} · notes ${state.notes.length})`,
					theme.fg("muted", "Use Ctrl+1…Ctrl+9 / Ctrl+0, or pick a row in the list, to re-answer a confirmed or skipped question."),
				];
			}
			if (rows.length === 0) return [...lines, theme.fg("dim", "No questions yet")];
			return [...lines, theme.fg("dim", "No question selected · ← or Ctrl+1…Ctrl+0 to pick one")];
		}
		wrap(lines, "", theme.fg("text", question.question), width);
		if (question.context?.trim()) {
			lines.push("");
			wrap(lines, "", theme.fg("muted", question.context), width);
		}
		lines.push("");
		if (!row.answerable) {
			wrap(lines, "", theme.fg("dim", `Status: ${row.status} (read-only)`), width);
			if (row.choice) wrap(lines, "", theme.fg("success", `Answer: ${row.choice}`), width);
			if (row.reason) wrap(lines, "", `Reason: ${row.reason}`, width);
			if (row.statusNote) wrap(lines, "", theme.fg("warning", `Status note: ${row.statusNote}`), width);
			return lines;
		}
		if (phase === "select") {
			const allOptions = optionsFor(question);
			const scrollEnabled = question.options.length > runtime.config.optionScrollThreshold;
			const viewport = normalizeOptionViewport(optionIndex, optionScrollOffset, allOptions.length, runtime.config.optionScrollThreshold, scrollEnabled);
			optionIndex = viewport.selectedIndex;
			optionScrollOffset = viewport.offset;
			const visibleOptions = scrollEnabled
				? allOptions.slice(optionScrollOffset, optionScrollOffset + runtime.config.optionScrollThreshold)
				: allOptions;
			visibleOptions.forEach((option, visibleIndex) => {
				const index = scrollEnabled ? optionScrollOffset + visibleIndex : visibleIndex;
				const selected = index === optionIndex;
				wrap(lines, selected ? theme.fg("accent", "> ") : "  ", theme.fg(selected ? "accent" : "text", `${index + 1}. ${option.label}${option.value === question.recommended ? " · recommended" : ""}${option.requiresText === true ? " · needs detail" : ""}`), width);
				if (option.description) wrap(lines, "    ", theme.fg("muted", option.description), width);
				const recommendationReason = option.recommendationReason ?? (option.value === question.recommended ? question.recommendationReason : undefined);
				if (recommendationReason) wrap(lines, "    ", theme.fg("muted", `Why recommended: ${recommendationReason}`), width);
			});
			if (scrollEnabled) lines.push(theme.fg("dim", `showing ${optionScrollOffset + 1}–${Math.min(allOptions.length, optionScrollOffset + runtime.config.optionScrollThreshold)} of ${allOptions.length} · ↑↓ scroll`));
		} else {
			wrap(lines, "", theme.fg("accent", phase === "note" ? "Note for the agent (not tied to a question):" : phase === "other" ? "Type your own answer (required):" : `Add detail (required) · choice: ${pendingOption?.label ?? ""}`), width);
			textInput.render(width).forEach((line) => lines.push(truncateToWidth(line, width, "")));
		}
		return lines;
	};

	return {
		get focused() { return containerFocused; },
		set focused(value: boolean) { containerFocused = value; textInput.focused = value && phase !== "select"; },
		render(width: number) {
			if (cached && cachedWidth === width) return cached;
			const renderWidth = Math.max(1, width);
			const metrics = contentLayoutMetrics(state.questions.map(toAskQuestion));
			previousLayout = chooseResponsiveLayout(renderWidth, metrics, previousLayout);
			const lines = [theme.fg("accent", "─".repeat(renderWidth)), theme.fg("dim", `grill · answered ${state.answeredCount}/${state.validQuestionCount} · ledger ${rows.length}`), ""];
			if (previousLayout === "columns") {
				const leftWidth = Math.min(metrics.listWidth, Math.max(18, renderWidth - metrics.answerMinWidth - metrics.gap));
				const rightWidth = Math.max(1, renderWidth - leftWidth - metrics.gap);
				lines.push(...joinRenderedColumns(renderList(leftWidth), renderAnswer(rightWidth), leftWidth, rightWidth, metrics.gap));
			} else {
				lines.push(...renderList(renderWidth), theme.fg("borderMuted", "─".repeat(renderWidth)), ...renderAnswer(renderWidth));
			}
			lines.push("", theme.fg("dim", phase !== "select" ? "Type · Enter confirm · Esc back" : focusedPane === "questions" ? "↑↓ browse · Enter/→ answer · Ctrl+S skip · Ctrl+N note · Esc hide" : "↑↓ select · Enter submit · Ctrl+S skip · Ctrl+N note · ←/Tab panes · Esc hide"), theme.fg("accent", "─".repeat(renderWidth)));
			cached = lines.map((line) => truncateToWidth(line, renderWidth, ""));
			cachedWidth = width;
			return cached;
		},
		handleInput,
		invalidate: refresh,
	};
}

function hideRuntimePanel(runtime: Runtime): void {
	const panel = runtime.panel;
	if (!panel) return;
	panel.handle?.setHidden(true);
	panel.handle?.unfocus();
	panel.hidden = true;
	setWidget(runtime);
}

function revealPanelCurrent(runtime: Runtime, id: string): void {
	runtime.panel?.revealCurrent?.(id);
}

function openOrFocusPanel(runtime: Runtime, context: ExtensionContext, pi: ExtensionAPI, onSessionFinished?: (runtime: Runtime) => void): void {
	if (runtime.panel) {
		runtime.panel.handle?.setHidden(false);
		runtime.panel.refresh?.(runtime.state);
		runtime.panel.handle?.focus?.();
		runtime.panel.hidden = false;
		setWidget(runtime);
		return;
	}
	const generation = ++runtime.panelGeneration;
	const controller: PanelController = { generation, hidden: false, promise: Promise.resolve() };
	runtime.panel = controller;
	const promise = context.ui.custom<void>((tui, theme, _keybindings, done) => {
		controller.finish = () => done(undefined);
		const component = createPanelComponent(runtime, pi, tui, theme, controller, onSessionFinished);
		return {
			...component,
			dispose() {
				controller.flushUiCheckpoint?.();
				component.invalidate();
			},
		};
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", minWidth: 44 },
		onHandle: (handle) => {
			if (runtime.panel?.generation !== generation) {
				handle.hide();
				return;
			}
			controller.handle = handle;
			handle.setHidden(false);
			handle.focus?.();
			controller.hidden = false;
			setWidget(runtime);
		},
	});
	controller.promise = promise;
	void promise.catch((error) => {
		if (!runtime.closed) notify(context, `grill panel closed unexpectedly: ${error instanceof Error ? error.message : String(error)}`, "error");
	}).finally(() => {
		if (runtime.panel?.generation === generation) runtime.panel = undefined;
	});
}

function activeRuntime(runtimes: Map<string, Runtime>, cwd: string): Runtime | undefined {
	return [...runtimes.values()].reverse().find((runtime) => runtime.cwd === cwd && !runtime.closed);
}

function buildInterviewPrompt(runtime: Runtime): string {
	return `You are running a /grill design interview inside pi.

Hard constraints:
- Initial idea: ${runtime.state.content}
- Single source of truth (JSON): ${runtime.paths.json}
- External HTML mirror: ${runtime.paths.html}
- Every grill_ask result carries the latest state summary (section index + open questions). Use it to continue; only read the full JSON when auditing deprecated/removed history or right before writing the plan.
- You may edit the JSON with the built-in write tool, but you must preserve schemaVersion, questions, notes, ui, and the status machine. \`ui\` is required recoverable TUI state. The wording and options of answered questions are immutable. Invalid JSON is rejected by the extension.
- Always use grill_ask to ask the user; never substitute plain text for the interactive panel. Publish every decision whose dependencies are already resolved in one batch instead of waiting question by question.
- Ask dependency-first: look up facts yourself (codebase, files, tools) and only put real decisions to the user. Every question must carry a recommended option and the reasoning behind it. Ask downstream questions only after their upstream decision is settled.
- \`section\` is a free-form grouping label used only to index questions. Never ask a question just to fill a section or reach a question count, and never split one decision across several questions.
- Generate the final plan's body headings freely from substantive content. There is no fixed heading pool, required order, minimum section count, or N/A placeholders.
- If the environment offers reusable multi-agent or subagent capabilities, use them to check facts; otherwise verify synchronously before moving on.
- In the panel the user can press Ctrl+S to skip a question (status becomes \`skipped\`; it does not block convergence and stays re-answerable) and Ctrl+N to send a note that is not tied to any question. When you receive a skip or a note, decide whether to ask a better question or change direction instead of repeating the same one.
- Convergence is dependency-driven: once there are no pending/current questions and no unresolved dependencies, use grill_ask with converge=true to ask the final "write the plan?" question. Only write the plan with write/edit after the user confirms.
- The final "## Interview transcript" section is always required and must be the final level-2 heading.
- Do not implement literal HTML or a browser bridge. The pi surface is a custom CLI/TUI; the HTML file is only a JSON-driven mirror.

${stateSummary(runtime.state)}`;
}

function planDirectory(cwd: string): string {
	const candidates = [path.join(cwd, "docs", "plans"), path.join(cwd, "plans")];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function planPrompt(runtime: Runtime): string {
	return `The user confirmed convergence. Use the built-in write/edit tools to write the final plan.

JSON state source: ${runtime.paths.json}
Target directory: ${planDirectory(runtime.cwd)} (first existing of docs/plans/ then plans/; create docs/plans/ if neither exists; do not write anywhere else)
File name: <project>-<YYYYMMDD>-<short-topic>.md
Choose the body's level-2 headings and their order freely from substantive content in the interview and verified repository facts. Do not use a fixed heading pool, require a minimum section count, add empty sections, or write N/A placeholders. Regardless of which body headings are chosen, always append a final "## Interview transcript" heading.
The transcript must preserve every question in the JSON \`questions\` array, including answered, skipped, deprecated and removed, recording at least id, status, question, options, recommendation, the user's choice, the reason and the status note. If \`notes\` is non-empty, list every user note at the end of the transcript. Do not omit, rewrite or fabricate anything. After writing, read the file back and confirm every question id is present, and confirm "## Interview transcript" is the final level-2 heading.`;
}

export function canConverge(state: GrillState): boolean {
	return !state.questions.some((question) => question.status === "pending" || question.status === "current");
}

function stateSummary(state: GrillState): string {
	const index = deriveSectionIndex(state);
	const sectionKeys = Object.keys(index);
	const sections = sectionKeys.length
		? sectionKeys.map((key) => `- ${key}: ${index[key].map((entry) => `${entry.id}[${entry.status}]`).join(", ")}`).join("\n")
		: "(no questions yet)";
	const open = state.questions.filter((question) => question.status === "pending" || question.status === "current");
	const openList = open.length
		? open.map((question) => `- [${question.status}] ${question.id} (${question.section}): ${question.question}`).join("\n")
		: "(no pending/current questions)";
	const skipped = state.questions.filter((question) => question.status === "skipped");
	const skippedLine = skipped.length ? `\n\nSkipped (user chose to skip; does not block convergence; still re-answerable):\n${skipped.map((question) => `- ${question.id} (${question.section}): ${question.question}`).join("\n")}` : "";
	const notesLine = state.notes.length ? `\n\nUser notes (not tied to a question):\n${state.notes.map((note) => `- ${note}`).join("\n")}` : "";
	return `State summary (answered ${state.answeredCount} / active ${state.validQuestionCount}). This summary is the latest state; you normally do not need to read the JSON.\n\nSection index:\n${sections}\n\nOpen questions:\n${openList}${skippedLine}${notesLine}`;
}

export default function grillExtension(pi: ExtensionAPI): void {
	const runtimes = new Map<string, Runtime>();
	const finishSession = (runtime: Runtime) => {
		closeRuntime(runtime);
		runtimes.delete(runtime.paths.json);
	};

	pi.registerTool({
		name: "grill_ask",
		label: "Grill Ask",
		description: "Ask one or more design interview questions in a responsive Pi CLI/TUI panel and persist the answers to the active grill JSON state.",
		parameters: GrillAskParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			if (context.mode !== "tui") throw new Error("grill_ask requires Pi TUI mode");
			const runtime = activeRuntime(runtimes, context.cwd);
			if (!runtime) throw new Error("No active /grill session for this working directory");
			const questions = params.questions as AskQuestion[];
			addQuestions(runtime, questions);
			const currentQuestionId = questions[0]!.id;
			if (params.converge === true) for (const question of questions) runtime.pendingConvergenceQuestionIds.add(question.id);
			openOrFocusPanel(runtime, context, pi, finishSession);
			revealPanelCurrent(runtime, currentQuestionId);
			const publishedQuestionIds = questions.map((question) => question.id);
			return {
				content: [{ type: "text", text: `Published ${publishedQuestionIds.length} question(s) asynchronously; the grill panel is open. The agent does not wait for the user.\n\n${stateSummary(runtime.state)}` }],
				details: { publishedQuestionIds, statePath: runtime.paths.json, state: runtime.state },
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("grill_ask ")) + theme.fg("muted", `${count} question(s)`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("success", text?.type === "text" ? text.text : "grill question complete"), 0, 0);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("g"), {
		description: "Toggle the active Grill panel",
		handler: async (context) => {
			if (context.mode !== "tui") return;
			const runtime = activeRuntime(runtimes, context.cwd);
			if (!runtime) {
				notify(context, "No active /grill session in this directory.", "warning");
				return;
			}
			if (runtime.panel && !runtime.panel.hidden) {
				hideRuntimePanel(runtime);
				return;
			}
			openOrFocusPanel(runtime, context, pi, finishSession);
		},
	});

	pi.registerCommand("grill-panel", {
		description: "Open or focus the active asynchronous grill panel",
		handler: async (_args, context) => {
			if (context.mode !== "tui") return;
			const runtime = activeRuntime(runtimes, context.cwd);
			if (!runtime) {
				notify(context, "No active /grill session in this directory.", "warning");
				return;
			}
			openOrFocusPanel(runtime, context, pi, finishSession);
		},
	});

	pi.registerCommand("grill", {
		description: "Run a multi-round design interview with a JSON state source and Pi CLI/TUI panel",
		handler: async (args, context) => {
			if (context.mode !== "tui") {
				if (context.hasUI) context.ui.notify("/grill requires pi TUI mode.", "error");
				else throw new Error("/grill requires Pi TUI mode");
				return;
			}
			const content = args.trim() || (await context.ui.input("Describe the feature or idea you want to design", "e.g. port a command to a pi extension"))?.trim();
			if (!content) return;
			const paths = sessionPaths(context.cwd, content);
			fs.mkdirSync(paths.directory, { recursive: true });
			const config = loadGrillConfig(context);
			let state: GrillState;
			if (fs.existsSync(paths.json)) {
				try {
					const raw = JSON.parse(fs.readFileSync(paths.json, "utf8")) as { schemaVersion?: unknown };
					state = migrateState(raw);
					const normalizedUi = normalizeUiState(state, config.optionScrollThreshold);
					if (stableJson(normalizedUi) !== stableJson(state.ui)) state = { ...state, ui: normalizedUi };
					const error = validateState(state, undefined, new Set(), config.optionScrollThreshold);
					if (error) throw new Error(`${error}; delete or repair the state file, then start again`);
				} catch (error) {
					notify(context, `Existing grill JSON could not be restored; the file was kept at ${paths.json}: ${error instanceof Error ? error.message : String(error)}. Delete or repair it, then start again.`, "error");
					return;
				}
				const choice = await context.ui.select(`Found saved progress: ${state.answeredCount} answered`, ["Resume", "Discard and restart", "Cancel"]);
				if (choice === "Cancel" || !choice) return;
				if (choice === "Discard and restart") state = initialState(content, context.cwd);
			} else {
				state = initialState(content, context.cwd);
			}
			const next = derivedState(state, config.optionScrollThreshold);
			const error = validateState(next, undefined, new Set(), config.optionScrollThreshold);
			if (error) throw new Error(error);
			writeAtomic(paths.json, `${JSON.stringify(next, null, 2)}\n`);
			const oldRuntime = runtimes.get(paths.json);
			if (oldRuntime) closeRuntime(oldRuntime);
			const runtime = startRuntime(paths, context.cwd, context, next, config);
			runtimes.delete(paths.json); // re-insert so activeRuntime sees this as the latest session for the cwd
			runtimes.set(paths.json, runtime);
			renderHtml(paths, next);
			setWidget(runtime);
			notify(context, `grill state started: ${paths.json}`, "info");
			pi.sendUserMessage(buildInterviewPrompt(runtime), context.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	pi.on("session_shutdown", async () => {
		for (const runtime of runtimes.values()) closeRuntime(runtime);
		runtimes.clear();
	});
}
