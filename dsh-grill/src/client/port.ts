/**
 * Browser-side RPC seam for the grill panel: state fetch, SSE change
 * subscription, and the four panel actions. Host is authoritative.
 * @module dsh-grill/client/port
 */

export type GrillOptionView = {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
	recommendationReason?: string;
	requiresText?: boolean;
};

export type GrillQuestionView = {
	id: string;
	section: string;
	status: "pending" | "current" | "answered" | "skipped" | "deprecated" | "removed";
	question: string;
	context?: string;
	options: GrillOptionView[];
	recommended?: string;
	recommendationReason?: string;
	userChoice?: string;
	reason?: string;
	statusNote?: string;
};

export type GrillStateView = {
	schemaVersion: number;
	content: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	questions: GrillQuestionView[];
	notes: string[];
	currentQuestionId: string | null;
	answeredCount: number;
	validQuestionCount: number;
};

export type GrillSessionView = {
	sessionId: string;
	cwd: string;
	state: GrillStateView;
};

export type GrillWireState = { sessions: GrillSessionView[] };

export type GrillActionResult = { ok: boolean; message?: string };

export interface GrillPort {
	getState(): Promise<GrillWireState>;
	subscribe(listener: () => void): () => void;
	answer(sessionId: string, questionId: string, answer: { value: string; label: string; index: number; other: boolean; reason: string }, refine: boolean): Promise<GrillActionResult>;
	skip(sessionId: string, questionId: string): Promise<GrillActionResult>;
	note(sessionId: string, text: string): Promise<GrillActionResult>;
}

async function post(path: string, body: unknown): Promise<GrillActionResult> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data: unknown = await response.json().catch(() => null);
	if (typeof data === "object" && data !== null && "ok" in data) {
		return data as GrillActionResult;
	}
	return { ok: false, message: "unexpected server response" };
}

export function createGrillPort(): GrillPort {
	const listeners = new Set<() => void>();
	let source: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const notify = (): void => {
		for (const listener of [...listeners]) {
			try { listener(); } catch { /* one bad listener must not break the rest */ }
		}
	};

	const connect = (): void => {
		if (disposed) return;
		source = new EventSource("/grill/events");
		source.addEventListener("change", () => notify());
		source.onerror = () => {
			source?.close();
			source = null;
			if (!disposed) reconnectTimer = setTimeout(connect, 2000);
		};
	};
	connect();

	return {
		getState: async () => {
			const response = await fetch("/grill/state");
			if (!response.ok) throw new Error("grill state fetch failed: " + response.status);
			return (await response.json()) as GrillWireState;
		},
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		answer: (sessionId, questionId, answer, refine) =>
			post("/grill/answer", { sessionId, questionId, ...answer, refine }),
		skip: (sessionId, questionId) => post("/grill/skip", { sessionId, questionId }),
		note: (sessionId, text) => post("/grill/note", { sessionId, text }),
	};
}