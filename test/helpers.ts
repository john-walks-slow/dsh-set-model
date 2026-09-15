import { Session, SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";

export function createMockSession(id: string = "test-session-1"): Session {
	return Session.create(id as never);
}

export function eventsOf(session: Session): SessionEvent[] {
	return session.snapshotEvents() as SessionEvent[];
}

export function createMockContext(): {
	ctx: Context;
	providers: any[];
	modelsMap: Record<string, any[]>;
	resolvedConfigs: Record<string, any>;
	tokenPressure: number;
} {
	const providers = [
		{ id: "deepseek", name: "DeepSeek" },
		{ id: "anthropic", name: "Anthropic" },
		{ id: "openai", name: "OpenAI" }
	];

	const modelsMap: Record<string, any[]> = {
		deepseek: [
			{ id: "deepseek-chat", name: "DeepSeek V3", description: "General purpose model" },
			{ id: "deepseek-reasoner", name: "DeepSeek R1", description: "Reasoning model" }
		],
		anthropic: [
			{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", description: "Fast & smart" },
			{ id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", description: "Hybrid reasoning" }
		]
	};

	const modelsInfoMap: Record<string, any> = {
		"deepseek/deepseek-chat": {
			id: "deepseek-chat",
			name: "DeepSeek V3",
			context: { contextWindow: 64000 }
		},
		"deepseek/deepseek-reasoner": {
			id: "deepseek-reasoner",
			name: "DeepSeek R1",
			context: { contextWindow: 64000 },
			reasoning: {
				efforts: [
					{ id: "low", name: "Low" },
					{ id: "high", name: "High" },
					{ id: "max", name: "Max" }
				],
				defaultEffort: "high"
			}
		},
		"anthropic/claude-3-5-sonnet": {
			id: "claude-3-5-sonnet",
			name: "Claude 3.5 Sonnet",
			context: { contextWindow: 200000 }
		},
		"anthropic/claude-3-7-sonnet": {
			id: "claude-3-7-sonnet",
			name: "Claude 3.7 Sonnet",
			context: { contextWindow: 200000 },
			reasoning: {
				efforts: [
					{ id: "off", name: "Off" },
					{ id: "low", name: "Low" },
					{ id: "high", name: "High" },
					{ id: "max", name: "Max" }
				],
				defaultEffort: "off"
			}
		}
	};

	let tokenPressure = 1000;

	const ctx: any = {
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {}
		},
		llm: {
			listProviders: () => providers,
			listModels: async (provider: string) => modelsMap[provider] || [],
			resolveModelInfo: async (provider: string, model: string) => {
				const key = `${provider}/${model}`;
				if (!modelsInfoMap[key]) {
					throw new Error(`Model info not found for ${key}`);
				}
				return modelsInfoMap[key];
			},
			resolveCallConfig: async (config: any) => {
				const key = `${config.provider}/${config.model}`;
				if (!modelsInfoMap[key]) {
					throw new Error(`Unknown route ${key}`);
				}
				return {
					provider: config.provider,
					model: config.model,
					...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {})
				};
			}
		},
		tokenMeter: {
			measure: (_session: any) => ({
				totalTokens: tokenPressure,
				surfaceTokens: tokenPressure,
				nodes: []
			})
		},
		sessionProjections: {
			states: new Map<string, any>(),
			stateOf(session: any, key: string) {
				return this.states.get(`${session.id || session}:${key}`);
			},
			setState(session: any, key: string, state: any) {
				this.states.set(`${session.id || session}:${key}`, state);
			}
		},
		agentDefaultModel: {
			currentSelection: () => ({
				provider: "deepseek",
				model: "deepseek-chat"
			})
		},
		agents: {
			rootsList: [] as Agent[],
			roots() {
				return this.rootsList;
			}
		},
		systemPrompt: {
			section(_sec: any) {
				return () => {};
			},
			context(_ctx: any) {
				return () => {};
			}
		},
		inject(deps: string[], cb: (injectedCtx: any) => void) {
			cb(ctx);
		},
		on(_event: string, _handler: any) {
			return () => {};
		}
	};

	return {
		ctx,
		providers,
		modelsMap,
		resolvedConfigs: modelsInfoMap,
		get tokenPressure() {
			return tokenPressure;
		},
		set tokenPressure(val: number) {
			tokenPressure = val;
		}
	};
}

export function createMockAgent(session: Session, ctx: Context, options: any = {}): Agent {
	const registeredTools = new Map<string, any>();
	const agent: any = {
		session,
		options: {
			provider: "deepseek",
			model: "deepseek-chat",
			...options
		},
		ctx: {
			tools: {
				register(tool: any) {
					registeredTools.set(tool.name, tool);
				},
				get(name: string) {
					return registeredTools.get(name);
				}
			}
		}
	};
	return agent as Agent;
}
