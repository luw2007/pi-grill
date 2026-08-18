import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import grillModule from "../grill.ts";

const grillExtension = ((grillModule as unknown as { default?: typeof grillModule }).default ?? grillModule) as unknown as (pi: any) => void;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "grill-async-test-"));
	tempDirs.push(cwd);
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, { handler(context: unknown): Promise<void> | void }>();
	const eventHandlers = new Map<string, Array<(...args: any[]) => any>>();
	const messages: any[] = [];
	const userMessages: Array<{ message: string; options: any }> = [];
	const customCalls: any[] = [];
	const notifications: string[] = [];
	const widgets = new Map<string, string[] | undefined>();
	const panel = deferred<void>();
	const handle = {
		focusCalls: 0,
		setHiddenCalls: [] as boolean[],
		unfocusCalls: [] as any[],
		hideCalls: 0,
		focus() { this.focusCalls += 1; },
		setHidden(value: boolean) { this.setHiddenCalls.push(value); },
		unfocus(value?: any) { this.unfocusCalls.push(value); },
		hide() { this.hideCalls += 1; },
		isHidden() { return false; },
		isFocused() { return true; },
	};
	let component: any;
	let done: (() => void) | undefined;
	const theme = {
		fg: (_name: string, text: string) => text,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ui = {
		theme,
		setWidget(key: string, value: string[] | undefined) { widgets.set(key, value); },
		notify(message: string) { notifications.push(message); },
		confirmResponses: [] as boolean[],
		confirm: async () => (ui.confirmResponses.length ? ui.confirmResponses.shift()! : false),
		input: async () => undefined,
		select: async () => undefined,
		custom(factory: any, options: any) {
			customCalls.push({ options });
			done = () => panel.resolve();
			component = factory({ requestRender() {} }, theme, {}, done);
			options.onHandle?.(handle);
			return panel.promise;
		},
	};
	const context = {
		cwd,
		mode: "tui",
		hasUI: true,
		ui,
		isIdle: () => true,
		abortCalls: 0,
		shutdownCalls: 0,
		abort() { this.abortCalls += 1; },
		shutdown() { this.shutdownCalls += 1; },
	};
	const pi: any = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut(shortcut: string, options: { handler(context: unknown): Promise<void> | void }) { shortcuts.set(shortcut, options); },
		on(name: string, handler: (...args: unknown[]) => unknown) { const list = eventHandlers.get(name) ?? []; list.push(handler); eventHandlers.set(name, list); },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
		sendUserMessage(message: string, options: any) { userMessages.push({ message, options }); },
	};
	grillExtension(pi);
	const initialContent = `integration-${cwd}`;
	const kickoff = commands.get("grill").handler(initialContent, context);
	return { cwd, initialContent, kickoff, tools, commands, shortcuts, messages, userMessages, customCalls, handle, widgets, ui, get component() { return component; }, get done() { return done; }, context, notifications, panel };
}

function question(id: string, section = "1. Background", requiresText = false) {
	return { id, section, question: `${id}?`, options: [{ value: "yes", label: "Yes", ...(requiresText ? { requiresText: true } : {}) }] };
}

async function publish(env: ReturnType<typeof setup>, ids = ["Q1"]) {
	return env.tools.get("grill_ask").execute("call", { questions: ids.map((id) => question(id)) }, undefined, undefined, env.context);
}

async function publishQuestions(env: ReturnType<typeof setup>, questions: any[]) {
	return env.tools.get("grill_ask").execute("call", { questions }, undefined, undefined, env.context);
}

