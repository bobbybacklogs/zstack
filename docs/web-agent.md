# Optional shared web research

zStack can call an authenticated shared web agent for web search and public page reading. This is a separate action from pinned-model chat and engineering runs. It does not expose local file or shell tools, change a chat's pinned model, or automatically retry/fall back to inference.

## Optional private client

Core zStack installs and runs without MH Kit. The shared backend integration uses an optional peer, `@cass/mh-kit` 0.2.x, loaded only when research is requested. Missing configuration/client returns an explicit unavailable error (HTTP 503 at the app boundary).

For a private deployment with access to MH Kit, obtain `cass-mh-kit-0.2.0.tgz` from the operator's private MH Kit distribution, put it in `vendor/`, and install it locally:

```sh
npm ci
npm install --save-prod --package-lock=false ./vendor/cass-mh-kit-0.2.0.tgz
```

This adds a deployment-local dependency. Keep that local manifest change and the archive out of public commits; `vendor/*.tgz` is ignored here. `--no-save` may omit an optional peer even when explicitly supplied. The private client archive/source is intentionally not distributed in this public repo. Installing the private client requires Node >=22.12; core commands keep their existing requirements.

Configure the server/main process privately:

```dotenv
MH_AGENT_API_KEY=
MH_AGENT_URL=https://mh.bycuvola.com/v1/agent/run
```

Use a dedicated key for this zStack installation, separate from inference, provider, and browser/operator credentials. The endpoint must be trusted server configuration. Never ship the outbound agent key to the browser. The backend controls its model/tools (`modelhitch/auto` in the tested deployment); request JSON cannot override them.

## Use

- In a chat, select **Web research** next to Send. Submit a question in the separate dialog. Closing cancels the request. Research does not alter or save messages into the pinned chat transcript; copy an answer if you want to retain it.
- SDK: `await zstack.research({prompt, signal})`; readiness: `await zstack.researchHealth({signal})`.
- CLI: `zstack research "Find the official Python docs, read them and summarize with sources" --json`. Supply the private agent environment in the invoking process.
- HTTP: authenticated GET `/api/research` checks readiness, and POST `/api/research` accepts only JSON `{prompt}`. The existing server credential/origin checks apply. Browser/API users present their zStack operator key; only the server holds the outbound agent key.

Answers include the backend request ID, configured model ID, answer text and actual tool-call outcomes. Model output is rendered as text. Inputs are limited to the shared backend's 12,000 prompt characters / 16KiB JSON. Cancellation and safe error/status handling propagate through MH Kit. The backend separately enforces per-app quotas, a request deadline and bounded tool turns. A returned answer alone does not prove a successful search: check `toolCalls`.

## Verify

```sh
npm ci
node --test tests/web-agent.test.mjs tests/chat.test.mjs tests/chats.test.mjs tests/api.test.mjs tests/cli-json.test.mjs
```

The 82-test group passes without the private client, checking core operation, route authorization/validation, and explicit unavailability. After installing the private archive, rerun it to exercise the synthetic backend through the research API, SDK and CLI. The same 82 tests also pass with the client installed. Missing-client handling is separately exercised with an isolated standalone module.

A fresh checkout of this PR ran its real authenticated API against the shared HTTPS backend using a privately supplied zStack app key. Both web search and page reading completed and the answer cited the official source. The deployed UI was separately exercised in Chromium through the Web research button, its app API and the shared backend; it displayed a cited answer without page script errors, and temporary test chats were deleted. Existing plain inference also passed. See `verification/web-agent.json` for a summary.

No real keys, private MH Kit package/source, runtime data, systemd settings, host-specific patches, or VM swap configuration are included in this public change.
