// e2e verification for dsh-set-model's browser half:
//   1. the GUI boots with the plugin's client bundle loaded (no page/console errors)
//   2. the "模型档位" settings page registers and reads the `set-model` namespace
//   3. the page writes the preset table through the settings RPC, and the value
//      survives a reload (host re-applied the plugin from the new config)
// Run with:
//   dsh-e2e start --wait-ready --patch e2e/fixture/cordis.patch.yml
//   dsh-e2e run e2e/verify-policy-page.mjs
// Override DSH_E2E_PLAYWRIGHT / DSH_E2E_BROWSER when playwright or camoufox live elsewhere.
const playwrightPath = process.env.DSH_E2E_PLAYWRIGHT ?? "/root/projects/camoufox-mcp/node_modules/playwright-core/index.js";
const browserPath = process.env.DSH_E2E_BROWSER ?? "/root/.cache/camoufox/camoufox-bin";

// playwright-core is CJS: the namespace default is module.exports.
const { firefox } = (await import(playwrightPath)).default;
const url = `http://127.0.0.1:${process.env.DSH_E2E_PORT}/?token=${process.env.DSH_E2E_TOKEN || "e2etest"}`;

let pass = 0;
let fail = 0;
function check(condition, label) {
	if (condition) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.log(`  ✗ ${label}`);
	}
}

const browser = await firefox.launch({
	executablePath: browserPath,
	headless: true,
	args: ["--no-remote"],
	env: { ...process.env, MOZ_WEBGL_FORCE_ENABLE: "1", LIBGL_ALWAYS_SOFTWARE: "1" }
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
	if (message.type() === "error") consoleErrors.push(message.text());
});

/** Per-run probe values: matching the seed (or a previous run) must not pass. */
const PROBE = `probe-${Date.now()}`;

const DISMISS_LABELS = ["Configure later", "Continue", "Got it", "Skip", "Close"];

/** Dismiss first-run dialogs (Preview Notice, API-key onboarding) that block the shell. */
async function dismissDialogs() {
	for (let attempt = 0; attempt < 5; attempt++) {
		const dialogs = page.locator('[role="dialog"], [role="alertdialog"]');
		if ((await dialogs.count()) === 0) return;
		let clicked = false;
		for (const label of DISMISS_LABELS) {
			const button = dialogs.first().getByRole("button", { name: label });
			if (await button.count()) {
				await button.first().click({ force: true });
				clicked = true;
				break;
			}
		}
		if (!clicked) return;
		await page.waitForTimeout(1200);
	}
}

async function openModelPolicyPage() {
	await dismissDialogs();
	await page.getByRole("button", { name: "Settings" }).click({ force: true });
	await page.waitForTimeout(2000);
	await page.getByRole("button", { name: "模型档位" }).click();
	await page.waitForTimeout(1500);
}

/**
 * Wait for a transient note to show up. A save resolves only after the host
 * re-composed the profile, so its latency varies; a fixed sleep is flaky.
 */
async function waitForNote(text, timeout = 8000) {
	try {
		await page.waitForFunction(
			(needle) => (document.body.innerText || "").includes(needle),
			text,
			{ timeout }
		);
		return true;
	} catch {
		return false;
	}
}

/** First non-empty option value of a select, as a usable choice. */
async function firstOption(select) {
	const values = await select.locator("option").evaluateAll((options) =>
		options.map((option) => option.value).filter((value) => value !== "")
	);
	return values[0];
}

console.log("=== STAGE 1: boot ===");
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(9000);
check(pageErrors.length === 0, `no pageerror (${pageErrors.length})`);
if (pageErrors.length) console.log("   ", pageErrors.slice(0, 5));
check(consoleErrors.length === 0, `no console.error (${consoleErrors.length})`);
if (consoleErrors.length) console.log("   ", consoleErrors.slice(0, 5));

