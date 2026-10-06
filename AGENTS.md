# Repository instructions

## Sandbox-Driven Engineering

Stopping before a safe dev/test run, or refusing to run it because the sandbox may fail, is harmful engineering behavior. This Worker is explicitly test-only: deploy it, send realistic test protocol input, inspect output/logs, fix failures and repeat. Do not stop at local code inspection when its isolated runtime can be used. Production remains a separate protected boundary.

## Environment Contract

### Development / Test / Staging

- **Local:** Node.js 22+, `npm ci`, `npm run check`, `npm test`. Tests use local HTTP/workerd fixtures and synthetic providers; they do not prove deployed Worker or real Runner proof integration.
- **Remote test Worker:** `trained-assist-mcp-host-test-160`, configured by `wrangler.jsonc`; workers.dev endpoint `https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp`, custom test domain `https://registry-test.trainedassist.store/mcp`. Cloudflare identity must match the root repository instructions before any Wrangler operation.
- **Bindings/data:** fixed, read-only `registry.fixture_read` marker, pinned server/profile/principal/catalogue/policy/digest/audience and `registry-mcp-test-160-read` binding. No production provider or production service binding exists. Authentication secret values and signed proofs must remain in trusted secret/config paths.
- **Deploy:** `npx wrangler deploy` from this repository deploys only the named test Worker in `wrangler.jsonc`. This updates a shared integration resource; use a fresh test lease and coordinate only through the owning issue. Do not deploy any unreviewed change outside this test Worker.
- **Input/output:** `npm run remote:e2e` sends authenticated discovery and a short-lived EdDSA invocation proof to `registry.fixture_read`, then checks the fixed fixture marker and matching task/run/profile IDs, plus expiry rejection. The dedicated `sandbox-e2e-v1` signing key is synthetic test infrastructure; it proves Host signature validation, not a real CP/Runner run. Real Runner E2E remains a gap while no VM worker is installed. Missing or invalid bindings fail closed.
- **Observe:** response from `/mcp`; `npx wrangler tail` for Worker console/runtime logs; Cloudflare deployment version. There is no application database or persistent scenario state.
- **Retry/reset:** the fixture is stateless; create a new run/task/proof and retry. Proof and test lease expire. Renew only through owning trusted test configuration; never copy secret values or proofs into repo/issues/chat. Do not reset unrelated CP/Runner state.
- **Permissions:** local tests/build and deploy/request/log inspection against this named Worker are allowed. Production resources, provider credentials, custom-domain security controls, and test secret rotation are protected. Do not weaken authentication or proof checks to make a probe pass.

### Production / Promotion

No production host/provider is configured or authorized by this repository. The release workflow publishes an npm package only for `v*` tags; downstream hosts pin immutable versions. A tag/release is not permission to enable a production provider or deploy production resources. No production promotion path exists until the owning architecture issue defines one.

### Testability Contract / Sandbox Gaps

The Worker responds on workers.dev; a safe malformed JSON-RPC probe returned an MCP invalid-request response. The test lease is extended through `2026-10-14T23:59:59Z`; `node tools/remote-e2e.mjs` exercises authenticated remote discovery and a synthetic short-lived signed fixture invocation on the pinned test Worker. It does not prove a real CP → installed Runner → Host path. The README records unresolved custom-domain DNS/BIC behavior, and no test chat or VM worker is currently installed. Owner issue [#9](https://github.com/trained-assist/trained-assist-mcp-host/issues/9), existing health-descriptor issue [#8](https://github.com/trained-assist/trained-assist-mcp-host/issues/8), parent architecture issue [#182](https://github.com/trained-assist/trained-agent-architecture/issues/182), rollout [#185](https://github.com/trained-assist/trained-agent-architecture/issues/185).
