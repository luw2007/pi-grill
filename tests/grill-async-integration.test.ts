import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import grillModule from "/Users/luwei.will/.pi/agent/extensions/grill.ts";

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
	const eventHandlers = new Map<string, Array<(...args: any[]) => any>>();
	const messages: any[] = [];
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
		confirm: async () => false,
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
		on(name: string, handler: any) { const list = eventHandlers.get(name) ?? []; list.push(handler); eventHandlers.set(name, list); },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
		sendUserMessage() {},
	};
	grillExtension(pi);
	const initialContent = `integration-${cwd}`;
	const kickoff = commands.get("grill").handler(initialContent, context);
	return { cwd, initialContent, kickoff, tools, commands, messages, customCalls, handle, widgets, get component() { return component; }, get done() { return done; }, context, notifications, panel };
}

function question(id: string, section = "① 背景与问题", requiresText = false) {
	return { id, section, question: `${id}?`, options: [{ value: "yes", label: "Yes", ...(requiresText ? { requiresText: true } : {}) }] };
}

async function publish(env: ReturnType<typeof setup>, ids = ["Q1"]) {
	return env.tools.get("grill_ask").execute("call", { questions: ids.map((id) => question(id)) }, undefined, undefined, env.context);
}

async function publishQuestions(env: ReturnType<typeof setup>, questions: any[]) {
	return env.tools.get("grill_ask").execute("call", { questions }, undefined, undefined, env.context);
}

