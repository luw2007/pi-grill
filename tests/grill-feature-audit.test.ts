import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import grillModule from "../grill.ts";
import { SKIP_STATUS_NOTE, applyNote, consumeConvergenceAnswer } from "../grill.ts";

const grillExtension = ((grillModule as unknown as { default?: typeof grillModule }).default ?? grillModule) as unknown as (pi: any) => void;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function statePathFor(cwd: string, content: string): string {
	const project = `${basename(cwd) || "root"}-${createHash("sha1").update(cwd).digest("hex").slice(0, 8)}`;
	return join(tmpdir(), "grill", project, `${createHash("sha1").update(content).digest("hex")}.json`);
}

function createEnv(options: { cwd?: string; mode?: string; hasUI?: boolean } = {}) {
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "grill-audit-"));
	if (!options.cwd) tempDirs.push(cwd);
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, { handler(context: unknown): Promise<void> | void }>();
	const eventHandlers = new Map<string, Array<(...args: any[]) => any>>();
	const messages: any[] = [];
	const userMessages: Array<{ message: string; options: any }> = [];
	const customCalls: any[] = [];
	const notifications: string[] = [];
	const widgets = new Map<string, string[] | undefined>();
	let panelResolve: (() => void) | undefined;
	const handle = {
		focusCalls: 0,
		setHiddenCalls: [] as boolean[],
		unfocusCalls: 0,
		hideCalls: 0,
		focus() { this.focusCalls += 1; },
		setHidden(value: boolean) { this.setHiddenCalls.push(value); },
		unfocus() { this.unfocusCalls += 1; },
		hide() { this.hideCalls += 1; },
		isHidden() { return false; },
		isFocused() { return true; },
	};
	let component: any;
	const theme = {
		fg: (_name: string, text: string) => text,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ui = {
		theme,
		setWidget(key: string, value: string[] | undefined) { widgets.set(key, value); },
		notify(message: string) { notifications.push(message); },
		confirmCalls: 0,
		confirmResponses: [] as boolean[],
		confirm: async () => { ui.confirmCalls += 1; return ui.confirmResponses.length ? ui.confirmResponses.shift()! : false; },
		inputResponses: [] as Array<string | undefined>,
		input: async () => ui.inputResponses.shift(),
		selectCalls: [] as string[],
		selectResponses: [] as Array<string | undefined>,
		select: async (title: string) => { ui.selectCalls.push(title); return ui.selectResponses.shift(); },
		custom(factory: any, opts: any) {
			customCalls.push({ options: opts });
			const promise = new Promise<void>((resolve) => { panelResolve = resolve; });
			component = factory({ requestRender() {} }, theme, {}, () => panelResolve?.());
			opts.onHandle?.(handle);
			return promise;
		},
	};
	const context = {
		cwd,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
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
		registerShortcut(shortcut: string, opts: { handler(context: unknown): Promise<void> | void }) { shortcuts.set(shortcut, opts); },
		on(name: string, handler: (...args: unknown[]) => unknown) { const list = eventHandlers.get(name) ?? []; list.push(handler); eventHandlers.set(name, list); },
		sendMessage(message: any, opts: any) { messages.push({ message, options: opts }); },
		sendUserMessage(message: string, opts: any) { userMessages.push({ message, options: opts }); },
	};
	grillExtension(pi);
	return {
		cwd, tools, commands, shortcuts, eventHandlers, messages, userMessages, customCalls, handle, widgets, ui, context, notifications,
		get component() { return component; },
		start(content: string) { return commands.get("grill").handler(content, context); },
		async shutdown() { for (const handler of eventHandlers.get("session_shutdown") ?? []) await handler(); },
	};
}

function question(id: string, extra: Record<string, unknown> = {}) {
	return { id, section: "1. Background", question: `${id}?`, options: [{ value: "yes", label: "Yes" }], ...extra };
}

async function publish(env: ReturnType<typeof createEnv>, questions: any[], converge = false) {
	return env.tools.get("grill_ask").execute("call", { questions, converge }, undefined, undefined, env.context);
}

