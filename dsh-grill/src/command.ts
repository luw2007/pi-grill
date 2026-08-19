/**
 * The /grill human command: start or resume an interview for the agent whose
 * UI dispatched the command, then follow up with the interview brief.
 * @module dsh-grill/command
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { CommandDefinition, CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { buildInterviewPrompt } from "./prompts.ts";
import type { GrillRuntime } from "./runtime.ts";

export type GrillCommandDeps = {
	/** Create the interview for one agent; returns the runtime once started. */
	startInterview(agentId: string, cwd: string, content: string): { runtime: GrillRuntime; resumed: boolean } | { runtime: undefined; message: string };
	/** Runtime for an agent, if any (to refuse duplicate /grill runs). */
	getRuntime(agentId: string): GrillRuntime | undefined;
};

function sessionCwd(invocation: CommandInvocation): string {
	const headerCwd = invocation.agent.session.header.cwd;
	return typeof headerCwd === "string" && headerCwd.length > 0 ? headerCwd : process.cwd();
}

export function grillCommandDefinition(deps: GrillCommandDeps): CommandDefinition {
	return {
		name: "grill",
		description: "Run a multi-round design interview with a JSON state source and the asynchronous web panel",
		input: { hint: "Describe the feature or idea you want to design" },
		handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
			const content = invocation.rawInput.trim();
			if (!content) {
				return { kind: "error", text: "/grill needs a topic: /grill <describe the feature or idea you want to design>" };
			}
			const cwd = sessionCwd(invocation);
			const existing = deps.getRuntime(invocation.agent.id);
			if (existing) {
				return { kind: "error", text: "An interview is already active for this agent. The panel shows it; type /grill again only to start a different interview." };
			}
			const started = deps.startInterview(invocation.agent.id, cwd, content);
			if (!started.runtime) return { kind: "error", text: started.message };
			try {
				const message = createUserMessage({
					content: [{ type: "text", text: buildInterviewPrompt({
						content: started.runtime.state.content,
						statePath: started.runtime.statePath,
						htmlPath: started.runtime.htmlPath,
						state: started.runtime.state,
					}) }],
					source: { kind: "plugin", plugin: "grill" },
				});
				invocation.agent.followup(message);
			} catch (error) {
				return { kind: "error", text: "grill: interview started but the brief delivery failed: " + (error instanceof Error ? error.message : String(error)) };
			}
			return {
				kind: "success",
				text: started.resumed
					? "Grill interview resumed (" + started.runtime.state.answeredCount + " answered). State: " + started.runtime.statePath
					: "Grill interview started. State: " + started.runtime.statePath
			};
		},
	};
}

export type { CommandDefinition };