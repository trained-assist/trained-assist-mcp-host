# trained-assist-mcp-host

Standalone MCP host runtime for Trained Assist providers. It owns transport, run-token verification, tool catalog composition, per-call authorization, and bounded dispatch. Domain handlers remain in their owning repositories and are injected as provider adapters.

This repository has no runtime dependency on `trained-assist-agent`, its runner, Telegram, prompt assembly, Task Store, scheduler, or profile storage. It has no production provider configured yet. The first PR establishes the executable host contract; provider adapters and consumer migrations are separate follow-up PRs pinned to released versions.

## Runtime

Node.js 22 or newer; no third-party runtime dependencies.

```js
const { createHost } = require('trained-assist-mcp-host');

const host = createHost({
  providers: [{
    id: 'example-domain',
    tools: [{
      name: 'example_read',
      description: 'Read a domain resource.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args, run) => domainAdapter.read(args, {
        profileId: run.username,
        taskId: run.taskId,
      }),
    }],
  }],
});
```

`createHost()` returns a shared MCP protocol dispatcher and the HTTP and stdio adapters. A provider declares stable MCP names, schemas, and handlers. The host rejects duplicate names rather than silently choosing an owner. `authorize({ context, tool })` runs on every call. The immutable context includes only `username`, `taskId`, token timestamps, provider ID, request ID, and an `AbortSignal`; it does not contain credentials. Providers should observe the signal to stop work after cancellation or timeout.

### HTTP

Mount `host.httpHandler` on a Node HTTP server. `POST /mcp/token` accepts a configured `MCP_HOST_TOKEN` and `{ "taskId": "...", "username": "..." }`; it returns a short lived `rt_…` bearer token. `POST /mcp` accepts one JSON-RPC request per request and supports `initialize`, `ping`, `tools/list`, and `tools/call`. Notifications return HTTP 202 with an empty body. Tokens are held in memory and become invalid on expiry or process restart.

Set `MCP_HOST_TOKEN` to one or more comma-separated `mcp_` credentials, each at least 32 characters after its prefix. Never pass this minting credential to an agent or provider. Deploy behind TLS and a request-size/rate limit at the trusted ingress.

### stdio

`host.attachStdio({ authorization })` uses the same dispatcher and protocol. The embedding launcher must provide a run-scoped bearer token through a trusted channel. The host writes protocol responses to stdout; provider logs belong on stderr.

## Provider boundary

Providers receive JSON arguments and the host-created run context. They are responsible for resolving their own profile-scoped bindings through explicit adapters. The host must not receive the legacy service's full environment, read arbitrary profile files, or forward credentials through MCP arguments. Provider versions and manifests must be pinned by the deployment that composes the host.

Read-only providers should be integrated first. A mutating call with an unknown outcome must be reconciled by its owner and must not be retried against a legacy fallback.

## Development

```bash
npm test
npm run check
```

Offline tests use only in-memory providers and local HTTP fixtures. They do not prove live credentials, remote provider availability, deployment, or consumer cutover.
