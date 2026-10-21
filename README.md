# trained-assist-mcp-host

Standalone MCP host runtime for Trained Assist providers. It owns transport adapters, tool catalog composition, per-call authorization, binding resolution, and bounded dispatch. Domain handlers remain in their owning repositories and are injected as provider adapters.

This repository has no runtime dependency on `trained-assist-agent`, its runner, Telegram, prompt assembly, Task Store, scheduler, or profile storage. It has no production provider configured. The test Worker entrypoint below is a separate hard-scoped read-only fixture for the first CP→Runner integration slice.

The current personal-key connection plan and first-user setup are documented in [AUTH-ARCHITECTURE.md](AUTH-ARCHITECTURE.md) and [USER-AUTH-MVP.md](USER-AUTH-MVP.md). The user sandbox Worker is separate from the machine test Worker. Its product catalog contains `identity.whoami`, `google_docs.connect`, and `google_docs.get_document`; machine/recruiter fixture tools are confined to the separate test Worker. The human gateway includes an optional Google Docs read-only provider; live OAuth requires deployment secrets and an exact registered callback URL.

### ZeroCreds wallet tools

The human Worker composes ZeroCreds provider version `1.0.0` from the immutable Git commit in `package.json`. The complete human catalog digest is `483e6d2f949b32c05a70186f4e25aba291b1483eeb0bdc9a7a3bca4b9b7cdf11`; update any Runner catalog pin when rolling out this provider. It registers `zerocreds_wallet_form_create`, `zerocreds_wallet_form_status`, `zerocreds_wallet_connection_status`, and `zerocreds_wallet_connection_revoke`. The host does not copy wallet handlers or accept owner, profile, destination, or credential values as tool arguments.

The wallet tools are hidden unless all of these sandbox bindings are configured: `ZEROCREDS_WALLET_API_URL` (HTTPS ZeroCreds Node API endpoint), `ZEROCREDS_WALLET_ISSUER`, `ZEROCREDS_WALLET_KEY_ID`, `ZEROCREDS_WALLET_SIGNING_KEY` (secret Ed25519 private JWK), and KV namespace `ZEROCREDS_WALLET_PROFILES`. KV values are operator-authorized JSON records keyed by the verified MCP user ID, for example `{"owner_id":"owner_123","profile_id":"profile_default"}`. Map only users who have explicitly authorized the ZeroCreds profile. ZeroCreds must trust the matching `(issuer, key ID, profile ID)` and map that profile to its named destination. The Node API and its assertion issuer configuration must be deployed in the same sandbox before listing tools.

For each invocation the host signs an operation-specific human assertion with a unique `jti` and a five-minute maximum lifetime. The provider sends it only to the configured ZeroCreds API. ZeroCreds validates the signature and scope, resolves its configured destination, and claims the `jti` digest in its wallet Worker. The host never receives the Worker service token or OpenBao credentials. Roll back by removing the provider's profile KV mapping or any required issuer/API setting; the four names disappear from the next tools/list response. Production must remain disabled until ZeroCreds production release, identity/profile authorization, destination mapping, legacy-client migration, and an end-to-end agent run are completed.

## Runtime

Node.js 22 or newer; the deployed human Worker additionally bundles the pinned ZeroCreds provider package.

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

`wrangler.jsonc` deploys only `trained-assist-mcp-host-test-160` on its `workers.dev` URL. It has no custom route, service binding, or production provider. Until the test secret, public verification key, and expiry are configured it returns `503`; when configured it exposes exactly `registry.fixture_read` for the pinned profile/principal. CP catalogue discovery sends `X-MCP-Operation: discovery`, `X-MCP-User-Task-Id`, `X-MCP-Generation`, `X-MCP-Profile`, and `X-MCP-Principal-Id`; discovery has no `runId` and is restricted to `tools/list`. Runner invocation sends `X-MCP-Operation: invocation`, `X-MCP-Scope: registry:fixture-read`, `X-MCP-User-Task-Id`, `X-MCP-Profile`, canonical `X-MCP-Run-Id`, and `X-MCP-Run-Binding`. The latter is an EdDSA compact JWS signed by Runner and bound to that real run, task, profile, principal, server, binding, scope, tool allowlist, policy, pinned catalogue version and digest, and expiry. The Worker verifies it with `MCP_TEST_RUNNER_PUBLIC_JWK`; its expiry cannot outlive the Worker test lease. Only when `MCP_TEST_E2E_ENABLED=true`, the test Worker also accepts its separate `MCP_TEST_E2E_PUBLIC_JWK` for the read-only synthetic fixture probe. This key is never accepted when that explicit test flag is off. The shared test-only opaque Bearer is transport authentication only and cannot authorize invocation by itself. Put `MCP_TEST_AUTH_TOKEN` in the test Worker secret store and matching CP/Runner test binding through each owner's trusted config path; configure the Runner public JWK through the Worker variable path. Never put credentials or proofs in RunSpec, prompt text, issue comments, or manifests. No token mint endpoint is provided.

