# OpenCode Zen — Dev Reference

Compiled Sept 24, 2026 from the [official Zen docs](https://opencode.ai/docs/zen/) and community-verified integrations. The model catalog churns (limited-time models get delisted), so treat this as a snapshot and re-check `GET /v1/models` before hardcoding anything.

## Bases & auth

| Service | Base URL |
|---|---|
| Zen (pay-per-use) | `https://opencode.ai/zen/v1` |
| Go (flat-rate subscription) | `https://opencode.ai/zen/go/v1` |

- Auth: `Authorization: Bearer $OPENCODE_API_KEY` on everything.
- Get a key: sign in at opencode.ai/zen, add billing (min **$20 top-up** to issue a key — "free" models are $0/token, not $0 signup), copy the key.
- Auto-reload: $20 top-up when balance drops below $5. Configurable, can be disabled. Monthly workspace/member spend limits available.
- List models live: `GET /v1/models` — returns `{id, object, created, owned_by}` only, no context windows or pricing. Context windows live in [models.dev/api.json](https://models.dev/api.json) under the `opencode` provider.
- BYOK: you can plug your own OpenAI/Anthropic keys into Zen; those tokens bill to the provider, not Zen.

## Endpoint routing (the gotcha)

Zen is **not** one OpenAI-compatible endpoint. Wrong family → wrong endpoint = 404 or `{"error":{"message":"No provider available"}}`. Route by model family:

| Family | Example IDs | Endpoint | Wire format |
|---|---|---|---|
| GPT (incl. Grok, Muse Spark) | `gpt-5.5`, `gpt-5.3-codex`, `grok-4.7`, `muse-spark-1.3` | `POST /v1/responses` | OpenAI Responses API |
| Claude, Qwen | `claude-sonnet-4-6`, `qwen3.7-max` | `POST /v1/messages` | Anthropic Messages API |
| DeepSeek, MiniMax, GLM, Kimi, freebies | `deepseek-v4-pro`, `glm-5.1`, `kimi-k2.6`, `big-pickle` | `POST /v1/chat/completions` | OpenAI Chat Completions |
| Gemini | `gemini-3-flash` | `POST /v1/models/<id>:generateContent` (or `:streamGenerateContent?alt=sse`) | Google AI; header is `x-goog-api-key: $OPENCODE_API_KEY` |
| Jev (TypeSafe decision models) | `jev-1.13` | `POST /v1/systemone` | state + typed questions, returns values/probabilities |
| Embeddings | — | `POST /v1/embeddings` | OpenAI |

In OpenCode config, model IDs take the `opencode/<id>` form, e.g. `opencode/gpt-5.5`.

## Model IDs (current snapshot)

**GPT** (`/v1/responses`): `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5`, `gpt-5-codex`, `gpt-5-nano`

**Claude** (`/v1/messages`): `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`

**Gemini** (`/v1/models/<id>`): `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-3-flash`

**Grok** (`/v1/responses`): `grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-build-0.1`

**Muse** (`/v1/responses`): `muse-spark-1.3`, `muse-spark-1.2`

**Qwen** (`/v1/messages`): `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus`

**DeepSeek** (`/v1/chat/completions`): `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-v4-flash-vision-exp`

**MiniMax** (`/v1/chat/completions`): `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`

**GLM** (`/v1/chat/completions`): `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `glm-5.1`, `glm-5`

**Kimi** (`/v1/chat/completions`): `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`

**Jev** (`/v1/systemone`): `jev-1.13`, `jev-1.13-free`

**Free tier** (`/v1/chat/completions` unless noted): `big-pickle`, `space-bunny-free`, `mimo-v2.6-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `muse-spark-1.3-contributor-free` (`/v1/responses`), `jev-1.13-free` (`/v1/systemone`). Limited-time; several may train on your data during the free period (see docs).

## Pricing (per 1M tokens, pay-per-use — selection)

| Model | Input | Output |
|---|---|---|
| `claude-opus-4-6` | $5.00 | $25.00 |
| `claude-sonnet-4-6` | $3.00 | $15.00 |
| `claude-haiku-4-5` | $1.00 | $5.00 |
| `gpt-5.5` | $5.00 | $30.00 |
| `gpt-5.4-mini` | $0.75 | $4.50 |
| `gpt-5-nano` | $0.05 | $0.40 |
| `gpt-5.3-codex` | $1.75 | $14.00 |
| `gemini-3-flash` | $0.50 | $3.00 |
| `grok-4.7` | $2.00 | $6.00 |
| `muse-spark-1.3` | $1.25 | $4.25 |
| `kimi-k2.6` | $0.95 | $4.00 |
| `kimi-k2.5` | $0.60 | $3.00 |
| `glm-5.1` | $1.40 | $4.40 |
| `glm-5` | $1.00 | $3.20 |
| `deepseek-v4-pro` | $1.74 | $3.48 |
| `deepseek-v4-flash` | $0.14 | $0.28 |
| `qwen3.7-max` | $2.50 | $7.50 |
| `minimax-m2.7` | $0.30 | $1.20 |

Zen sells at cost plus processing fees. Full table (incl. cache pricing and deprecation dates) is on the docs page.

## Go subscription (flat-rate)

Same key, different base: `https://opencode.ai/zen/go/v1`. Smaller curated catalog, unsuffixed IDs — recently seen: `glm-5.1`, `kimi-k2.7-code`, `deepseek-v4-pro`, `mimo-v2.5-pro`. If your usage is steady, this is the one to price against pstack.

## Minimal Go example

```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

func zenChat(model, prompt string) {
	payload, _ := json.Marshal(map[string]any{
		"model":    model,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	})
	// Swap path per family: /v1/chat/completions, /v1/responses, /v1/messages
	req, _ := http.NewRequest("POST",
		"https://opencode.ai/zen/v1/chat/completions", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENCODE_API_KEY"))
	req.Header.Set("Content-Type", "application/json")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Printf("status=%d\n%s\n", res.StatusCode, out)
}

func main() { zenChat("kimi-k2.6", "ping") }
```

Notes:
- `/v1/responses` and `/v1/messages` take their native request shapes (Responses API / Anthropic Messages), not the chat-completions shape above.
- Gemini needs `x-goog-api-key` instead of the Bearer header on the `:generateContent` path.
- `stream: true` gives SSE on the chat/responses endpoints.
- All models hosted in the US; zero-retention except the listed free-tier exceptions.
