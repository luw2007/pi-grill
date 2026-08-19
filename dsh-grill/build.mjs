/**
 * dsh-grill build: node half (ESM, externals preserved) + browser half
 * (CJS closure-factory bundle for window.__ModuleLoader__). Mirrors the DSH
 * clientBundle contract: externals = the platform module table, CSS modules
 * inlined as <style data-plugin> injection with hashed class maps.
 */

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PKG_ID = "dsh-grill";

// DSH shell platform modules (source of truth: packages/client/web/src/platform.ts
// in the deepseek-harness checkout) plus the documented runtime exemption.
const PLATFORM_EXTERNALS = [
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-web-react",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-attachment",
	"@deepseek-ai/dsh-client-schema-form",
	"@deepseek-ai/dsh-client-runtime/client",
];

const cssPlugin = {
	name: "dsh-grill-css-modules",
	setup(build) {
		build.onResolve({ filter: /\.module\.css$/ }, (args) => ({
			path: resolve(args.resolveDir, args.path),
			namespace: "grill-css",
		}));
		build.onLoad({ filter: /.*/, namespace: "grill-css" }, (args) => {
			const source = readFileSync(args.path, "utf8");
			const contentHash = createHash("sha1").update(source).digest("hex").slice(0, 8);
			const classMap = {};
			for (const match of source.matchAll(/\.([_a-zA-Z][_a-zA-Z0-9-]*)\s*{/g)) {
				const local = match[1];
				if (local) classMap[local] = contentHash + "_" + local;
			}
			const css = source.replace(/\.([_a-zA-Z][_a-zA-Z0-9-]*)(?=\s*[,{.])/g, (match, local) => {
				return classMap[local] ? "." + classMap[local] : match;
			});
			const tagId = PKG_ID + "/" + args.path.split("/").pop();
			const js = [
				"const css = " + JSON.stringify(css) + ";",
				"const tagId = " + JSON.stringify(tagId) + ";",
				"if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
				"  const tag = document.createElement('style');",
				"  tag.dataset.plugin = " + JSON.stringify(PKG_ID) + ";",
				"  tag.dataset.pluginCss = tagId;",
				"  tag.textContent = css;",
				"  document.head.appendChild(tag);",
				"}",
				"export default " + JSON.stringify(classMap) + ";",
			].join("\n");
			return { contents: js, loader: "js", resolveDir: dirname(args.path) };
		});
	},
};

mkdirSync(join(ROOT, "lib"), { recursive: true });

// Node half: one bundled ESM file; @deepseek-ai/* and node: stay external.
await build({
	entryPoints: ["src/index.ts"],
	outfile: "lib/index.js",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	external: ["@deepseek-ai/*", "node:*"],
	sourcemap: false,
});

// Browser half: the __ModuleLoader__ closure-factory bundle.
await build({
	entryPoints: ["src/client/index.tsx"],
	outfile: "lib/client.js",
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2020",
	jsx: "automatic",
	external: PLATFORM_EXTERNALS,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	plugins: [cssPlugin],
	banner: { js: "window.__ModuleLoader__.load({ id: " + JSON.stringify(PKG_ID) + ", factory: (require) => { var module = { exports: {} }; var exports = module.exports;" },
	footer: { js: "return module.exports; } });" },
});

console.log("dsh-grill built: lib/index.js + lib/client.js");