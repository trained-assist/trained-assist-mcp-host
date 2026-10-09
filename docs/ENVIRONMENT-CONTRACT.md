# Environment Contract — MCP Host test Worker

Status: source reviewed on 2026-10-08 at `7a6bb3f`; live Cloudflare resources are not verified by this document.

This contract covers the fixed test Worker only. The npm package release and the
Cloudflare test deployment are separate operations. There is no production Worker
or production provider configured in this repository.

## Targets and commands

| Target | Entrypoint | Effect |
|---|---|---|
| Local | `npm ci && npm run check && npm test` | Static checks and local fixtures only. No Cloudflare mutation. |
| Test Worker | From the repository root: `npx wrangler deploy --config wrangler.jsonc` | Deploys `trained-assist-mcp-host-test-160` to its configured `workers.dev` endpoint. It does not deploy a production Worker or publish the npm package. |
| Remote test probe | GitHub Actions → **Remote test Worker E2E**, or `MCP_TEST_AUTH_TOKEN=… MCP_TEST_E2E_PRIVATE_JWK=… node scripts/remote-e2e.mjs` | Sends authenticated discovery, a synthetic read-only signed fixture invocation, and an expired-proof rejection to the fixed test endpoint. It does not exercise a real CP task or Runner. |
| Package release | Push a `v*` tag | CI checks/tests, packs the npm module, and creates a GitHub release. It does not deploy the Worker or enable a provider. |

Only run Wrangler commands after `wrangler whoami` confirms the expected trained-assist
test account (`typeformowner@gmail.com`, account ID
`d740a05e9442c1d0feacae2dfc673e93`). If the identity differs, stop before inspecting
or changing Worker resources.

## Test bindings and out-of-band state

`wrangler.jsonc` declares the Worker name, `workers.dev`, observability, and the
nonsecret principal/catalogue variables. The following values are not provisioned
by that config and must be present through trusted Cloudflare/Actions/consumer config
paths before the probe can pass:

| Binding/config | Owner and location | Verification |
|---|---|---|
| `MCP_TEST_AUTH_TOKEN` | Cloudflare Worker secret; matching test value in CP/Runner trusted test config; Actions secret for remote E2E | Check names/presence without displaying values; remote probe must authenticate. |
| `MCP_TEST_RUNNER_PUBLIC_JWK` | Cloudflare Worker variable | Remote signed fixture probe verifies the signature; do not substitute the private signing key. |
| `MCP_TEST_E2E_PUBLIC_JWK` | Cloudflare Worker variable, enabled only with `MCP_TEST_E2E_ENABLED=true` | Remote E2E invocation succeeds only while the explicit test gate is on; normal Runner proof still remains required. |
| `MCP_TEST_E2E_PRIVATE_JWK` | GitHub Actions secret or trusted operator secret store | Used by the probe client only; never a Worker variable or repository file. |
| `MCP_TEST_EXPIRES_AT` | Cloudflare Worker variable / test lease owner | Confirm lease is current and no longer than the approved test window. |
| Test custom domain | Cloudflare DNS and zone security policy, if used | DNS record and path-scoped Browser Integrity Check exception for `POST /mcp` require zone-owner action. This is not part of `wrangler deploy`. The workers.dev probe avoids depending on this domain. |

The Worker is stateless and exposes a fixed read-only fixture. There are no D1, KV,
R2, Durable Object, Workflow, or other application data migrations in this target.
The shared test Worker is a mutable integration resource: coordinate deployment and
use only the fixed synthetic profile, principal, tool, and marker documented in the
README. Never send production credentials or user payloads.

## Deploy and acceptance procedure

1. Pin the source commit and inspect the pending diff; run `npm ci`, `npm run check`,
   and `npm test`.
2. Verify the Cloudflare account identity above. Verify required binding names and
   lease/config presence without reading secret values.
3. Deploy with `npx wrangler deploy --config wrangler.jsonc`; inspect Wrangler output
   for the exact Worker name and endpoint.
4. Run the remote test E2E against the fixed endpoint. Record source commit, deployed
   Cloudflare version, E2E run, and binding-presence/lease status in the owning issue.
5. If using the test custom domain, separately verify DNS resolution and the scoped
   Cloudflare security rule, then probe that hostname. A workers.dev pass does not
   prove custom-domain reachability.

The repository currently has no deployment workflow for the test Worker and no
post-deploy check that compares the served build revision with the requested source
commit. A successful manual Action therefore verifies behavior of the currently
deployed Worker, not that a particular commit was just deployed. This is a tracked
deployment-coverage gap for architecture issue
[#220](https://github.com/trained-assist/trained-agent-architecture/issues/220).

## Failure, recovery, and promotion

- Missing/invalid test config should fail closed (`503`/authorization failure); fix
  the trusted test binding and rerun the same synthetic probe.
- The currently supported rollback is a Wrangler rollback or redeploy of a previously
  reviewed source revision. Record the resulting version and rerun the remote probe.
- No D1/schema/data rollback is needed for this stateless fixture Worker.
- This repository has no production target or promotion path. Publishing an npm
  package or deploying this test Worker does not authorize production activation.
  Production provider composition and deployment belong to the owning runtime and
  require a separately reviewed Environment Contract.