Pinned test contract: server `trained-assist-registry-test`, binding `registry-mcp-test-160-read`, profile `integration-telegram-ux-v1`, principal `integration-telegram-ux-v1`, tool `registry.fixture_read`, policy `registry-fixture-policy-v1`, catalogue version `registry-fixture-catalogue-v1`, audience `trained-assist:registry-mcp:test`, catalog digest `fcfc1bda07f5ba348a97002489fbb621c495394ca84b3d2aeb0a1ec71cb55c7b`, marker `registry-fixture-marker-160-v1`. The principal and catalogue version are nonsecret Wrangler vars. Required secret/config values are `MCP_TEST_AUTH_TOKEN` (secret), `MCP_TEST_RUNNER_PUBLIC_JWK` (public JWK variable), `MCP_TEST_CATALOGUE_VERSION` (matching Wrangler var), and `MCP_TEST_EXPIRES_AT` (ISO 8601); `MCP_TEST_GENERATION` is optional and defaults to `1`. The marker is controlled fixture data, not production Registry data.

The manual GitHub Action **Remote test Worker E2E** calls only the fixed `workers.dev` test endpoint. It verifies CP-style authenticated `tools/list`, a synthetic EdDSA-bound read-only fixture invocation, and rejection of an expired proof using `MCP_TEST_AUTH_TOKEN` and `MCP_TEST_E2E_PRIVATE_JWK` Actions secrets. The fixture has no mutable external state. This component probe does not claim that a real CP task or installed Runner completed. Deployment, required test bindings, external DNS/security setup, verification limits, and rollback are recorded in the [MCP Host Environment Contract](docs/ENVIRONMENT-CONTRACT.md).

The manual **Deploy Registry MCP test Worker** action deploys only this test Worker from `main`. Configure the `sandbox` GitHub environment with `CF_API_TOKEN`, `MCP_TEST_AUTH_TOKEN`, and the Runner's public Ed25519 JWK in `MCP_TEST_RUNNER_PUBLIC_JWK`. Each deployment renews the lease through the end of the UTC day 30 days ahead; deploy the paired Runner Worker on the same UTC date with the matching private JWK and bearer before running an agent scenario.

## Provider boundary

`resolveBindings({ context, providerId, required })` receives only the current run scope and the exact opaque binding refs declared by the provider. It returns values for the provider adapter; missing values fail closed. Values are not sent to the engine or returned in MCP results. The host must not receive the legacy service's full environment, read arbitrary profile files, or forward credentials through MCP arguments. Provider versions and manifests must be pinned by the deployment that composes the host. MCP stays unavailable unless an owning runner supplies an explicit scoped test or production binding configuration.

Read-only providers should be integrated first. A mutating call with an unknown outcome must be reconciled by its owner and must not be retried against a legacy fallback.

## Development

```bash
npm test
npm run check
```

Offline tests use only in-memory providers and local HTTP fixtures. They do not prove live credentials, remote provider availability, deployment, or consumer cutover.

## Runner delegated access to the user catalog

The user Worker can accept an optional Runner invocation in addition to personal API keys. This path is intended for an explicitly configured sandbox run and does not expose a user's long-lived personal key to Runner or OpenCode. Runner authenticates with the secret `MCP_RUNNER_AUTH_TOKEN` and presents an Ed25519 JWS in `X-MCP-Run-Binding`; the Worker verifies it against the public-only `MCP_RUNNER_PUBLIC_JWK`. The proof is bound to one run, task, profile, active user, exact server/binding/scope/policy, catalogue digest/version, tool allowlist, owner generation, and a maximum two-hour lifetime. The host re-checks that the mapped user remains active on each MCP request. Missing or mismatched claims fail closed.

Sandbox configuration names are `MCP_RUNNER_AUTH_TOKEN` (Worker secret), `MCP_RUNNER_PUBLIC_JWK` (Worker variable), and optional `MCP_USER_CATALOGUE_VERSION` (Worker variable, default `mem-gpt-user-catalogue-v2`). The separate sandbox provisioning API uses `MCP_SANDBOX_PROVISION_TOKEN`, `MCP_SANDBOX_PROVISIONING_ENABLED`, and `MCP_SANDBOX_WALLET_OWNER_ID`; it accepts a canonical Runner run ID or UUID and an expiry within six hours, creates a unique MCP identity/profile, stores only an expiring wallet profile mapping, and never returns a personal API key. The endpoint is disabled unless the sandbox-only flag and dedicated token are configured. Runner must keep the matching signing private key and transport/provisioning tokens in its own sandbox secret store. Never pass the personal user API key to Runner, OpenCode, or RunSpec. Do not enable this path in production.

