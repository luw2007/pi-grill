import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { defaultGrillConfig, type AskQuestion, type GrillState, initialState } from "../src/state.ts";
import { GrillRuntime, type GrillRuntimeDeps } from "../src/runtime.ts";
import { registerGrillRoutes, type GrillRouteDeps, type GrillRouter } from "../src/routes.ts";

type Route = { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> };

function fakeCtx(): { ctx: Context; routes: Route[] } {
	const routes: Route[] = [];
	const ctx = {
		webServer: {
			register: (route: Route) => {
				routes.push(route);
				return () => {
					const index = routes.indexOf(route);
					if (index >= 0) routes.splice(index, 1);
				};
			},
		},
	} as unknown as Context;
	return { ctx, routes };
}

type FakeRes = {
	status: number;
	body: unknown;
	text: string;
	closed: boolean;
	writeHead(status: number, headers: Record<string, string>): void;
	write(chunk: string): void;
	end(chunk?: string): void;
	on(_event: string, _cb: () => void): void;
};

function fakeRes(): FakeRes {
	const res: FakeRes = {
		status: 200,
		body: null,
		text: "",
		closed: false,
		writeHead(status: number) { res.status = status; },
		write(chunk: string) { res.text += chunk; },
		end(chunk?: string) { if (chunk !== undefined) res.text += chunk; res.closed = true; },
		on() {},
	};
	return res;
}

function post(body: unknown): PassThrough {
	const stream = new PassThrough();
	stream.end(JSON.stringify(body));
	return stream;
}

function setup(): ReturnType<typeof setupInner> {
	return setupInner(mkdtempSync(join(tmpdir(), "grill-routes-")));
}

function setupInner(dir: string): {
	routes: Route[];
	runtime: GrillRuntime;
	deps: GrillRouteDeps;
	router: GrillRouter;
	states: Map<string, GrillState>;
	cleanup(): void;
} {
	const { ctx, routes } = fakeCtx();
	const states = new Map<string, GrillState>();
	let runtime: GrillRuntime;
	const deps: GrillRouteDeps = {
		getRuntime: (sessionId: string) => (sessionId === "agent-1" ? runtime : undefined),
		sessions: () => [{ sessionId: "agent-1", cwd: "/work", state: runtime.state }],
	};
	const router = registerGrillRoutes(ctx, deps);
	runtime = new GrillRuntime("agent-1", "/work", "topic", {
		agents: { get: () => undefined },
		config: { ...defaultGrillConfig(), directory: dir },
		logger: { warn: () => {} },
		broadcast: (sessionId: string) => router.broadcast(sessionId),
	});
	return {
		routes,
		runtime,
		deps,
		router,
		states,
		cleanup: () => {
			router.dispose();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const route = (routes: Route[], path: string): Route => {
	const found = routes.find((r) => r.path === path);
	if (!found) throw new Error("route not found: " + path);
	return found;
};

const q = (id: string): AskQuestion => ({
	id,
	section: "Scope",
	question: "Q " + id,
	options: [{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }],
	recommended: "a",
});

describe("grill routes", () => {
	it("registers all five routes", () => {
		const { routes, router, cleanup } = setup();
		expect(routes.map((r) => r.path).sort()).toEqual([
			"/grill/answer",
			"/grill/events",
			"/grill/note",
			"/grill/skip",
			"/grill/state",
		]);
			router.dispose();
		expect(routes.length).toBe(0);
	});

	it("GET /grill/state returns the session snapshot", () => {
		const { routes, runtime, router, cleanup } = setup();
		runtime.start("topic");
		const res = fakeRes();
		route(routes, "/grill/state").handler({}, res);
		const parsed = JSON.parse(res.text) as { sessions: { sessionId: string }[] };
		expect(parsed.sessions[0]!.sessionId).toBe("agent-1");
			router.dispose();
	});

	it("POST /grill/answer commits and answers", async () => {
		const { routes, runtime, router, cleanup } = setup();
		runtime.start("topic");
		runtime.publish([q("one")], false);
		const res = fakeRes();
		await route(routes, "/grill/answer").handler(post({
			sessionId: "agent-1",
			questionId: "one",
			value: "a",
			label: "Option A",
			reason: "fast",
		}), res);
		const parsed = JSON.parse(res.text) as { ok: boolean };
		expect(parsed.ok).toBe(true);
		expect(runtime.state.questions[0]!.status).toBe("answered");
		expect(runtime.state.questions[0]!.reason).toBe("fast");
			router.dispose();
	});

	it("POST /grill/skip and /grill/note", async () => {
		const { routes, runtime, router, cleanup } = setup();
		runtime.start("topic");
		runtime.publish([q("one")], false);
		let res = fakeRes();
		await route(routes, "/grill/skip").handler(post({ sessionId: "agent-1", questionId: "one" }), res);
		expect(JSON.parse(res.text) as { ok: boolean }).toEqual({ ok: true });
		expect(runtime.state.questions[0]!.status).toBe("skipped");
		res = fakeRes();
		await route(routes, "/grill/note").handler(post({ sessionId: "agent-1", text: "note it" }), res);
		expect(JSON.parse(res.text) as { ok: boolean }).toEqual({ ok: true });
		expect(runtime.state.notes).toEqual(["note it"]);
			router.dispose();
	});

	it("unknown session and bad bodies are rejected with 400", async () => {
		const { routes, router, cleanup } = setup();
		let res = fakeRes();
		await route(routes, "/grill/answer").handler(post({ sessionId: "nope", questionId: "one", value: "a", label: "A" }), res);
		expect(res.status).toBe(400);
		expect((JSON.parse(res.text) as { ok: boolean }).ok).toBe(false);
		res = fakeRes();
		await route(routes, "/grill/skip").handler(post({ sessionId: "agent-1" }), res);
		expect(res.status).toBe(400);
			router.dispose();
	});

	it("SSE broadcasts change events to connected clients", async () => {
		const { routes, runtime, router, cleanup } = setup();
		runtime.start("topic");
		const res = fakeRes();
		route(routes, "/grill/events").handler({}, res);
		expect(res.text).toContain(": connected");
		runtime.publish([q("one")], false);
		expect(res.text).toContain("event: change");
		expect(res.text).toContain("\"sessionId\":\"agent-1\"");
			router.dispose();
		expect(res.closed).toBe(true);
	});
});