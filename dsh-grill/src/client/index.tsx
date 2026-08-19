/**
 * dsh-grill browser half: registers the grill badge + panel into the
 * shell.overlay list slot. Host authority; this face only reads and posts.
 * @module dsh-grill/client
 */

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import { GrillOverlay } from "./GrillOverlay.tsx";

export const inject = ["slots"];

export function apply(ctx: ClientContext): void {
	ctx.effect(() => ctx.slots.register({
		name: "shell.overlay",
		id: "dsh-grill",
	}, GrillOverlay), "dsh-grill: overlay");
}