## Search domain provider (trained-assist-search-skill)

The host can mount `trained-assist-search-skill` as a read-only provider via
`createSearchProvider` (or the aliases in `src/search.js`). Pinned source commit:
`069ba8b2e6f8b02c4e9241fcb1514d3114a68466` (vendored under `vendor/trained-assist-search-skill/`).

```js
const { createHost } = require('trained-assist-mcp-host');
const { createSearchProvider } = require('trained-assist-mcp-host/search');

const host = createHost({
  providers: [
    createSearchProvider({
      searchOrigin: process.env.MCP_SEARCH_ORIGIN, // HTTPS SearXNG origin
      serperApiKey: process.env.SERPER_API_KEY,   // trusted; never via MCP args
      fetchImpl: globalThis.fetch,
    }),
  ],
  // authenticate / authorize / resolveBindings supplied by the owning runner
});
```

Trusted environment/configuration:
- `MCP_SEARCH_ORIGIN` (optional, HTTPS origin only; defaults to `https://search.test.invalid`)
- `SERPER_API_KEY` (optional, Serper key for `search_serper`; absence is a readable tool error)
- `SERPER_API_KEY`/backend origin must be supplied by the host/deployment, never by MCP arguments, prompts, or manifests.

Exposed tools: `search_serp_free` and `search_serper`. They are read-only; their outbound origin, redirect handling, request budget and response size are bounded by the pinned adapter.

## JS/TS code provider (local stdio and Worker)

`src/js-ts-code.js` exposes one MCP tool, `write`, that turns a natural-language task into JavaScript or TypeScript source with the Ladder service, validates the syntax, and can write the result to a file. It is mounted locally through `scripts/js-ts-code-stdio.js`:

```json
"js-ts-code": {
  "type": "local",
  "command": ["node", "/path/to/trained-assist-mcp-host/scripts/js-ts-code-stdio.js"],
  "environment": { "LADDER_API_KEY": "{file:/Users/vova/.config/opencode/secrets/ladder-api-key}" },
  "timeout": { "catalog": 180000, "execution": 180000 }
}
```

Trusted configuration (never passed through MCP arguments):
- `LADDER_API_KEY`, or `LADDER_API_KEY_FILE` (default `~/.config/opencode/secrets/ladder-api-key`) - Ladder service key. The provider fails with an explicit message when it is missing; no key is stored in this repository.
- `LADDER_BASE_URL` (default `https://llm-ladder.trainedassist.store/v1`), `LADDER_MODEL` (default `service`).
- `JS_TS_CODE_WRITE_ROOT` (default: the server's working directory) - the only tree `writePath` may write into; a path outside it is refused.

Tool inputs: `task`, `code`, `existingCode`, `existingPath`, `iterations`, `language` (`javascript`|`typescript`), `module` (`cjs`|`esm`|`auto`), `typeCheck`, `maxTokens`, `model`, `autoChunk`, `noComments`, `writePath`, `context`. `module` pins the module format of the generated code; when the model returns the other format the provider converts it once and reports the outcome in `moduleFormat`. The result is `{ code, language, moduleFormat, valid, error, note, iterations, warnings, writtenTo?, usage }`.

`valid` is `null` when the runtime cannot verify the syntax (the Worker forbids dynamic code evaluation and has no filesystem); that is not a failure of the generated code. Runtime differences are explicit rather than silent: the Node stdio server validates script and module syntax, validates TypeScript when the optional `typescript` devDependency is installed, and can write files; the Worker validates nothing, writes nothing, and says so in `note` and `warnings`.

The OpenCode Code Mode sandbox is an orchestration language: it cannot `require()` modules, cannot `import()`, and cannot touch the filesystem. Generated code therefore has to land with `writePath` (or the agent's file-write tool) and be run with the shell tool. Running it inside `execute` fails with `Unknown identifier 'require'` or `Syntax 'ImportExpression' is not supported`.

The Worker route `/js-ts-code` in `src/worker-unified.mjs` is a billable LLM endpoint, so it is unavailable by default. It needs `MCP_JS_TS_CODE_ENABLED=true`, a dedicated `MCP_JS_TS_CODE_TOKEN` secret presented as `Authorization: Bearer <token>`, and a `LADDER_API_KEY` secret for the Ladder service. Without the flag and the token the route answers `404`, and a missing or wrong token answers `401`. It never becomes an open proxy to the Ladder key.

## CI / provisioning

- `CI` runs on every pull request: `npm run check`, `npm test`, dependency-boundary check and package dry run.
- The Workers stay manual: trigger `Deploy Registry MCP test Worker` or `Remote test Worker E2E` in GitHub Actions (or via `gh workflow run`). No agent-runner credential provisioning happens automatically.