console.log("=== STAGE 2: settings page registers ===");
await openModelPolicyPage();
const panelText = await page.evaluate(() => document.body.innerText || "");
check(panelText.includes("模型档位"), "settings section label visible");
check(panelText.includes("档位模式"), "model policy page body rendered");
check(!panelText.includes("未找到设置命名空间"), "`set-model` namespace resolved");
check(!panelText.includes("设置服务不可用"), "settings RPC available");
check(panelText.includes("自由模式"), "mode radios rendered");

console.log("=== STAGE 3: edit and save through the page ===");
const presetIds = await page.locator('input[placeholder="daily"]').evaluateAll((nodes) => nodes.map((n) => n.value));
check(presetIds.join(",") === "daily,deep", `preset table reads the configured presets (${presetIds.join(",")})`);
check(await page.getByRole("radio").nth(1).isChecked(), "preset mode is the live mode");

const providerSelect = page.locator("select").first();
const provider = await firstOption(providerSelect);
check(Boolean(provider), `catalog offered a route (${provider ?? "none"})`);

const prompt = page.getByPlaceholder(/例如：规划与架构设计/);
await page.getByPlaceholder("日常执行").first().fill(PROBE);
await prompt.fill(`e2e 探针 ${PROBE}：规划先切 deep。`);

await page.getByRole("button", { name: "保存并生效" }).click();
check(await waitForNote("已保存并热生效"), "save reported success");
const afterSave = await page.evaluate(() => document.body.innerText || "");
check(!afterSave.includes("保存失败"), "save reported no failure");

// A second save proves the page picked up the revision the first write bumped:
// a stale revision would be refused as a conflict.
await page.waitForTimeout(2700); // let the first note self-clear, so this one proves itself
await page.getByRole("button", { name: "保存并生效" }).click();
check(await waitForNote("已保存并热生效"), "second save accepted (revision refreshed)");
const afterSecondSave = await page.evaluate(() => document.body.innerText || "");
check(!afterSecondSave.includes("保存失败"), "second save reported no failure");

console.log("=== STAGE 4: the value survives a reload ===");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
await openModelPolicyPage();
const savedName = await page.getByPlaceholder("日常执行").first().inputValue();
check(savedName === PROBE, `preset edit persisted after reload (got "${savedName}")`);
const savedPrompt = await page.getByPlaceholder(/例如：规划与架构设计/).inputValue();
check(savedPrompt === `e2e 探针 ${PROBE}：规划先切 deep。`, "policy prompt persisted after reload");

console.log("=== STAGE 5: the free-mode Plan target guard ===");
// A half-filled Plan target would be dropped by the host while the page claims
// success, so the page must refuse the save instead.
await page.getByRole("radio").first().check();
await page.waitForTimeout(500);
const planProvider = page.getByPlaceholder("deepseek").first();
await planProvider.fill("deepseek-official");
await page.getByRole("button", { name: "保存并生效" }).click();
await page.waitForTimeout(1500);
const halfFilled = await page.evaluate(() => document.body.innerText || "");
check(halfFilled.includes("需要同时填写 provider 与 model"), "half-filled Plan target refused before save");
check(!halfFilled.includes("已保存并热生效"), "half-filled Plan target reported no success");

await planProvider.fill("");
await page.waitForTimeout(2700); // clear the refusal note first
await page.getByRole("button", { name: "保存并生效" }).click();
check(await waitForNote("已保存并热生效"), "both Plan target fields empty saves as unset");

// Leave the profile on the mode the fixture seeds, so a rerun starts clean.
await page.getByRole("radio").nth(1).check();
await page.waitForTimeout(500);
await page.waitForTimeout(2700);
await page.getByRole("button", { name: "保存并生效" }).click();
check(await waitForNote("已保存并热生效"), "preset mode restored after the guard run");

console.log("=== RESULT ===");
check(pageErrors.length === 0, `no pageerror after full run (${pageErrors.length})`);
check(consoleErrors.length === 0, `no console.error after full run (${consoleErrors.length})`);
if (consoleErrors.length) console.log("   ", consoleErrors.slice(0, 5));

await browser.close();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