// fs.watch has no deterministic test seam; polling a real-time condition matches the sibling integration suite.
async function until(predicate: () => boolean, ms = 2000): Promise<boolean> {
	for (let elapsed = 0; elapsed < ms; elapsed += 10) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

const RIGHT = "\u001b[C";
const DOWN = "\u001b[B";
const ENTER = "\r";
const CTRL_S = "\u0013";
const CTRL_N = "\u000e";
const ctrlDigit = (digit: string) => `\u001b[${digit.charCodeAt(0)};5u`;

describe("commands (CMD)", () => {
	test("CMD-01/PERSIST-01/PERSIST-02: start creates atomic state files, widget, and kickoff prompt", async () => {
		const env = createEnv();
		const content = `audit-start-${env.cwd}`;
		await env.start(content);
		const statePath = statePathFor(env.cwd, content);
		expect(existsSync(statePath)).toBe(true);
		expect(existsSync(statePath.replace(/\.json$/, ".html"))).toBe(true);
		expect(readdirSync(dirname(statePath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(env.notifications.some((message) => message.includes("grill state started"))).toBe(true);
		expect(env.userMessages).toHaveLength(1);
		expect(env.userMessages[0]!.message).toContain(statePath);
		expect(env.userMessages[0]!.options).toEqual({ deliverAs: "followUp" });
		expect(env.widgets.get("grill")?.[0]).toContain("answered 0 / active 0");
		expect(env.widgets.get("grill")?.[0]).toContain("current none");
		expect(env.widgets.get("grill")?.[1]).toBe(statePath);
	});

	test("PERSIST-06: widget reports no panel as hidden before the panel ever opens", async () => {
		const env = createEnv();
		await env.start(`audit-widget-initial-${env.cwd}`);
		expect(env.widgets.get("grill")?.[0]).toContain("[hidden] /grill-panel to open");
	});

	test("CMD-02: no-args prompts for the idea; cancelled input aborts", async () => {
		const env = createEnv();
		env.ui.inputResponses.push(undefined);
		await env.start("");
		expect(env.widgets.size).toBe(0);
		expect(env.userMessages).toHaveLength(0);
		env.ui.inputResponses.push(`audit-prompted-${env.cwd}`);
		await env.start("   ");
		expect(env.widgets.get("grill")).toBeDefined();
		expect(env.userMessages).toHaveLength(1);
	});

	test("CMD-03: non-TUI mode refuses cleanly", async () => {
		const withUi = createEnv({ mode: "chat" });
		await withUi.start("audit-non-tui");
		expect(withUi.notifications).toContainEqual(expect.stringContaining("requires pi TUI mode"));
		expect(withUi.widgets.size).toBe(0);
		const withoutUi = createEnv({ mode: "chat", hasUI: false });
		await expect(withoutUi.start("audit-non-tui")).rejects.toThrow("requires Pi TUI mode");
	});

	test("CMD-04: resume keeps progress, discard restarts, cancel leaves no session", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "grill-audit-resume-"));
		tempDirs.push(cwd);
		const content = `audit-resume-${cwd}`;
		const first = createEnv({ cwd });
		await first.start(content);
		await publish(first, [question("Q1")]);
		first.component.handleInput(RIGHT);
		first.component.handleInput(ENTER);
		await first.shutdown();

		const resume = createEnv({ cwd });
		resume.ui.selectResponses.push("Resume");
		await resume.start(content);
		expect(resume.ui.selectCalls[0]).toContain("1 answered");
		expect(resume.widgets.get("grill")?.[0]).toContain("answered 1 / active 1");
		await resume.shutdown();

		const discard = createEnv({ cwd });
		discard.ui.selectResponses.push("Discard and restart");
		await discard.start(content);
		expect(discard.widgets.get("grill")?.[0]).toContain("answered 0 / active 0");
		expect(JSON.parse(readFileSync(statePathFor(cwd, content), "utf8")).questions).toEqual([]);
		await discard.shutdown();

		const cancel = createEnv({ cwd });
		cancel.ui.selectResponses.push("Cancel");
		await cancel.start(content);
		expect(cancel.widgets.size).toBe(0);
		await expect(publish(cancel, [question("Q9")])).rejects.toThrow("No active /grill session");
	});

	test("CMD-05: corrupt or old-schema state refuses to load and keeps the file", async () => {
		const env = createEnv();
		const content = `audit-corrupt-${env.cwd}`;
		const statePath = statePathFor(env.cwd, content);
		mkdirSync(dirname(statePath), { recursive: true });
		const corrupt = `${JSON.stringify({ schemaVersion: 1, questions: [] }, null, 2)}\n`;
		writeFileSync(statePath, corrupt, "utf8");
		await env.start(content);
		expect(env.notifications).toContainEqual(expect.stringContaining("could not be restored"));
		expect(env.notifications).toContainEqual(expect.stringContaining("delete or repair"));
		expect(env.widgets.size).toBe(0);
		expect(readFileSync(statePath, "utf8")).toBe(corrupt);
	});

	test("FS-01: same-named projects with the same idea never share state", async () => {
		const parentA = mkdtempSync(join(tmpdir(), "grill-audit-coll-a-"));
		const parentB = mkdtempSync(join(tmpdir(), "grill-audit-coll-b-"));
		tempDirs.push(parentA, parentB);
		const cwdA = join(parentA, "app");
		const cwdB = join(parentB, "app");
		mkdirSync(cwdA);
		mkdirSync(cwdB);
		const content = "audit-collision-same-idea";
		expect(statePathFor(cwdA, content)).not.toBe(statePathFor(cwdB, content));
		const envA = createEnv({ cwd: cwdA });
		await envA.start(content);
		await publish(envA, [question("Q1")]);
		envA.component.handleInput(RIGHT);
		envA.component.handleInput(ENTER);
		await envA.shutdown();
		const envB = createEnv({ cwd: cwdB });
		await envB.start(content);
		expect(envB.ui.selectCalls).toEqual([]);
		expect(envB.widgets.get("grill")?.[0]).toContain("answered 0 / active 0");
	});

	test("FS-02: a purged session directory neither crashes the host nor loses the next answer", async () => {
		const env = createEnv();
		const content = `audit-purge-${env.cwd}`;
		await env.start(content);
		await publish(env, [question("Q1")]);
		const statePath = statePathFor(env.cwd, content);
		rmSync(dirname(statePath), { recursive: true, force: true });
		env.component.handleInput(RIGHT);
		env.component.handleInput(ENTER);
		expect(existsSync(statePath)).toBe(true);
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].status).toBe("answered");
	});

	test("CMD-06/LIFE-03: rerunning targets the latest runtime for the cwd", async () => {
		const env = createEnv();
		const contentA = `audit-multi-a-${env.cwd}`;
		const contentB = `audit-multi-b-${env.cwd}`;
		await env.start(contentA);
		await publish(env, [question("QA")]);
		await env.start(contentB);
		const result = await publish(env, [question("QB")]);
		expect(result.details.state.content).toBe(contentB);
		env.ui.selectResponses.push("Resume");
		await env.start(contentA);
		const back = await publish(env, [question("QA2")]);
		expect(back.details.state.content).toBe(contentA);
		expect(back.details.state.questions.map((item: any) => item.id)).toEqual(["QA", "QA2"]);
	});
});

