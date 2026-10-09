/**
 * Build the browser half (src/client) into lib/client.js in the web shell's
 * lazy-CJS bundle format: window.__ModuleLoader__.load({ id, factory }).
 *
 * `id` MUST equal the package name: the shell's combo bundle registers factories
 * by that id, and a mismatch executes the whole application combo a second time
 * (duplicate factory registration) — the GUI then fails to load every plugin.
 *
 * External specifiers (react, react-dom/*, @deepseek-ai/*) stay shared requires
 * resolved by the shell's module table at runtime.
 */
import { build } from "esbuild";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const PACKAGE_NAME = "dsh-set-model";
const outBundle = "lib/client.bundle.js";

await rm(outBundle, { force: true });
await mkdir("lib", { recursive: true });
await build({
	entryPoints: ["src/client/index.ts"],
	bundle: true,
	format: "cjs",
	platform: "browser",
	outfile: outBundle,
	jsx: "automatic",
	target: "es2022",
	sourcemap: false,
	external: ["react", "react-dom/*", "react/jsx-runtime", "@deepseek-ai/*"],
	logLevel: "info"
});

const body = await readFile(outBundle, "utf8");
const wrapped = [
	"window.__ModuleLoader__.load({",
	`\tid: "${PACKAGE_NAME}",`,
	"\tfactory: (require) => {",
	"\t\tvar module = { exports: {} };",
	"\t\tvar exports = module.exports;",
	'\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
	body,
	"\t\treturn module.exports;",
	"\t}",
	"});"
].join("\n");

await writeFile("lib/client.js", wrapped, "utf8");
await rm(outBundle, { force: true });

// A syntax error here breaks the whole combo bundle, and the browser only
// reports it as an unrelated entry "loaded without registering". `node --check`
// catches it without a browser.
execFileSync(process.execPath, ["--check", "lib/client.js"], { stdio: "inherit" });

console.log("lib/client.js written:", wrapped.length, "chars");
