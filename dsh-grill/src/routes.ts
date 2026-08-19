/**
 * The /grill HTTP + SSE surface: state snapshot, panel actions, and change
 * notifications. Host is authoritative; the web panel re-reads state after
 * every change event (pull model).
 * @module dsh-grill/routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { GrillState } from "./state.ts";
import type { GrillRuntime } from "./runtime.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 30_000;

export type GrillSessionView = {
	sessionId: string;
	cwd: string;
	state: GrillState;
};

export type GrillRouteDeps = {
	getRuntime(sessionId: string): GrillRuntime | undefined;
	/** Every live interview, newest first (for the frame-wide panel). */
	sessions(): GrillSessionView[];
};

export type GrillRouter = {
	/** Notify every connected panel that one session changed. */
	broadcast(sessionId: string): void;
	/** Unregister routes and close event streams. */
	dispose(): void;
};

type PanelBody = Record<string, unknown>;

function readBody(req: IncomingMessage): Promise<PanelBody> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) { resolve({}); return; }
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(typeof parsed === "object" && parsed !== null ? parsed as PanelBody : {});
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function respond(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(text);
}

function requireString(body: PanelBody, key: string): string | undefined {
	const value = body[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function requireStringArray(body: PanelBody, key: string): string[] | undefined {
	const value = body[key];
	if (!Array.isArray(value)) return undefined;
	if (!value.every((item) => typeof item === "string" && item.trim().length > 0)) return undefined;
	return value as string[];
}

export function registerGrillRoutes(ctx: Context, deps: GrillRouteDeps): GrillRouter {
	const clients = new Set<ServerResponse>();
	const disposers: Array<() => void> = [];

	const broadcast = (sessionId: string): void => {
		const payload = "event: change\ndata: " + JSON.stringify({ sessionId }) + "\n\n";
		for (const client of clients) {
			try { client.write(payload); } catch { clients.delete(client); }
		}
	};

	const heartbeat = setInterval(() => {
		if (clients.size === 0) return;
		for (const client of clients) {
			try { client.write(": ping\n\n"); } catch { clients.delete(client); }
		}
	}, HEARTBEAT_MS);
	disposers.push(() => clearInterval(heartbeat));

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/grill/state",
		handler: (_req, res) => {
			respond(res, 200, { sessions: deps.sessions() });
		},
	}));

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/grill/events",
		handler: (_req, res) => {
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(": connected\n\n");
			clients.add(res);
			res.on("close", () => { clients.delete(res); });
			res.on("error", () => { clients.delete(res); });
		},
	}));

	const handlePanelAction = async (req: IncomingMessage, res: ServerResponse, run: (sessionId: string, body: PanelBody) => { ok: boolean; message?: string }): Promise<void> => {
		try {
			const body = await readBody(req);
			const sessionId = requireString(body, "sessionId");
			if (!sessionId) { respond(res, 400, { ok: false, message: "sessionId is required" }); return; }
			const result = run(sessionId, body);
			if (result.ok) { respond(res, 200, { ok: true }); return; }
			respond(res, 400, { ok: false, message: result.message ?? "action failed" });
		} catch (error) {
			respond(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	};

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/grill/answer",
		handler: (req, res) => handlePanelAction(req, res, (sessionId, body) => {
			const runtime = deps.getRuntime(sessionId);
			if (!runtime) return { ok: false, message: "no interview for this session" };
			const questionId = requireString(body, "questionId");
			const value = requireString(body, "value");
			const label = requireString(body, "label");
			if (!questionId || !value || !label) return { ok: false, message: "questionId, value and label are required" };
			const reason = typeof body.reason === "string" ? body.reason : "";
			const other = body.other === true;
			const refine = body.refine === true;
			const index = typeof body.index === "number" ? body.index : 0;
			return runtime.answer({ id: questionId, value, label, index, other, reason }, refine);
		}),
	}));

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/grill/skip",
		handler: (req, res) => handlePanelAction(req, res, (sessionId, body) => {
			const runtime = deps.getRuntime(sessionId);
			if (!runtime) return { ok: false, message: "no interview for this session" };
			const questionId = requireString(body, "questionId");
			if (!questionId) return { ok: false, message: "questionId is required" };
			return runtime.skip(questionId);
		}),
	}));

	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/grill/note",
		handler: (req, res) => handlePanelAction(req, res, (sessionId, body) => {
			const runtime = deps.getRuntime(sessionId);
			if (!runtime) return { ok: false, message: "no interview for this session" };
			const text = requireString(body, "text");
			if (!text) return { ok: false, message: "text is required" };
			return runtime.note(text);
		}),
	}));

	const dispose = (): void => {
		for (const client of clients) { try { client.end(); } catch { /* ignore */ } }
		clients.clear();
		for (const disposer of disposers) disposer();
	};
	return { broadcast, dispose };
}

export type { IncomingMessage, ServerResponse };