describe("grill_ask tool (TOOL)", () => {
	test("TOOL-02/TOOL-03: fails fast outside TUI mode or without a session", async () => {
		const env = createEnv();
		await env.start(`audit-tool-guard-${env.cwd}`);
		await expect(env.tools.get("grill_ask").execute("call", { questions: [question("Q1")] }, undefined, undefined, { ...env.context, mode: "chat" }))
			.rejects.toThrow("grill_ask requires Pi TUI mode");
		const bare = createEnv();
		await expect(publish(bare, [question("Q1")])).rejects.toThrow("No active /grill session");
	});

	test("TOOL-04: invalid batches are rejected atomically, including the empty batch", async () => {
		const env = createEnv();
		const content = `audit-tool-validate-${env.cwd}`;
		await env.start(content);
		const statePath = statePathFor(env.cwd, content);
		await expect(publish(env, [])).rejects.toThrow("at least one question is required");
		await expect(publish(env, [question("Q1"), question("Q1")])).rejects.toThrow("duplicate question ids in this batch");
		await expect(publish(env, [question("Q1", { section: "  " })])).rejects.toThrow("empty section");
		await expect(publish(env, [question("Q1", { options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })])).rejects.toThrow("duplicate option values");
		await expect(publish(env, [question("Q1", { recommended: "missing" })])).rejects.toThrow("recommendation is not an option");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions).toEqual([]);
		await publish(env, [question("Q1")]);
		await expect(publish(env, [question("Q1")])).rejects.toThrow("question id already exists: Q1");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions).toHaveLength(1);
	});

	test("TOOL-05: publishing supersedes the previous current question", async () => {
		const env = createEnv();
		const content = `audit-supersede-${env.cwd}`;
		await env.start(content);
		await publish(env, [question("Q1")]);
		await publish(env, [question("Q2")]);
		const disk = JSON.parse(readFileSync(statePathFor(env.cwd, content), "utf8"));
		const q1 = disk.questions.find((item: any) => item.id === "Q1");
		expect(q1.status).toBe("pending");
		expect(q1.statusNote).toContain("superseded by a newer question batch");
		expect(disk.currentQuestionId).toBe("Q2");
	});

	test("TOOL-08: transcript renderers produce compact components", async () => {
		const env = createEnv();
		const tool = env.tools.get("grill_ask");
		expect(tool.renderCall({ questions: [question("Q1"), question("Q2")] }, env.ui.theme)).toBeInstanceOf(Text);
		expect(tool.renderResult({ content: [{ type: "text", text: "published" }] }, {}, env.ui.theme)).toBeInstanceOf(Text);
	});
});

