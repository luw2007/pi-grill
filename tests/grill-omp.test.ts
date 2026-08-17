import { describe, expect, test } from "bun:test";
import grillOmpExtension from "../grill-omp.ts";

describe("OMP extension entrypoint", () => {
	test("registers the full Grill command and tool surface", () => {
		const commands: Record<string, unknown> = {};
		const tools: Record<string, unknown> = {};
		grillOmpExtension({
			registerCommand(name: string, command: unknown) { commands[name] = command; },
			registerTool(tool: { name: string }) { tools[tool.name] = tool; },
			on() {},
		} as never);

		expect(Object.keys(commands)).toEqual(["grill-panel", "grill"]);
		expect(Object.keys(tools)).toEqual(["grill_ask"]);
	});
});
