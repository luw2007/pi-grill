/**
 * dsh-grill host half: registers the grill_ask tool, the /grill command, the
 * /grill HTTP+SSE routes, and owns the per-agent interview runtimes.
 * @module dsh-grill
 */

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { DEFAULT_CONVERGE_KEYWORDS, type GrillConfig } from "./state.ts";
import { GrillRuntime, type AgentsService, type GrillRuntimeDeps } from "./runtime.ts";
import { registerGrillTool } from "./tool.ts";
import { grillCommandDefinition } from "./command.ts";
import { registerGrillRoutes, type GrillSessionView } from "./routes.ts";

export const name = "dsh-grill";

export interface Config {
	directory: string;
	convergeKeywords: string[];
}

export const Config = Schema.object({
	directory: Schema.string().default(".dsh-grill"),
	convergeKeywords: Schema.array(Schema.string()).default([...DEFAULT_CONVERGE_KEYWORDS]),
});

export const inject = ["agents", "tools", "commands", "webServer"];

export function apply(ctx: Context, config: Config): void {
	const grillConfig: GrillConfig = { directory: config.directory, convergeKeywords: config.convergeKeywords };
	const runtimes = new Map<string, GrillRuntime>();
	const agents = ctx.agents as AgentsService;

	const getRuntime = (sessionId: string): GrillRuntime | undefined => runtimes.get(sessionId);
	const sessions = (): GrillSessionView[] => [...runtimes.values()].reverse().map((runtime) => ({
		sessionId: runtime.agentId,
		cwd: runtime.cwd,
		state: runtime.state,
	}));

	const router = registerGrillRoutes(ctx, { getRuntime, sessions });
	const runtimeDeps: GrillRuntimeDeps = {
		agents,
		config: grillConfig,
		logger: ctx.logger,
		broadcast: (sessionId: string) => router.broadcast(sessionId),
	};

	ctx.effect(() => router.dispose, "dsh-grill: routes");
	ctx.effect(() => registerGrillTool(ctx, { getRuntime }), "dsh-grill: tool");
	ctx.effect(() => ctx.commands.register(grillCommandDefinition({
		getRuntime,
		startInterview: (agentId: string, cwd: string, content: string) => {
			const runtime = new GrillRuntime(agentId, cwd, content, runtimeDeps);
			const started = runtime.start(content);
			if (!started.ok) return { runtime: undefined, message: started.message };
			runtimes.set(agentId, runtime);
			return { runtime, resumed: started.resumed };
		},
	})), "dsh-grill: command");
	ctx.effect(() => () => {
		for (const runtime of runtimes.values()) runtime.close();
		runtimes.clear();
	}, "dsh-grill: cleanup");
}