describe("state and external edits (STATE/PERSIST)", () => {
	test("STATE-08/STATE-02/PERSIST-03/PERSIST-04: external edit acceptance and rejection", async () => {
		const env = createEnv();
		const content = `audit-external-${env.cwd}`;
		await env.start(content);
		await publish(env, [question("Q1"), question("Q2")]);
		const statePath = statePathFor(env.cwd, content);

		const disk = JSON.parse(readFileSync(statePath, "utf8"));
		disk.questions.push({ ...question("Q3"), status: "pending" });
		disk.validQuestionCount = 3;
		writeFileSync(statePath, `${JSON.stringify(disk, null, 2)}\n`, "utf8");
		expect(await until(() => env.widgets.get("grill")?.[0]?.includes("active 3") ?? false)).toBe(true);

		const deleted = JSON.parse(readFileSync(statePath, "utf8"));
		deleted.questions = deleted.questions.filter((item: any) => item.id !== "Q2");
		deleted.validQuestionCount = 2;
		writeFileSync(statePath, `${JSON.stringify(deleted, null, 2)}\n`, "utf8");
		expect(await until(() => env.notifications.some((message) => message.includes("was deleted")))).toBe(true);
		expect(env.widgets.get("grill")?.[0]).toContain("active 3");

		env.component.handleInput(RIGHT);
		env.component.handleInput(ENTER);
		const answered = JSON.parse(readFileSync(statePath, "utf8"));
		expect(answered.questions.find((item: any) => item.id === "Q1").status).toBe("answered");
		const illegal = JSON.parse(readFileSync(statePath, "utf8"));
		illegal.questions.find((item: any) => item.id === "Q1").status = "pending";
		illegal.answeredCount = 0;
		writeFileSync(statePath, `${JSON.stringify(illegal, null, 2)}\n`, "utf8");
		expect(await until(() => env.notifications.some((message) => message.includes("illegal status transition")))).toBe(true);

		writeFileSync(statePath, "not json {{{", "utf8");
		expect(await until(() => env.notifications.some((message) => message.includes("could not be parsed")))).toBe(true);
		expect(env.widgets.get("grill")?.[0]).toContain("answered 1");
	});

	test("STATE-12: empty notes are rejected", () => {
		expect(() => applyNote({ notes: [] } as any, "   ")).toThrow("a note cannot be empty");
	});

	test("PERSIST-02: HTML mirror escapes markup", async () => {
		const env = createEnv();
		const content = `audit-html-${env.cwd}`;
		await env.start(content);
		await publish(env, [question("Q1", { question: "<script>alert(1)</script>?", options: [{ value: "yes", label: "<b>Yes</b>" }] })]);
		const html = readFileSync(statePathFor(env.cwd, content).replace(/\.json$/, ".html"), "utf8");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;b&gt;Yes&lt;/b&gt;");
	});

	test("PERSIST-06: widget never claims converged while open questions remain", async () => {
		const env = createEnv();
		await env.start(`audit-widget-open-${env.cwd}`);
		await publish(env, [question("Q1"), question("Q2")]);
		env.component.handleInput(RIGHT);
		env.component.handleInput(ENTER);
		const widget = env.widgets.get("grill")?.[0] ?? "";
		expect(widget).toContain("answered 1 / active 2");
		expect(widget).not.toContain("converged");
		expect(widget).toContain("Q2");
	});
});

