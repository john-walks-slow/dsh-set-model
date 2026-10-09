/**
 * Browser half of dsh-set-model: contributes the "模型档位" page to the DSH
 * settings panel, over the `set-model` settings namespace the host plugin owns.
 *
 * Registration goes through `slots.inject("settings.section", …)`: the settings
 * shell declares that slot, and a direct register races the declaration — the
 * page would then silently never mount.
 *
 * Mounting problems are logged, never thrown — an external plugin must not take
 * the GUI down.
 */

import { ModelPolicyPanel, type ModelPolicyPanelProps } from "./panel.js";

/** Required client services (fiber inject waiting — the runtime must be up first). */
export const inject = ["slots", "remote", "remote.settings", "remote.session"];

interface SectionEntry {
	name: "settings.section";
	id: string;
	order: number;
	label: () => string;
	inject: () => { remote?: ModelPolicyPanelProps["remote"] };
}

interface ClientContext {
	slots: {
		inject(slot: string, register: () => unknown): void;
		register(entry: SectionEntry, component: unknown): unknown;
	};
	get(name: string, strict?: boolean): unknown;
}

export function apply(ctx: ClientContext): void {
	// The remote RPC is passed through the slot inject so the panel resolves it
	// from this plugin's own context rather than importing another plugin's value.
	const injectRemote = (): { remote?: ModelPolicyPanelProps["remote"] } => {
		try {
			const remote = ctx.get("remote", false) as ModelPolicyPanelProps["remote"] | undefined;
			return remote === undefined ? {} : { remote };
		} catch {
			return {};
		}
	};

	try {
		ctx.slots.inject("settings.section", () =>
			ctx.slots.register(
				{
					name: "settings.section",
					id: "model-policy",
					order: 132,
					label: () => "模型档位",
					inject: injectRemote
				},
				ModelPolicyPanel
			)
		);
		console.info("[dsh-set-model] settings.section mounted");
	} catch (error) {
		console.error("[dsh-set-model] settings.section registration failed", error);
	}
}
