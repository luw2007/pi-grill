/**
 * The grill_ask model-facing tool: publish a question batch asynchronously.
 * @module dsh-grill/tool
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { GrillRuntime } from "./runtime.ts";

export type GrillToolDeps = {
	/** Resolve the active interview for the calling agent, or undefined. */
	getRuntime(agentId: string): GrillRuntime | undefined;
};

export function registerGrillTool(ctx: Context, deps: GrillToolDeps): () => void {
	return ctx.tools.register(defineTool({
		name: "grill_ask",
		description: "Ask one or more design interview questions in the asynchronous grill web panel and persist them to the active grill JSON state. Returns immediately; the agent does not wait for the user.",
		parameters: {
			questions: {
				type: "array",
				required: true,
				description: "Question batch to publish; the first question becomes the current one.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: { type: "string", required: true, description: "Stable question id, unique within this interview." },
						section: { type: "string", required: true, description: "Free-form grouping label used only to index questions." },
						question: { type: "string", required: true, description: "The decision to ask the user." },
						context: { type: "string", description: "Supporting context shown with the question." },
						options: {
							type: "array",
							required: true,
							description: "Choices; exactly one label is committed per answer.",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									value: { type: "string", required: true, description: "Stable option value." },
									label: { type: "string", required: true, description: "User-facing option label." },
									description: { type: "string", description: "Optional supporting text for the option." },
									recommended: { type: "boolean", description: "Mark this option as recommended." },
									recommendationReason: { type: "string", description: "Why this option is recommended." },
									requiresText: { type: "boolean", description: "This option opens a mandatory text field before committing." },
								},
							},
						},
						recommended: { type: "string", description: "Value of the recommended option, if any." },
						recommendationReason: { type: "string", description: "Why the recommended option is recommended." },
					},
				},
			},
			deprecate: {
				type: "array",
				description: "Question ids to mark deprecated (answered/skipped questions that are no longer authoritative).",
				items: { type: "string" },
			},
			remove: {
				type: "array",
				description: "Question ids to remove entirely (their ledger rows are kept with a removed status).",
				items: { type: "string" },
			},
			converge: {
				type: "boolean",
				description: "Mark this batch as the convergence check: answering with a confirm keyword triggers the plan.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					publishedQuestionIds: { type: "array", items: { type: "string" } },
					statePath: { type: "string" },
					state: { type: "json" },
					summary: { type: "string" },
				},
			},
			render(_args, value) {
				const published = value.publishedQuestionIds ?? [];
				const summary = value.summary ?? "(no summary)";
				return [{ type: "text", text: "Published " + published.length + " question(s) asynchronously; the grill panel is open. The agent does not wait for the user.\n\n" + summary }];
			},
		},
		async execute(args, exec: ToolRunContext) {
			const agent = exec.agent;
			if (!agent) throw new Error("grill_ask requires a live calling agent");
			const runtime = deps.getRuntime(agent.id);
			if (!runtime) throw new Error("No active /grill session for this agent; start one with /grill <topic>");
			const published = runtime.publish(args.questions, args.converge === true);
			if (!published.ok) throw new Error(published.message);
			if (args.deprecate && args.deprecate.length > 0) {
				const result = runtime.deprecate(args.deprecate);
				if (!result.ok) throw new Error(result.message);
			}
			if (args.remove && args.remove.length > 0) {
				const result = runtime.remove(args.remove);
				if (!result.ok) throw new Error(result.message);
			}
			return {
				publishedQuestionIds: published.published,
				statePath: runtime.statePath,
				state: runtime.state,
				summary: runtime.summary(),
			};
		},
	}));
}