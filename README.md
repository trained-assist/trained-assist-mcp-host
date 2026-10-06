# trained-assist-mcp-host

Standalone MCP host runtime for Trained Assist providers. It owns transport adapters, tool catalog composition, per-call authorization, binding resolution, and bounded dispatch. Domain handlers remain in their owning repositories and are injected as provider adapters.

This repository has no runtime dependency on `trained-assist-agent`, its runner, Telegram, prompt assembly, Task Store, scheduler, or profile storage. It has no production provider configured. The test Worker entrypoint below is a separate hard-scoped read-only fixture for the first CP→Runner integration slice.

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

### Isolated test Worker

For Registry fixture invocations the Worker requires `X-MCP-Operation: invocation` and
`X-MCP-Scope: registry:fixture-read`. Invocation claims bind the run/task/profile and
the pinned principal/server/binding/tool/policy/catalogue/digest; the Worker compares
those claims against actual run/task/profile/scope headers and trusted configuration.
The proof is required for both invocation `tools/list` and `tools/call`; listing exposes
only the authorized tool. Discovery remains a separate `tools/list` request without a
run ID or invocation scope. CP's random `catalogueId` is not a catalogue version.

`wrangler.jsonc` deploys only `trained-assist-mcp-host-test-160`, on its `workers.dev` URL and the test Custom Domain `registry-test.trainedassist.store` in the existing `trainedassist.store` zone. The custom-domain route is provisioned, but public DNS does not yet resolve it; authenticated requests to both test hostnames have also hit Cloudflare Error 1010 before Worker code. The zone owner must finish DNS provisioning and add a path-scoped rule to skip Browser Integrity Check for `POST /mcp` on this hostname. Do not disable Host authentication or the Runner proof check. No service binding or production provider is configured. The current test lease is provisioned; with all required config present, the Worker exposes exactly `registry.fixture_read` for the pinned profile/principal. Missing or invalid configuration returns `503`. CP catalogue discovery sends `X-MCP-Operation: discovery`, `X-MCP-User-Task-Id`, `X-MCP-Generation`, `X-MCP-Profile`, and `X-MCP-Principal-Id`; discovery has no `runId` and is restricted to `tools/list`. Runner invocation sends `X-MCP-Operation: invocation`, `X-MCP-Scope: registry:fixture-read`, `X-MCP-User-Task-Id`, `X-MCP-Profile`, canonical `X-MCP-Run-Id`, and `X-MCP-Run-Binding`. The latter is an EdDSA compact JWS signed by Runner and bound to that real run, task, profile, principal, server, binding, scope, tool allowlist, policy, pinned catalogue version and digest, and expiry. The Worker verifies it with `MCP_TEST_RUNNER_PUBLIC_JWK`; its expiry cannot outlive the Worker test lease. The shared test-only opaque Bearer is transport authentication only and cannot authorize invocation by itself. Put `MCP_TEST_AUTH_TOKEN` in the test Worker secret store and matching CP/Runner test binding through each owner's trusted config path; configure the Runner public JWK through the Worker variable path. Never put credentials or proofs in RunSpec, prompt text, issue comments, or manifests. No token mint endpoint is provided.

Pinned test contract: server `trained-assist-registry-test`, binding `registry-mcp-test-160-read`, profile `integration-telegram-ux-v1`, principal `integration-telegram-ux-v1`, tool `registry.fixture_read`, policy `registry-fixture-policy-v1`, catalogue version `registry-fixture-catalogue-v1`, audience `trained-assist:registry-mcp:test`, catalog digest `129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9`, marker `registry-fixture-marker-160-v1`. The principal and catalogue version are nonsecret Wrangler vars. Required secret/config values are `MCP_TEST_AUTH_TOKEN` (secret), `MCP_TEST_RUNNER_PUBLIC_JWK` (public JWK variable), `MCP_TEST_CATALOGUE_VERSION` (matching Wrangler var), and `MCP_TEST_EXPIRES_AT` (ISO 8601); `MCP_TEST_GENERATION` is optional and defaults to `1`. The marker is controlled fixture data, not production Registry data.

## Provider boundary

`resolveBindings({ context, providerId, required })` receives only the current run scope and the exact opaque binding refs declared by the provider. It returns values for the provider adapter; missing values fail closed. Values are not sent to the engine or returned in MCP results. The host must not receive the legacy service's full environment, read arbitrary profile files, or forward credentials through MCP arguments. Provider versions and manifests must be pinned by the deployment that composes the host. MCP stays unavailable unless an owning runner supplies an explicit scoped test or production binding configuration.

Read-only providers should be integrated first. A mutating call with an unknown outcome must be reconciled by its owner and must not be retried against a legacy fallback.

## Development

```bash
npm test
npm run check
```

Offline tests use only in-memory providers and local HTTP fixtures. They do not prove live credentials, remote provider availability, deployment, or consumer cutover.
