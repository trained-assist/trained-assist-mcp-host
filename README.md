# trained-assist-mcp-host

Standalone MCP host runtime for Trained Assist providers. It owns transport adapters, tool catalog composition, per-call authorization, binding resolution, and bounded dispatch. Domain handlers remain in their owning repositories and are injected as provider adapters.

This repository has no runtime dependency on `trained-assist-agent`, its runner, Telegram, prompt assembly, Task Store, scheduler, or profile storage. It has no production provider configured yet. The first PR establishes the executable host contract; provider adapters and consumer migrations are separate follow-up PRs pinned to released versions.

## Runtime

Node.js 22 or newer; no third-party runtime dependencies.

```js
const { createHost } = require('trained-assist-mcp-host');

const host = createHost({
  providers: [{
    id: 'example-domain',
    version: '1.2.3',
    tools: [{
      name: 'example_read',
      description: 'Read a domain resource.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args, run) => domainAdapter.read(args, {
        profileId: run.profileId,
        taskId: run.taskId,
      }),
    }],
  }],
});
```

`createHost()` returns a shared MCP protocol dispatcher and HTTP and stdio adapters. The embedding runner supplies `authenticate({ authorization })` through its trusted per-run credential path. It must return `{ taskId, generation, profileId, principalId, runId, bindingRef, allowedTools, policyVersion, registryDigest, expiresAt, audience }`. The digest must match the host's pinned provider catalog; expiry and audience are checked on every operation. There is no token mint endpoint and no service-wide credential. Each provider needs a pinned `version` and declares stable MCP names, schemas, handlers, and optional `requiredBindings`. The host rejects duplicate names, filters `tools/list`, checks `allowedTools` again on each call, and runs `authorize({ context, tool })` for each call. Providers should observe the `AbortSignal` in context to stop work after cancellation or timeout.

### HTTP

Mount `host.httpHandler` on a Node HTTP server only when an owning runner provides the per-run authentication adapter and an explicitly scoped endpoint configuration. `POST /mcp` accepts one JSON-RPC request per request and supports `initialize`, `ping`, `tools/list`, `tools/call`, and cancellation notifications. There is no `/mcp/token` route. Notifications return HTTP 202 with an empty body. This library does not enable or deploy an endpoint on its own.

### stdio

`host.attachStdio({ authorization })` uses the same dispatcher and protocol. The embedding launcher provides its per-run credential through a trusted channel. The host writes protocol responses to stdout; provider logs belong on stderr.

## Provider boundary

`resolveBindings({ context, providerId, required })` receives only the current run scope and the exact opaque binding refs declared by the provider. It returns values for the provider adapter; missing values fail closed. Values are not sent to the engine or returned in MCP results. The host must not receive the legacy service's full environment, read arbitrary profile files, or forward credentials through MCP arguments. Provider versions and manifests must be pinned by the deployment that composes the host. MCP stays unavailable unless an owning runner supplies an explicit scoped test or production binding configuration.

Read-only providers should be integrated first. A mutating call with an unknown outcome must be reconciled by its owner and must not be retried against a legacy fallback.

## Development

```bash
npm test
npm run check
```

Offline tests use only in-memory providers and local HTTP fixtures. They do not prove live credentials, remote provider availability, deployment, or consumer cutover.
