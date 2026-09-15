# dsh-set-model

Dynamic model and reasoning depth switching plugin for DeepSeek Harness (DSH).

## Features

1. **Agent Autonomous Model & Thinking Depth Switching**:
   - `set_model({ provider?, model?, reasoningEffort? })`: Allows the agent to autonomously upgrade or downgrade its active model or reasoning effort based on task complexity.
   - `get_model()`: Inspects the active model, provider, reasoning depth, and Plan Mode status.
   - `list_models({ provider? })`: Queries available providers and registered models along with their capabilities (context window, reasoning support).

2. **Seamless Plan Mode Auto-Transition**:
   - Automatically switches to the configured high-reasoning planning model (e.g., `deepseek/deepseek-reasoner` or `claude-3-7-sonnet` high) when entering Plan Mode (`/plan on`).
   - Automatically restores the previous execution model when exiting Plan Mode (`exit_plan_mode` or `/plan off`).

3. **Safety & Guardrails**:
   - **Provider Whitelist**: Restrict switchable providers via `allowedProviders`.
   - **Context Window Protection**: Prevents switching to models whose context capacity is smaller than current session token pressure.
   - **Model Route Validation**: Validates candidate call configs against DSH's adapter registry before application.

## Configuration (Settings / cordis.yml)

Namespace: `dsh-set-model`

```yaml
dsh-set-model:
  planModel:
    provider: deepseek
    model: deepseek-reasoner
    reasoningEffort: high
  autoRestorePlanModel: true
  enableAgentTools: true
  allowedProviders: []
```

## License

MIT
