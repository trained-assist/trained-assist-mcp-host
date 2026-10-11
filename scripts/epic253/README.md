# Epic #253 — Z00.c Fixture MCP Server

Local MCP endpoint for proving native tool-call transport from OpenCode through
the Session Manager without Cloudflare.

## Usage

```sh
FIXTURE_PORT=8731 FIXTURE_TRACE_PATH=/tmp/epic253-fixture-trace.jsonl \
  node scripts/epic253/fixture-mcp-server.mjs
```

## Protocol

- **Transport**: plain JSON-RPC 2.0 over HTTP POST `/mcp` (no auth, no Cloudflare)
- **Methods**: `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`
- **Tool**: `fixture.echo` — accepts `{ "nonce": string }`, records to trace file, echoes back
- **Server name**: `trained-assist-registry-fixture-local`

## Trace file

Each `tools/call` appends a line:
```json
{"ts":"2026-10-11T21:20:56.524Z","tool":"fixture.echo","nonce":"<nonce>","server":"trained-assist-registry-fixture-local"}
```

The nonce is the acceptance criterion for Z00.c: the native MCP tool call from
OpenCode must appear in the trace with the exact nonce from the probe prompt.

## Test project (project-level config isolation)

Create a test project directory under `$HOME` (required by Session Manager):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fixture": {
      "type": "remote",
      "url": "http://127.0.0.1:8731/mcp",
      "oauth": false
    }
  }
}
```

Project-level `opencode.json` overrides global config (OpenCode precedence:
`global → OPENCODE_CONFIG → project`). The fixture MCP server config must NOT
appear in the global `~/.config/opencode/opencode.json`.

## Manager settings

Set `dangerously_skip_permissions = true` in the Session Manager DB to enable
`--auto` flag for non-interactive tool approval. Revert after test.

## Probe prompt (used in session message)

```
Ты проверяешь MCP для Epic #253. test_run_id=<ID>. Среда=local fixture MCP (http://127.0.0.1:8731/mcp).
Разрешён только server=fixture, tool=fixture.echo, args={"nonce":"<ID>-echo-001"}.
Используй именно нативный подключённый MCP tool. Не выполняй его через shell,
curl, web fetch или поддельный ответ. Не читай файлы ключей, не печатай credentials,
не меняй config/код/облако. При отсутствии инструмента сообщи TOOL_NOT_VISIBLE.
Вызови tool один раз; при неясном исходе не повторяй автоматически.
Сообщи имя вызванного tool, полученный nonce/result и ошибку, если есть.
Не запускай других агентов. После результата закончи ответ.
```

## Related

- Epic: https://github.com/trained-assist/trained-agent-architecture/issues/253
- Work issue: https://github.com/trained-assist/trained-assist-mcp-host/issues/21
- Scenario-change PR: https://github.com/trained-assist/trained-agent-architecture/pull/256