describe("panel behaviours (PANEL)", () => {
	test("PANEL-04/PANEL-09: terminal rows render read-only and ignore edits", async () => {
		const env = createEnv();
		const content = `audit-readonly-${env.cwd}`;
		await env.start(content);
		await publish(env, [question("Q1")]);
		const statePath = statePathFor(env.cwd, content);
		env.component.handleInput(RIGHT);
		env.component.handleInput(ENTER);
		const disk = JSON.parse(readFileSync(statePath, "utf8"));
		disk.questions[0].status = "deprecated";
		disk.questions[0].statusNote = "deprecated for audit";
		disk.validQuestionCount = 0;
		delete disk.ui.selectedOptionByQuestion.Q1;
		delete disk.ui.optionScrollOffsetByQuestion.Q1;
		writeFileSync(statePath, `${JSON.stringify(disk, null, 2)}\n`, "utf8");
		expect(await until(() => env.widgets.get("grill")?.[0]?.includes("active 0") ?? false)).toBe(true);
		env.component.handleInput(ctrlDigit("1"));
		const rendered = env.component.render(120).join("\n");
		expect(rendered).toContain("Status: deprecated (read-only)");
		expect(rendered).toContain("Answer: Yes");
		expect(rendered).toContain("Status note: deprecated for audit");
		const before = readFileSync(statePath, "utf8");
		env.component.handleInput(ENTER);
		env.component.handleInput(CTRL_S);
		expect(readFileSync(statePath, "utf8")).toBe(before);
	});

	test("PANEL-17: external status change discards the open draft with a warning", async () => {
		const env = createEnv();
		const content = `audit-draft-${env.cwd}`;
		await env.start(content);
		await publish(env, [question("Q1", { options: [{ value: "yes", label: "Yes", requiresText: true }] })]);
		const statePath = statePathFor(env.cwd, content);
		env.component.handleInput(RIGHT);
		env.component.handleInput(ENTER);
		expect(env.component.render(120).join("\n")).toContain("Add detail (required)");
		const disk = JSON.parse(readFileSync(statePath, "utf8"));
		disk.questions[0].status = "skipped";
		disk.questions[0].statusNote = SKIP_STATUS_NOTE;
		disk.currentQuestionId = null;
		delete disk.ui.selectedOptionByQuestion.Q1;
		delete disk.ui.optionScrollOffsetByQuestion.Q1;
		writeFileSync(statePath, `${JSON.stringify(disk, null, 2)}\n`, "utf8");
		expect(await until(() => env.notifications.some((message) => message.includes("changed externally to skipped")))).toBe(true);
		expect(env.component.render(120).join("\n")).not.toContain("Add detail (required)");
	});

	test("PANEL-20: footer hints match the interaction mode", async () => {
		const env = createEnv();
		await env.start(`audit-hints-${env.cwd}`);
		await publish(env, [question("Q1")]);
		expect(env.component.render(120).join("\n")).toContain("↑↓ browse · Enter/→ answer");
		env.component.handleInput(RIGHT);
		expect(env.component.render(120).join("\n")).toContain("↑↓ select · Enter submit");
		env.component.handleInput(DOWN);
		env.component.handleInput(ENTER);
		expect(env.component.render(120).join("\n")).toContain("Type · Enter confirm · Esc back");
	});

	test("PANEL-08: out-of-range direct jumps are ignored", async () => {
		const env = createEnv();
		await env.start(`audit-jump-${env.cwd}`);
		await publish(env, [question("Q1"), question("Q2")]);
		const before = env.component.render(120).join("\n");
		env.component.handleInput(ctrlDigit("5"));
		expect(env.component.render(120).join("\n")).toBe(before);
	});

	test("PANEL-23: the toggle shortcut hides a focused panel and never commits a draft", async () => {
		const TOGGLE = "\u001b[103;7u"; // kitty CSI-u for ctrl+alt+g
		const env = createEnv();
		await env.start(`audit-toggle-${env.cwd}`);
		await publish(env, [question("Q1")]);
		expect(env.widgets.get("grill")?.[0]).toContain("[open] Esc to hide");
		env.component.handleInput(TOGGLE);
		expect(env.widgets.get("grill")?.[0]).toContain("[hidden] /grill-panel to open");
		expect(env.handle.setHiddenCalls.at(-1)).toBe(true);

		await env.commands.get("grill-panel").handler("", env.context);
		env.component.handleInput(RIGHT);
		env.component.handleInput(CTRL_N);
		expect(env.component.render(120).join("\n")).toContain("Note for the agent");
		env.component.handleInput(TOGGLE);
		expect(env.widgets.get("grill")?.[0]).toContain("[open] Esc to hide");
	});
});