describe("asynchronous grill integration", () => {
	test("startup prompt makes sections an index and final plan headings content-driven", async () => {
		const env = setup();
		await env.kickoff;
		expect(env.userMessages).toHaveLength(1);
		const prompt = env.userMessages[0]!.message;
		expect(prompt).toContain("free-form grouping label used only to index questions");
		expect(prompt).toContain("Generate the final plan's body headings freely from substantive content");
		expect(prompt).toContain("no fixed heading pool, required order, minimum section count, or N/A placeholders");
		expect(prompt).toContain('The final "## Interview transcript" section is always required');
		expect(prompt).not.toContain("canonical ten-section template");
		expect(prompt).not.toContain("canonical sections");
	});

	test("tool publishes and returns while overlay promise is pending", async () => {
		const env = setup();
		await env.kickoff;
		const result = await Promise.race([publish(env), new Promise((_, reject) => setTimeout(() => reject(new Error("blocked")), 50))]);
		expect(result.details.publishedQuestionIds).toEqual(["Q1"]);
		expect(result.details.answers).toBeUndefined();
		expect(env.customCalls).toHaveLength(1);
		expect(env.customCalls[0].options.overlay).toBe(true);
		expect(env.handle.focusCalls).toBe(1);
		expect(result.details.state.questions.map((item: any) => item.id)).toEqual(["Q1"]);
	});

	test("opens when the OMP overlay handle has no focus method", async () => {
		const env = setup();
		delete (env.handle as { focus?: unknown }).focus;
		await env.kickoff;
		await publish(env);
		expect(env.customCalls).toHaveLength(1);
		expect(env.handle.setHiddenCalls).toEqual([false]);
		expect(env.notifications).not.toContainEqual(expect.stringContaining("grill panel closed unexpectedly"));
	});

	test("keeps widget visibility state correct across hide, refresh, command, and publish", async () => {
		const env = setup();
		await env.kickoff;
		await publish(env, ["Q1"]);
		expect(env.component.render(120).join("\n")).toContain("Esc hide");
		expect(env.widgets.get("grill")?.[0]).toBe("grill · answered 0 / active 1 · current Q1 · [open] Esc to hide");

		env.component.handleInput("\u001b");
		expect(env.handle.setHiddenCalls).toEqual([false, true]);
		expect(env.handle.unfocusCalls).toEqual([undefined]);
		expect(env.panel.promise).toBeInstanceOf(Promise);
		expect(env.widgets.get("grill")?.[0]).toBe("grill · answered 0 / active 1 · current Q1 · [hidden] /grill-panel to open");

		const statePath = [...env.widgets.values()][0]?.[1] as string;
		const background = JSON.parse(readFileSync(statePath, "utf8"));
		background.questions.push({ ...question("Q-background"), status: "pending" });
		background.validQuestionCount = 2;
		await Bun.write(statePath, `${JSON.stringify(background, null, 2)}\n`);
		for (let attempt = 0; attempt < 100 && !env.widgets.get("grill")?.[0].includes("active 2"); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(env.widgets.get("grill")?.[0]).toBe("grill · answered 0 / active 2 · current Q1 · [hidden] /grill-panel to open");

		await env.commands.get("grill-panel").handler("", env.context);
		expect(env.customCalls).toHaveLength(1);
		expect(env.handle.setHiddenCalls).toEqual([false, true, false]);
		expect(env.handle.focusCalls).toBe(2);
		expect(env.widgets.get("grill")?.[0]).toBe("grill · answered 0 / active 2 · current Q1 · [open] Esc to hide");

		env.component.handleInput("\u001b");
		await publish(env, ["Q2"]);
		expect(env.customCalls).toHaveLength(1);
		expect(env.handle.setHiddenCalls).toEqual([false, true, false, true, false]);
		expect(env.handle.focusCalls).toBe(3);
		expect(env.widgets.get("grill")?.[0]).toBe("grill · answered 0 / active 3 · current Q2 · [open] Esc to hide");
		expect(env.component.render(120).join("\n")).toContain("Q2");
	});

	test("reveals the current question from a published batch without moving watcher-driven selection", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, Array.from({ length: 15 }, (_, index) => `Q${index + 1}`));
		env.component.handleInput("\u001b[53;5u");
		expect(env.component.render(160).join("\n")).toContain("> □ Q5 1. Background");

		const statePath = published.details.statePath as string;
		const external = JSON.parse(readFileSync(statePath, "utf8"));
		external.questions[4].context = "watcher refresh marker";
		await Bun.write(statePath, `${JSON.stringify(external, null, 2)}\n`);
		for (let attempt = 0; attempt < 100 && !env.component.render(160).join("\n").includes("watcher refresh marker"); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const watcherRendered = env.component.render(160).join("\n");
		expect(watcherRendered).toContain("> □ Q5 1. Background");
		expect(watcherRendered).toContain("1-10 / 15");

		await publish(env, ["Q16", "Q17", "Q18"]);
		const rendered = env.component.render(160).join("\n");
		expect(rendered).toContain("> □ Q16 1. Background");
		expect(rendered).toContain("7-16 / 18");
	});

	test("hides after an answer or skip, reopens for new questions, and toggles with Ctrl+G", async () => {
		const env = setup();
		await env.kickoff;
		await publish(env, ["Q1"]);
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		expect(env.handle.setHiddenCalls).toEqual([false, true]);

		await publish(env, ["Q2"]);
		expect(env.handle.setHiddenCalls).toEqual([false, true, false]);
		await env.shortcuts.get("ctrl+alt+g")!.handler(env.context);
		expect(env.handle.setHiddenCalls).toEqual([false, true, false, true]);
		await env.shortcuts.get("ctrl+alt+g")!.handler(env.context);
		expect(env.handle.setHiddenCalls).toEqual([false, true, false, true, false]);
		env.component.handleInput("\u0013");
		expect(env.handle.setHiddenCalls).toEqual([false, true, false, true, false, true]);
	});

	test("renders context between question and options, pins it, and omits it from HTML", async () => {
		const env = setup();
		await env.kickoff;
		const context = "Why this matters and what the answer decides";
		const published = await publishQuestions(env, [{ ...question("Q1"), context }]);
		const statePath = published.details.statePath as string;
		const rendered = env.component.render(120).join("\n");
		expect(rendered.indexOf("Q1?")).toBeLessThan(rendered.indexOf(context));
		expect(rendered.indexOf(context)).toBeLessThan(rendered.indexOf("1. Yes"));
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		const disk = JSON.parse(readFileSync(statePath, "utf8"));
		expect(disk.questions[0].pinned.context).toBe(context);
		const html = readFileSync(statePath.replace(/\.json$/, ".html"), "utf8");
		expect(html).not.toContain(context);
	});

	test("scrolls long option lists by atomic blocks and persists the per-question viewport", async () => {
		const env = setup();
		await env.kickoff;
		const options = Array.from({ length: 9 }, (_, index) => ({
			value: `v${index + 1}`,
			label: `Option ${index + 1}`,
			description: `Description ${index + 1}`,
			recommendationReason: `Reason ${index + 1}`,
			...(index === 8 ? { requiresText: true } : {}),
		}));
		const published = await publishQuestions(env, [{ id: "Q1", section: "1. Background", question: "Long?", options }]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		let rendered = env.component.render(120).join("\n");
		expect(rendered).toContain("showing 1–8 of 10 · ↑↓ scroll");
		expect(rendered).not.toContain("Option 9");
		for (let index = 0; index < 8; index += 1) env.component.handleInput("\u001b[B");
		rendered = env.component.render(120).join("\n");
		expect(rendered).toContain("Option 9 · needs detail");
		expect(rendered).toContain("Description 9");
		expect(rendered).toContain("Reason 9");
		expect(rendered).toContain("showing 2–9 of 10 · ↑↓ scroll");
		env.component.handleInput("\u001b");
		const disk = JSON.parse(readFileSync(statePath, "utf8"));
		expect(disk.ui.selectedOptionByQuestion.Q1).toBe(8);
		expect(disk.ui.optionScrollOffsetByQuestion.Q1).toBe(1);
		await env.commands.get("grill-panel").handler("", env.context);
		expect(env.component.render(120).join("\n")).toContain("showing 2–9 of 10 · ↑↓ scroll");
	});

	test("does not scroll at the configured threshold", async () => {
		const env = setup();
		await env.kickoff;
		await publishQuestions(env, [{
			id: "Q1", section: "1. Background", question: "Boundary?",
			options: Array.from({ length: 8 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` })),
		}]);
		env.component.handleInput("\u001b[C");
		const rendered = env.component.render(120).join("\n");
		expect(rendered).toContain("Something else (type it)");
		expect(rendered).not.toContain("showing ");
	});

	test("requiresText needs non-empty supplement, Esc returns to select, then second Esc hides", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [question("Q1", "1. Background", true)]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		expect(env.component.render(120).join("\n")).toContain("Add detail (required)");
		env.component.handleInput("\r");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].status).toBe("current");
		expect(env.component.render(120).join("\n")).toContain("Add detail (required)");
		env.component.handleInput("\u001b");
		expect(env.component.render(120).join("\n")).not.toContain("Add detail (required)");
		expect(env.handle.setHiddenCalls).toEqual([false]);
		expect(env.widgets.get("grill")?.[0]).toContain("[open] Esc to hide");
		env.component.handleInput("\u001b");
		expect(env.handle.setHiddenCalls).toEqual([false, true]);
		expect(env.handle.unfocusCalls.at(-1)).toBeUndefined();
		expect(env.widgets.get("grill")?.[0]).toContain("[hidden] /grill-panel to open");
	});

	test("requiresText commits its supplement as reason", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [question("Q1", "1. Background", true)]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		for (const char of "required detail") env.component.handleInput(char);
		env.component.handleInput("\r");
		const answered = JSON.parse(readFileSync(statePath, "utf8")).questions[0];
		expect(answered.status).toBe("answered");
		expect(answered.userChoice).toBe("Yes");
		expect(answered.reason).toBe("required detail");
	});

	test("other requires one custom label and commits without a reason phase", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, ["Q1"]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\u001b[B");
		env.component.handleInput("\r");
		expect(env.component.render(120).join("\n")).toContain("Type your own answer (required)");
		env.component.handleInput("\r");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].status).toBe("current");
		for (const char of "Custom answer") env.component.handleInput(char);
		env.component.handleInput("\r");
		const answered = JSON.parse(readFileSync(statePath, "utf8")).questions[0];
		expect(answered.status).toBe("answered");
		expect(answered.userChoice).toBe("Custom answer");
		expect(answered.reason).toBe("");
		expect(env.component.render(120).join("\n")).not.toContain("Reason");
	});

	test("Ctrl+1..Ctrl+0 directly select ledger Q1..Q10 in the answer pane", async () => {
		const env = setup();
		await env.kickoff;
		await publish(env, Array.from({ length: 10 }, (_, index) => `Q${index + 1}`));
		for (const [key, id] of [["1", "Q1"], ["9", "Q9"], ["0", "Q10"]] as const) {
			env.component.handleInput(`\u001b[${key.charCodeAt(0)};5u`);
			const rendered = env.component.render(160).join("\n");
			expect(rendered).toContain("Answer ◀");
			expect(rendered).toContain(`${id}?`);
		}
	});

	test("left selects the previous ledger question and enters answer; right and Enter confirm", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, ["Q1", "Q2"]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[B");
		env.component.handleInput("\u001b[D");
		expect(env.component.render(120).join("\n")).toContain("Q1?");
		expect(env.component.render(120).join("\n")).toContain("Answer ◀");
		env.component.handleInput("\u001b[C");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].status).toBe("answered");
	});

	test("final answer enters a terminal completion summary without implicitly cycling to Q1", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, ["Q1", "Q2"]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		env.component.handleInput("\r");
		const rendered = env.component.render(120).join("\n");
		expect(rendered).toContain("All questions handled");
		expect(rendered).toContain("Read-only summary");
		expect(rendered).not.toContain(">  1. Yes");
		const disk = JSON.parse(readFileSync(statePath, "utf8"));
		expect(disk.ui.selectedQuestionId).toBeNull();
		expect(disk.ui.activeSurface).toBe("submit");
		expect(env.widgets.get("grill")?.[0]).toContain("current converged");
	});

	test("explicit navigation after completion can reopen and overwrite answered Q1", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [{
			id: "Q1", section: "1. Background", question: "Q1?",
			options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
		}]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		expect(env.component.render(120).join("\n")).toContain("All questions handled");
		env.component.handleInput("\u001b[49;5u");
		expect(env.component.render(120).join("\n")).toContain("Answer ◀");
		env.component.handleInput("\u001b[B");
		env.component.handleInput("\r");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].userChoice).toBe("Beta");
		expect(env.component.render(120).join("\n")).toContain("All questions handled");
	});

	test("external current question is adopted into a hidden panel without reopening or focusing it", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, ["Q1"]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		expect(env.component.render(120).join("\n")).toContain("All questions handled");
		env.component.handleInput("\u001b");
		const focusCalls = env.handle.focusCalls;
		const setHiddenCalls = [...env.handle.setHiddenCalls];
		const background = JSON.parse(readFileSync(statePath, "utf8"));
		background.questions.push({ ...question("Q-new"), status: "current" });
		background.currentQuestionId = "Q-new";
		background.validQuestionCount = 2;
		await Bun.write(statePath, `${JSON.stringify(background, null, 2)}\n`);
		for (let attempt = 0; attempt < 100 && !env.component.render(120).join("\n").includes("Q-new?"); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const rendered = env.component.render(120).join("\n");
		expect(rendered).toContain("> □ Q-new 1. Background");
		expect(rendered).toContain("Q-new?");
		expect(rendered).not.toContain("No question selected · ← or Ctrl+1…Ctrl+0 to pick one");
		expect(rendered).not.toContain("All questions handled");
		expect(env.handle.focusCalls).toBe(focusCalls);
		expect(env.handle.setHiddenCalls).toEqual(setHiddenCalls);
		expect(env.widgets.get("grill")?.[0]).toContain("[hidden]");
		await env.commands.get("grill-panel").handler("", env.context);
		expect(env.handle.focusCalls).toBe(focusCalls + 1);
	});


	test("overwrites an answered choice and emits only the latest grill answer", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const scheduled: Array<{ delay: number; callback: () => void }> = [];
		(globalThis as any).setTimeout = (callback: () => void, delay: number) => { scheduled.push({ callback, delay }); return scheduled.length; };
		(globalThis as any).clearTimeout = () => {};
		try {
			const env = setup();
			await env.kickoff;
			const published = await publishQuestions(env, [{
				id: "Q1", section: "1. Background", question: "Q1?",
				options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], recommended: "b",
			}]);
			const statePath = published.details.statePath as string;
			env.component.handleInput("\u001b[C");
			env.component.handleInput("\r");
			env.component.handleInput("\u001b[49;5u");
			env.component.handleInput("\u001b[A");
			env.component.handleInput("\r");
			const disk = JSON.parse(readFileSync(statePath, "utf8"));
			expect(disk.questions[0].userChoice).toBe("Alpha");
			expect(disk.sections).toBeUndefined();
			const answerFlush = scheduled.find((item) => item.delay === 500);
			answerFlush!.callback();
			expect(env.messages).toHaveLength(1);
			expect(env.messages[0].message.details.answers).toEqual([
				{ id: "Q1", value: "a", label: "Alpha", index: 1, other: false, reason: "", status: "answered" },
			]);
			expect(env.messages[0].message.content).toContain("Q1: Alpha");
			expect(env.messages[0].message.content).not.toContain("Beta");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	test("converged plan confirmation ends the runtime, clears the widget, and keeps state files", async () => {
		const env = setup();
		await env.kickoff;
		const published = await env.tools.get("grill_ask").execute("call", {
			questions: [{ id: "Q1", section: "1. Background", question: "confirm?", options: [{ value: "confirm", label: "确认生成 plan" }] }],
			converge: true,
		}, undefined, undefined, env.context);
		const statePath = published.details.statePath as string;
		const htmlPath = statePath.replace(/\.json$/, ".html");
		expect(env.widgets.get("grill")).toBeDefined();

		env.ui.confirmResponses.push(true);
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(existsSync(statePath)).toBe(true);
		expect(existsSync(htmlPath)).toBe(true);
		expect(env.widgets.get("grill")).toBeUndefined();
		expect(env.handle.hideCalls).toBe(1);
		expect(env.notifications.some((message) => message.includes("the panel is closed"))).toBe(true);
		expect(env.userMessages).toHaveLength(2);
		const planPrompt = env.userMessages[1]!.message;
		expect(planPrompt).toContain("Choose the body's level-2 headings and their order freely");
		expect(planPrompt).toContain("Do not use a fixed heading pool, require a minimum section count, add empty sections, or write N/A placeholders");
		expect(planPrompt).toContain('always append a final "## Interview transcript" heading');
		expect(planPrompt).toContain("including answered, skipped, deprecated and removed");
		expect(planPrompt).toContain("After writing, read the file back");
		expect(planPrompt).toContain("confirm every question id is present");
		expect(planPrompt).not.toContain("canonical plan-heading pool");
		expect(planPrompt).not.toContain("canonical order");
		expect(planPrompt).not.toContain("SECTION_TEMPLATE");

		await env.commands.get("grill-panel").handler("", env.context);
		expect(env.notifications.at(-1)).toContain("No active /grill session");
	});

	test("Ctrl+S skips a question end-to-end: writes skipped, emits event, unblocks convergence, and stays re-answerable", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, ["Q1", "Q2"]);
		const statePath = published.details.statePath as string;

		env.component.handleInput("\u001b[C");
		env.component.handleInput("\u0013");

		const afterSkip = JSON.parse(readFileSync(statePath, "utf8"));
		const skipped = afterSkip.questions.find((item: any) => item.id === "Q1");
		expect(skipped.status).toBe("skipped");
		expect(skipped.statusNote).toBeTruthy();
		expect(skipped.userChoice).toBeUndefined();
		expect(afterSkip.answeredCount).toBe(0);
		expect(afterSkip.questions.find((item: any) => item.id === "Q2").status).toBe("pending");

		expect(env.component.render(120).join("\n")).toContain("Q2?");

		env.component.handleInput("\u0013");
		const allSkipped = JSON.parse(readFileSync(statePath, "utf8"));
		expect(allSkipped.questions.map((item: any) => item.status)).toEqual(["skipped", "skipped"]);
		expect(env.component.render(120).join("\n")).toContain("All questions handled");

		env.component.handleInput(`\u001b[${"1".charCodeAt(0)};5u`);
		env.component.handleInput("\r");
		const reanswered = JSON.parse(readFileSync(statePath, "utf8"));
		expect(reanswered.questions.find((item: any) => item.id === "Q1").status).toBe("answered");
		expect(reanswered.questions.find((item: any) => item.id === "Q1").statusNote).toBeUndefined();
	});

	test("Ctrl+N records a note end-to-end without touching the ledger and steers it to the agent", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, ["Q1"]);
		const statePath = published.details.statePath as string;
		const before = JSON.parse(readFileSync(statePath, "utf8"));

		env.component.handleInput("\u001b[C");
		env.component.handleInput("\u000e");
		expect(env.component.render(120).join("\n")).toContain("Note for the agent");

		for (const char of "the premise is wrong") env.component.handleInput(char);
		env.component.handleInput("\r");

		const after = JSON.parse(readFileSync(statePath, "utf8"));
		expect(after.notes).toEqual(["the premise is wrong"]);
		expect(after.questions).toEqual(before.questions);
		expect(after.answeredCount).toBe(before.answeredCount);

		const noteMessage = env.messages.find((entry) => entry.message.customType === "grill-note");
		expect(noteMessage).toBeDefined();
		expect(noteMessage.message.content).toContain("the premise is wrong");
		expect(noteMessage.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(env.component.render(120).join("\n")).toContain("Q1?");
	});

	test("emergency keys restore editor focus and never commit drafts", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [question("Q1", "1. Background", true)]);
		const statePath = published.details.statePath as string;
		const before = JSON.parse(readFileSync(statePath, "utf8"));
		env.component.handleInput("\u0003");
		expect(env.handle.unfocusCalls.at(-1)).toBeUndefined();
		expect(env.context.abortCalls).toBe(1);
		env.component.handleInput("\u0004");
		expect(env.context.shutdownCalls).toBe(1);
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		env.component.handleInput("\u0003");
		expect(env.context.abortCalls).toBe(2);
		env.component.handleInput("\u0004");
		expect(env.context.shutdownCalls).toBe(2);
		const after = JSON.parse(readFileSync(statePath, "utf8"));
		expect(after.questions).toEqual(before.questions);
		expect(env.messages).toHaveLength(0);
	});

	test("commits immediately, emits one complete steer event, and keeps terminal rows read-only", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const scheduled: Array<{ delay: number; callback: () => void }> = [];
		(globalThis as any).setTimeout = (callback: () => void, delay: number) => {
			scheduled.push({ callback, delay });
			return scheduled.length;
		};
		(globalThis as any).clearTimeout = () => {};
		try {
			const env = setup();
			await env.kickoff;
			const published = await publish(env, ["Q1", "Q2"]);
			const statePath = published.details.statePath as string;
			env.component.handleInput("\u001b[C");
			env.component.handleInput("\r");
			let disk = JSON.parse(readFileSync(statePath, "utf8"));
			expect(disk.questions.find((item: any) => item.id === "Q1").status).toBe("answered");
			expect(disk.questions.find((item: any) => item.id === "Q2").status).toBe("pending");
			expect(env.panel.promise).toBeInstanceOf(Promise);
			expect(env.messages).toHaveLength(0);
			env.component.handleInput("\r");
			disk = JSON.parse(readFileSync(statePath, "utf8"));
			expect(disk.questions.find((item: any) => item.id === "Q2").status).toBe("answered");
			const answerFlush = scheduled.find((item) => item.delay === 500);
			expect(answerFlush).toBeDefined();
			answerFlush!.callback();
			expect(env.messages).toHaveLength(1);
			expect(env.messages[0].message.customType).toBe("grill-answers");
			expect(env.messages[0].message.display).toBe(true);
			expect(env.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
			expect(env.messages[0].message.details.answers).toEqual([
				{ id: "Q1", value: "yes", label: "Yes", index: 1, other: false, reason: "", status: "answered" },
				{ id: "Q2", value: "yes", label: "Yes", index: 1, other: false, reason: "", status: "answered" },
			]);
			const before = JSON.parse(readFileSync(statePath, "utf8"));
			env.component.handleInput("\u001b[D");
			env.component.handleInput("\u001b[A");
			const after = JSON.parse(readFileSync(statePath, "utf8"));
			expect(after.questions).toEqual(before.questions);
			expect(env.messages).toHaveLength(1);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	test("renders the complete ten-row ledger including read-only terminal ids", async () => {
		const env = setup();
		await env.kickoff;
		await publish(env, Array.from({ length: 10 }, (_, index) => `Q${index + 1}`));
		const rendered = env.component.render(160).join("\n");
		for (let index = 1; index <= 10; index += 1) expect(rendered).toContain(`Q${index}`);
		const statePath = env.tools.get("grill_ask");
		expect(statePath).toBeDefined();
	});
});
