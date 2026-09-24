---
name: setup-zstack
description: Configure role-to-model choices for zstack using OpenCode Zen and OpenCode Go models via ModelHitch (127.0.0.1:3939).
---

# Setup zstack

Configure the model assigned to each engineering role in `zstack`.

`zstack` decouples the agent role from the model. By default, it routes to high-performance OpenCode Zen and OpenCode Go models through your local ModelHitch bridge at `http://127.0.0.1:3939/v1`.

## Role Mapping Architecture

```
Role                     Default OpenCode Model    Service / Wire
-------------------------------------------------------------------------------------
feature, refactoring     deepseek-v4-pro           OpenCode Go (chat/completions)
fast exploration         deepseek-v4-flash         OpenCode Zen (chat/completions)
bug-fix, perf-issue      deepseek-v4-pro           OpenCode Go (chat/completions)
judgment and prose       claude-sonnet-4-6         OpenCode Zen (messages)
deep reasoning           gpt-5.5                   OpenCode Zen (responses)
how explorer             deepseek-v4-pro           OpenCode Go (chat/completions)
how explainer            claude-sonnet-4-6         OpenCode Zen (messages)
how critics              claude-sonnet-4-6, gpt-5.5, deepseek-v4-pro
why investigators        deepseek-v4-pro           OpenCode Go (chat/completions)
why synthesizer          claude-sonnet-4-6         OpenCode Zen (messages)
reflect tooling          deepseek-v4-pro           OpenCode Go (chat/completions)
reflect synthesizer      claude-sonnet-4-6         OpenCode Zen (messages)
arena runners            claude-sonnet-4-6, gpt-5.5, deepseek-v4-pro, qwen3.7-max
architect runners        claude-sonnet-4-6, gpt-5.5, deepseek-v4-pro
interrogate reviewers    claude-sonnet-4-6, gpt-5.5, deepseek-v4-pro, qwen3.7-max
```

## Setup Instructions

### 1. Verify ModelHitch Status
Check that ModelHitch is running locally on port 3939:
```bash
curl http://127.0.0.1:3939/v1/models
```
Confirm the OpenCode Zen and OpenCode Go upstream routes are hitched in your `~/.modelhitch/config.json`.

### 2. Configure Editor Model Rule
When using Cursor, generate `~/.cursor/rules/zstack-models.mdc`:

```markdown
---
description: zstack per-role model choices routed via ModelHitch (127.0.0.1:3939)
alwaysApply: true
---
# zstack model configuration. One line per role.
feature, refactoring: opencode/deepseek-v4-pro
bug-fix, perf-issue: opencode/deepseek-v4-pro
fast exploration: opencode/deepseek-v4-flash
judgment and prose: opencode/claude-sonnet-4-6
deep reasoning: opencode/gpt-5.5
how explorer: opencode/deepseek-v4-pro
how explainer: opencode/claude-sonnet-4-6
how critics: opencode/claude-sonnet-4-6, opencode/gpt-5.5, opencode/deepseek-v4-pro
why investigators: opencode/deepseek-v4-pro
why synthesizer: opencode/claude-sonnet-4-6
reflect tooling: opencode/deepseek-v4-pro
reflect synthesizer: opencode/claude-sonnet-4-6
arena runners: opencode/claude-sonnet-4-6, opencode/gpt-5.5, opencode/deepseek-v4-pro, opencode/qwen3.7-max
architect runners: opencode/claude-sonnet-4-6, opencode/gpt-5.5, opencode/deepseek-v4-pro
interrogate reviewers: opencode/claude-sonnet-4-6, opencode/gpt-5.5, opencode/deepseek-v4-pro, opencode/qwen3.7-max
```

### 3. Verification
Verify that a test chat request reaches the model via ModelHitch:
```bash
modelhitch chat --model opencode/deepseek-v4-pro --prompt "ping"
```
Or send an HTTP request:
```bash
curl -X POST http://127.0.0.1:3939/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "opencode/deepseek-v4-pro", "messages": [{"role": "user", "content": "ping"}]}'
```
