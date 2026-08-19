/**
 * State file persistence: atomic JSON writes, the HTML mirror, and session
 * path derivation (same naming scheme as pi-grill so a session can be shared).
 * @module dsh-grill/persist
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { migrateState, type GrillQuestion, type GrillState } from "./state.ts";

export type SessionPaths = {
	directory: string;
	json: string;
	html: string;
};

export function sessionPaths(cwd: string, content: string, baseDir: string): SessionPaths {
	// basename alone collides across same-named projects; a cwd digest keeps the path unique per project.
	const project = `${path.basename(cwd) || "root"}-${createHash("sha1").update(cwd).digest("hex").slice(0, 8)}`;
	const directory = path.join(baseDir, project);
	const digest = createHash("sha1").update(content).digest("hex");
	return {
		directory,
		json: path.join(directory, `${digest}.json`),
		html: path.join(directory, `${digest}.html`),
	};
}

export function readJsonState(file: string): GrillState {
	return migrateState(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true }); // self-heal after dir purges
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, content, "utf8");
	fs.renameSync(temporary, file);
}

function htmlEscape(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll(String.fromCharCode(34), "&quot;")
		.replaceAll(String.fromCharCode(39), "&#39;");
}

function questionHtml(question: GrillQuestion): string {
	const statusLabel = {
		pending: "Pending",
		current: "◀ Current",
		answered: "🔒 Answered",
		skipped: "↷ Skipped",
		deprecated: "Deprecated",
		removed: "Removed",
	}[question.status];
	const options = question.options.map((option) => {
		const recommended = option.value === question.recommended ? " class=\"recommended\"" : "";
		const marker = option.value === question.recommended ? " <strong>Recommended</strong>" : "";
		const description = option.description ? `<small>${htmlEscape(option.description)}</small>` : "";
		return `<li${recommended}>${htmlEscape(option.label)}${marker}${description}</li>`;
	}).join("");
	const choice = question.userChoice ? `<p class="choice">Answer: ${htmlEscape(question.userChoice)}${question.reason ? `<br>Reason: ${htmlEscape(question.reason)}` : ""}</p>` : "";
	const note = question.statusNote ? `<p class="note">Status note: ${htmlEscape(question.statusNote)}</p>` : "";
	return `<article id="${htmlEscape(question.id)}" class="card ${question.status}"><header><code>${htmlEscape(question.id)}</code><span class="status">${statusLabel}</span></header><h2>${htmlEscape(question.question)}</h2><ol>${options}</ol>${question.recommendationReason ? `<p class="recommendation">Why recommended: ${htmlEscape(question.recommendationReason)}</p>` : ""}${choice}${note}</article>`;
}

const HTML_CSS = `.page-title{font:700 clamp(28px,5vw,46px)/1.15 Georgia,"Songti SC",serif;margin:8px 0}.meta,code,small{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.progress{display:inline-block;background:#eadfca;padding:5px 9px;border-radius:5px}.card{background:var(--paper);border:1px solid var(--rule);border-radius:10px;padding:16px 18px;margin:12px 0}.card.current{background:var(--current);border:2px solid #a15e1d}.card.answered{background:var(--ok);border-color:#9db28e}.card.deprecated{background:var(--danger);opacity:.7}.card.removed{opacity:.5}.card header{display:flex;gap:8px;align-items:center}.card h2{font-size:18px;margin:8px 0}.card ol{margin:0;padding-left:20px}.card li{margin:5px 0}.card li small{display:block;margin-left:4px}.card li.recommended{color:var(--green);font-weight:700}.status{font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#d0dec8;color:var(--green);padding:2px 6px;border-radius:4px}.current .status{background:#f0d4a0;color:#8b4e15}.deprecated .status,.removed .status{background:#e5c7be;color:#7b4032}.choice{font-weight:700;color:var(--green)}.note{font-size:12px;color:#7b4032}@media(prefers-color-scheme:dark){:root{--canvas:#201d19;--paper:#2b2722;--ink:#eee8dd;--muted:#b7afa2;--rule:#554d43;--ok:#34402d;--current:#493a26;--danger:#4a3029}.progress{background:#40372c}.status{background:#42543a;color:#c8d9bb}}@media print{body{background:#fff}.card{break-inside:avoid}}`;
const HTML_EXTRA = '@media(prefers-color-scheme:dark){:root{--canvas:#201d19;--paper:#2b2722;--ink:#eee8dd;--muted:#b7afa2;--rule:#554d43;--ok:#34402d;--current:#493a26;--danger:#4a3029;--pending:#312f2b}}@media print{body{background:#fff}.card{break-inside:avoid}}';

const HTML_SKELETON = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>Grill · ${"TITLE"}</title><style>:root{--canvas:#f4efe5;--paper:#fffdf8;--ink:#2c2924;--muted:#746c61;--rule:#d8cfbf;--ok:#e5eee0;--green:#4e714f;--current:#f7ead0;--danger:#ead6cf}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif}main{max-width:960px;margin:auto;padding:36px 20px 72px}header.page{border-bottom:1px solid var(--ink);padding-bottom:20px;margin-bottom:22px}${"CSS"}${"EXTRA"}</style></head><body><main><header class="page"><div class="meta">DSH EXTENSION · LIVE DESIGN INTERVIEW</div><h1 class="page-title">${"TITLE2"}</h1><p class="progress">Answered ${"ANSW"} / active ${"ACT"}</p><p class="meta">Rendered ${"UPD"} · refreshes every 3s</p></header>${"CARDS"}</main></body></html>';

export function renderHtml(paths: SessionPaths, state: GrillState): void {
	const cards = state.questions.map(questionHtml).join("\n");
	const html = HTML_SKELETON
		.replace('${"TITLE"}', htmlEscape(state.content))
		.replace('${"TITLE2"}', htmlEscape(state.content))
		.replace('${"CSS"}', HTML_CSS)
		.replace('${"ANSW"}', String(state.answeredCount))
		.replace('${"ACT"}', String(state.validQuestionCount))
		.replace('${"UPD"}', htmlEscape(state.updatedAt))
		.replace('${"CARDS"}', cards)
		.replace('${"EXTRA"}', HTML_EXTRA);
	writeAtomic(paths.html, html);
}