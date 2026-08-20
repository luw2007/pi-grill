/**
 * State file persistence: atomic JSON writes and session path derivation
 * (same naming scheme as pi-grill so a session can be shared).
 * @module dsh-grill/persist
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { migrateState, type GrillState } from "./state.ts";

export type SessionPaths = {
	directory: string;
	json: string;
};

export function sessionPaths(cwd: string, content: string, baseDir: string): SessionPaths {
	// basename alone collides across same-named projects; a cwd digest keeps the path unique per project.
	const project = `${path.basename(cwd) || "root"}-${createHash("sha1").update(cwd).digest("hex").slice(0, 8)}`;
	const directory = path.join(baseDir, project);
	const digest = createHash("sha1").update(content).digest("hex");
	return {
		directory,
		json: path.join(directory, `${digest}.json`),
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