describe("events and convergence (EVENT)", () => {
	test("EVENT-03: skips flow into the same batched answer stream", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const scheduled: Array<{ delay: number; callback: () => void }> = [];
		(globalThis as any).setTimeout = (callback: () => void, delay: number) => { scheduled.push({ callback, delay }); return scheduled.length; };
		(globalThis as any).clearTimeout = () => {};
		try {
			const env = createEnv();
			await env.start(`audit-skip-event-${env.cwd}`);
			await publish(env, [question("Q1")]);
			env.component.handleInput(RIGHT);
			env.component.handleInput(CTRL_S);
			scheduled.find((item) => item.delay === 500)!.callback();
			expect(env.messages).toHaveLength(1);
			expect(env.messages[0].message.customType).toBe("grill-answers");
			expect(env.messages[0].message.details.answers).toEqual([
				{ id: "Q1", value: "__skipped__", label: SKIP_STATUS_NOTE, index: 0, reason: "", status: "skipped" },
			]);
			const content = env.messages[0].message.content as string;
			expect(content).toContain("Open questions:");
			expect(content).toContain("Full state (sections, skipped, notes):");
			expect(content).not.toContain("Section index:");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	test("EVENT-05: no plan dialog for non-converge questions, open questions, or non-keyword answers", async () => {
		const env = createEnv();
		await env.start(`audit-no-dialog-${env.cwd}`);
		await publish(env, [question("Q2")]);
		await publish(env, [question("QF", { options: [{ value: "confirm", label: "确认生成" }, { value: "later", label: "Not yet" }] })], true);

		env.component.handleInput(RIGHT);
		env.component.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(env.ui.confirmCalls).toBe(0);

		env.component.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(env.ui.confirmCalls).toBe(0);

		env.component.handleInput(ctrlDigit("2"));
		env.component.handleInput(DOWN);
		env.component.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(env.ui.confirmCalls).toBe(0);
	});

	test("EVENT-07: declining the plan keeps the interview alive, reopens the panel, and stays confirmable", async () => {
		const env = createEnv();
		await env.start(`audit-decline-${env.cwd}`);
		await publish(env, [question("QF", { options: [{ value: "confirm", label: "确认生成" }] })], true);
		env.ui.confirmResponses.push(false);
		env.component.handleInput(RIGHT);
		env.component.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(env.ui.confirmCalls).toBe(1);
		expect(env.userMessages).toHaveLength(1);
		expect(env.widgets.get("grill")).toBeDefined();
		expect(env.widgets.get("grill")?.[0]).toContain("[open] Esc to hide");
		expect(env.handle.setHiddenCalls.at(-1)).toBe(false);

		env.ui.confirmResponses.push(true);
		env.component.handleInput(ctrlDigit("1"));
		env.component.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(env.ui.confirmCalls).toBe(2);
		expect(env.userMessages).toHaveLength(2);
		expect(env.userMessages[1]!.message).toContain("Interview transcript");
		expect(env.widgets.get("grill")).toBeUndefined();
	});

	test("CFG-03: custom keywords with regex metacharacters match literally", () => {
		const pending = new Set(["QF"]);
		const answer = { id: "QF", value: "opt", label: "确认(生成)", index: 1, reason: "" };
		expect(consumeConvergenceAnswer(pending, answer, true, ["确认(生成)"])).toBe(true);
		expect(consumeConvergenceAnswer(new Set(["QF"]), { ...answer, label: "确认X生成Y" }, true, ["确认(生成)"])).toBe(false);
	});
});

describe("lifecycle and prompts (LIFE/DOC)", () => {
	test("LIFE-01/LIFE-02: session shutdown cleans up completely and idempotently", async () => {
		const env = createEnv();
		await env.start(`audit-shutdown-${env.cwd}`);
		await publish(env, [question("Q1")]);
		expect(env.widgets.get("grill")).toBeDefined();
		await env.shutdown();
		expect(env.widgets.get("grill")).toBeUndefined();
		expect(env.handle.hideCalls).toBe(1);
		await expect(publish(env, [question("Q2")])).rejects.toThrow("No active /grill session");
		await env.shutdown();
	});

	test("DOC-03: plan prompt targets docs/plans, then plans, then docs/plans creation", async () => {
		const cases: Array<{ prepare: (cwd: string) => void; expected: (cwd: string) => string }> = [
			{ prepare: (cwd) => mkdirSync(join(cwd, "docs", "plans"), { recursive: true }), expected: (cwd) => join(cwd, "docs", "plans") },
			{ prepare: (cwd) => mkdirSync(join(cwd, "plans"), { recursive: true }), expected: (cwd) => join(cwd, "plans") },
			{ prepare: () => {}, expected: (cwd) => join(cwd, "docs", "plans") },
		];
		for (const { prepare, expected } of cases) {
			const env = createEnv();
			prepare(env.cwd);
			await env.start(`audit-plan-dir-${env.cwd}`);
			await publish(env, [question("QF", { options: [{ value: "confirm", label: "confirm" }] })], true);
			env.ui.confirmResponses.push(true);
			env.component.handleInput(RIGHT);
			env.component.handleInput(ENTER);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(env.userMessages).toHaveLength(2);
			expect(env.userMessages[1]!.message).toContain(`Target directory: ${expected(env.cwd)}`);
		}
	});

	test("DOC-04: tool results carry skipped questions and notes in the state summary", async () => {
		const env = createEnv();
		await env.start(`audit-summary-${env.cwd}`);
		expect(env.userMessages[0]!.message).toContain("(no questions yet)");
		await publish(env, [question("Q1")]);
		env.component.handleInput(RIGHT);
		env.component.handleInput(CTRL_S);
		env.component.handleInput(CTRL_N);
		for (const char of "note for summary") env.component.handleInput(char);
		env.component.handleInput(ENTER);
		const result = await publish(env, [question("Q2")]);
		const text = result.content[0].text as string;
		expect(text).toContain("Skipped (user chose to skip");
		expect(text).toContain("- Q1 (1. Background): Q1?");
		expect(text).toContain("User notes (not tied to a question):");
		expect(text).toContain("- note for summary");
	});
});