describe("asynchronous grill integration", () => {
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

	test("keeps widget visibility state correct across hide, refresh, command, and publish", async () => {
		const env = setup();
		await env.kickoff;
		await publish(env, ["Q1"]);
		expect(env.component.render(120).join("\n")).toContain("Esc 隐藏面板");
		expect(env.widgets.get("grill")?.[0]).toBe("grill · 已答 0 / 有效 1 · 当前 Q1 · [展开] 按 Esc 隐藏");

		env.component.handleInput("\u001b");
		expect(env.handle.setHiddenCalls).toEqual([false, true]);
		expect(env.handle.unfocusCalls).toEqual([undefined]);
		expect(env.panel.promise).toBeInstanceOf(Promise);
		expect(env.widgets.get("grill")?.[0]).toBe("grill · 已答 0 / 有效 1 · 当前 Q1 · [隐藏] /grill-panel 展开");

		const statePath = [...env.widgets.values()][0]?.[1] as string;
		const background = JSON.parse(readFileSync(statePath, "utf8"));
		background.questions.push({ ...question("Q-background"), status: "pending" });
		background.validQuestionCount = 2;
		await Bun.write(statePath, `${JSON.stringify(background, null, 2)}\n`);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(env.widgets.get("grill")?.[0]).toBe("grill · 已答 0 / 有效 2 · 当前 Q1 · [隐藏] /grill-panel 展开");

		await env.commands.get("grill-panel").handler("", env.context);
		expect(env.customCalls).toHaveLength(1);
		expect(env.handle.setHiddenCalls).toEqual([false, true, false]);
		expect(env.handle.focusCalls).toBe(2);
		expect(env.widgets.get("grill")?.[0]).toBe("grill · 已答 0 / 有效 2 · 当前 Q1 · [展开] 按 Esc 隐藏");

		env.component.handleInput("\u001b");
		await publish(env, ["Q2"]);
		expect(env.customCalls).toHaveLength(1);
		expect(env.handle.setHiddenCalls).toEqual([false, true, false, true, false]);
		expect(env.handle.focusCalls).toBe(3);
		expect(env.widgets.get("grill")?.[0]).toBe("grill · 已答 0 / 有效 3 · 当前 Q2 · [展开] 按 Esc 隐藏");
		expect(env.component.render(120).join("\n")).toContain("Q2");
	});

	test("requiresText needs non-empty supplement, Esc returns to select, then second Esc hides", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [question("Q1", "① 背景与问题", true)]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		expect(env.component.render(120).join("\n")).toContain("补充说明（必填）");
		env.component.handleInput("\r");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].status).toBe("current");
		expect(env.component.render(120).join("\n")).toContain("补充说明（必填）");
		env.component.handleInput("\u001b");
		expect(env.component.render(120).join("\n")).not.toContain("补充说明（必填）");
		expect(env.handle.setHiddenCalls).toEqual([false]);
		expect(env.widgets.get("grill")?.[0]).toContain("[展开] 按 Esc 隐藏");
		env.component.handleInput("\u001b");
		expect(env.handle.setHiddenCalls).toEqual([false, true]);
		expect(env.handle.unfocusCalls.at(-1)).toBeUndefined();
		expect(env.widgets.get("grill")?.[0]).toContain("[隐藏] /grill-panel 展开");
	});

	test("requiresText commits its supplement as reason", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [question("Q1", "① 背景与问题", true)]);
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
		expect(env.component.render(120).join("\n")).toContain("输入自定义选项（必填）");
		env.component.handleInput("\r");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].status).toBe("current");
		for (const char of "Custom answer") env.component.handleInput(char);
		env.component.handleInput("\r");
		const answered = JSON.parse(readFileSync(statePath, "utf8")).questions[0];
		expect(answered.status).toBe("answered");
		expect(answered.userChoice).toBe("Custom answer");
		expect(answered.reason).toBe("");
		expect(env.component.render(120).join("\n")).not.toContain("理由");
	});

	test("Ctrl+1..Ctrl+0 directly select ledger Q1..Q10 in the answer pane", async () => {
		const env = setup();
		await env.kickoff;
		await publish(env, Array.from({ length: 10 }, (_, index) => `Q${index + 1}`));
		for (const [key, id] of [["1", "Q1"], ["9", "Q9"], ["0", "Q10"]] as const) {
			env.component.handleInput(`\u001b[${key.charCodeAt(0)};5u`);
			const rendered = env.component.render(160).join("\n");
			expect(rendered).toContain("答题区 ◀");
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
		expect(env.component.render(120).join("\n")).toContain("答题区 ◀");
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
		expect(rendered).toContain("全部题目已回答");
		expect(rendered).toContain("只读完成摘要");
		expect(rendered).not.toContain(">  1. Yes");
		const disk = JSON.parse(readFileSync(statePath, "utf8"));
		expect(disk.ui.selectedQuestionId).toBeNull();
		expect(disk.ui.activeSurface).toBe("submit");
		expect(env.widgets.get("grill")?.[0]).toContain("当前 已收敛");
	});

	test("explicit navigation after completion can reopen and overwrite answered Q1", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [{
			id: "Q1", section: "① 背景与问题", question: "Q1?",
			options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
		}]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		expect(env.component.render(120).join("\n")).toContain("全部题目已回答");
		env.component.handleInput("\u001b[49;5u");
		expect(env.component.render(120).join("\n")).toContain("答题区 ◀");
		env.component.handleInput("\u001b[B");
		env.component.handleInput("\r");
		expect(JSON.parse(readFileSync(statePath, "utf8")).questions[0].userChoice).toBe("Beta");
		expect(env.component.render(120).join("\n")).toContain("全部题目已回答");
	});

	test("external pending question exits completion without reopening or focusing a hidden panel", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publish(env, ["Q1"]);
		const statePath = published.details.statePath as string;
		env.component.handleInput("\u001b[C");
		env.component.handleInput("\r");
		env.component.handleInput("\u001b");
		const focusCalls = env.handle.focusCalls;
		const background = JSON.parse(readFileSync(statePath, "utf8"));
		background.questions.push({ ...question("Q-new"), status: "current" });
		background.currentQuestionId = "Q-new";
		background.validQuestionCount = 2;
		await Bun.write(statePath, `${JSON.stringify(background, null, 2)}\n`);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(env.handle.focusCalls).toBe(focusCalls);
		expect(env.widgets.get("grill")?.[0]).toContain("[隐藏]");
		expect(env.component.render(120).join("\n")).toContain("Q-new?");
		expect(env.component.render(120).join("\n")).not.toContain("全部题目已回答");
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
				id: "Q1", section: "① 背景与问题", question: "Q1?",
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

	test("emergency keys restore editor focus and never commit drafts", async () => {
		const env = setup();
		await env.kickoff;
		const published = await publishQuestions(env, [question("Q1", "① 背景与问题", true)]);
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
