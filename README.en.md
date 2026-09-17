# dsh-set-model

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

A DeepSeek Harness (DSH / cordis) plugin for **dynamic model and reasoning-effort switching**: the agent autonomously changes its provider, model and reasoningEffort via the `set_model` / `list_models` tools based on task difficulty, the plugin injects the active model into the runtime context, and models are upgraded/downgraded automatically alongside Plan Mode.

Switch to deep reasoning for hard problems, stay on the cost-effective tier for routine work — no manual configuration changes needed.

## What the model sees

Via `systemPrompt.context`, the plugin appends one line with the current active model to the tail of every step's Runtime Context snapshot (cache-safe append; the model can check itself at any time without calling a tool):

```
[Current active model: deepseek/deepseek-chat · reasoning: low]
```

While Plan Mode is active, a status marker is attached:

```
[Current active model: deepseek/deepseek-reasoner · reasoning: high] [Plan Mode Active]
```

### Tool: set_model

`set_model({ provider?, model?, reasoningEffort?, reason })` — `reason` is mandatory (every switch invalidates the session's KV cache, so the tool description requires the agent to justify the switch and avoid frequent changes):

```json
{ "model": "deepseek-reasoner", "reasoningEffort": "high", "reason": "Hard concurrency debugging, deep reasoning required" }
```

Tool output:

```
Model successfully switched to deepseek/deepseek-reasoner · reasoning: high. Effective from the next step.
Reason: Hard concurrency debugging, deep reasoning required
```

### Tool: list_models

`list_models({ provider? })` lists registered providers and model capabilities (reasoning efforts, context window):

```
# Available Providers & Models:

## Provider: deepseek
- **deepseek-reasoner** (DeepSeek Reasoner) | Reasoning: [low, high, max] | Context: 128000
- **deepseek-chat** (DeepSeek Chat) | Context: 128000
```

A switch takes effect from the next step: the plugin appends a `model/selection` event to the session (the same mechanism as the GUI model picker), and the Web UI state stays in sync.

## Plan Mode auto-transition

The plugin watches the plan projection state on `agent/pre-step` — zero manual intervention:

- **Entering Plan Mode** (`/plan on`): stashes the current everyday model and automatically switches to the configured `planModel` (a high-reasoning planning model);
- **Leaving Plan Mode** (`exit_plan_mode` approval / `/plan off`): automatically restores the pre-entry model (`autoRestorePlanModel`, on by default);
- A failed auto-switch only degrades to a warn and never interrupts the step.

## Safety guardrails

- **Provider whitelist**: when `allowedProviders` is non-empty, switching to providers outside the whitelist is rejected outright;
- **Context-window guard**: if the current session's token pressure exceeds the target model's context window, the switch is rejected with a prompt to compact context first (e.g. clear_mind):

  ```
  Current session token pressure (70000 tokens) exceeds target model context window (65536 tokens).
  Please compact context (e.g. clear_mind) before switching to this model.
  ```

- **Route validation**: the candidate combination is validated by the DSH core via `ctx.llm.resolveCallConfig` (provider adapter exists, model is valid, reasoningEffort is supported); invalid combinations return a clear error and write no session state;
- **Root agents only**: the tools are registered for root agents only (subagents get no self-switching tools); set `enableAgentTools: false` to disable them entirely.

## Configuration

Settings namespace `dsh-set-model` (configurable in the Web Settings UI; changes take effect at runtime):

```yaml
dsh-set-model:
  planModel:                    # optional: target model applied automatically on entering Plan Mode
    provider: deepseek
    model: deepseek-reasoner
    reasoningEffort: high
  autoRestorePlanModel: true    # restore the everyday model when leaving Plan Mode (default true)
  enableAgentTools: true        # whether to register the set_model / list_models tools (default true)
  allowedProviders: []          # optional: whitelist of switchable providers (empty = unrestricted)
```

## Install

```bash
dsh plugin --profile web add dsh-set-model
```

No manual configuration needed after install — the bundled `cordis.patch.yml` mounts automatically.

Install straight from GitHub (source install; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-set-model
# The first add is blocked by pnpm: add the package name pnpm prints to
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then re-run
```

## Permissions & compatibility

- **No direct side effects**: no external services, no network requests from the plugin itself (model routing and capability queries all go through the DSH core `llm` service), no direct filesystem writes; it only appends a `model/selection` event via the session event API (persisted by the DSH session system) and injects one Runtime Context line
- **Dependencies**: `@deepseek-ai/cordis` 4.0.2 / `@deepseek-ai/dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-tools` 0.1.2-rc.1 (aligned with dsh 0.1.2-rc.1 locked versions), `zod` ^3.24.2; Node ≥ 22.5
- **Failure degradation**: a failed Plan Mode auto-switch only warns and never breaks the step; tool validation failures return a clear error to the agent without polluting session state

## Local development

```bash
npm install
npm run build     # tsc → dist/src
npm test          # tsc(incl. test) + node --test dist/test/*.test.js
```

## License

MIT
