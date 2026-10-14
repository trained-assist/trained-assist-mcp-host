# User identity and MCP credentials: MVP architecture

## Decisions

- The Ladder identity tables are the initial source of truth for users and personal API keys. The MCP Worker will use the same identity database; it will not maintain a second user/key directory.
- The product-owner account to link is identified as `user_id=trained-assist-product-owner` with the email supplied by the user; it should receive role `admin` (personal key, not the global service/admin bearer). The admin provisioning API must accept an explicit `user_id` so it matches the existing Telegram/agent identity instead of inventing a second ID.
- A user has one Trained Assist account and one personal key usable by OpenCode for both the OpenAI-compatible Ladder endpoint and remote MCP. The database stores only a hash; issuance returns the raw key once.
- Account provisioning has two paths: an admin-only operation for creating users/issuing keys, and public self-registration with trial defaults. Public signup is enabled only with abuse controls and an enforceable trial limit.
- Trial defaults, if the existing Ladder policy cannot be found or is ambiguous: 7 agent runs per rolling 4 hours, 20 per day, 50 per week, and 100 per month; 3 million paid tokens and 50 million free tokens. Paid tier scales these limits by 5; the next tier scales them by a further 5 (25x trial). Apply these in Ladder as the quota authority, not in MCP.
- The first useful MCP provider is Google Docs with read-only access. The initial implementation requests only `documents.readonly` and reads a known document ID; Drive search and write methods are explicitly out of scope. HH remains a follow-up integration for debugging the existing connector.
- Provider credentials belong to a user and, where useful, a profile. The MVP stores Google refresh credentials AES-GCM encrypted in the shared Ladder D1, with the encryption key held as a Worker secret. Tools resolve credentials internally. Tool results and ordinary MCP arguments must not expose stored secrets.
- The current machine run-mode and its Ed25519 run-binding contract remain intact. Later agent runs will carry the initiating user identity and enforce the same user limits; they must use trusted secret/binding transport rather than prompt or RunSpec fields.
- The first local OpenCode UX is branded **Mem-GPT** (`mem-gpt` provider ID). The user enters one personal Ladder key in the fork; OpenCode stores it in its existing local `auth.json` with restrictive permissions. The custom MCP config references that auth entry by provider ID, so the raw key is not copied into `opencode.json`.
- The MVP connection form enables the remote user MCP by default, with an explicit option to leave MCP disabled. Reconnecting updates the same local credential; disconnecting the provider removes it using existing OpenCode auth management.
- The OpenCode MVP target is `https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp`, deployed from `wrangler.user.jsonc` with the Ladder identity D1. The older `trained-assist-mcp-host-identity` Worker binds a separate `trained-assist-mcp-identity` database and must not be used for Ladder personal keys. The new target is not live until its dedicated sandbox workflow is run.

## Request paths

```text
OpenCode
  ├─ Authorization: Bearer <personal key> ──> Ladder ──> user identity + limits
  └─ Authorization: Bearer <personal key> ──> MCP ──> user/profile policy
                                                       └─> Google Docs read-only provider
                                                           └─> encrypted user credential

Later: Trained Agent run ──> user-bound run authorization ──> Ladder/MCP under same user
```

The user key identifies the account. It does not itself select a profile, grant every tool, or contain Google credentials. MCP derives the principal from the verified key and applies server-side tool policy. Profiles and provider connections are separate records.

## Delivery slices

1. **Identity connection (first):** use the Ladder identity schema as the canonical schema; add/finish user-token authentication in Ladder and MCP, admin provisioning (`POST /v1/admin/users` and `POST /v1/admin/users/{user_id}/keys`), and one-time personal key issuance. Preserve existing shared Ladder tokens during rollout. Do not reimplement quota enforcement in this slice.
2. **OpenCode fork connection UX:** add Mem-GPT to the provider picker, accept the personal key once, store it through OpenCode's existing auth store, configure the Ladder-compatible model endpoint, and optionally enable remote MCP using a credential reference. Never persist the raw token in the ordinary config file.
3. **Google Docs read-only:** add PKCE-bound Google OAuth, a user-scoped connection flow, encrypted refresh-token storage, and a tool to read a known document ID. Resolve credentials only inside the provider call. Do not return credentials to MCP clients.
4. **HH connector:** attach the existing HH connector to user/profile credentials and use OpenCode calls to debug it.
5. **Trial registration and limits:** public registration with the defaults above, abuse controls, and Ladder-enforced quotas. Paid tier is 5x trial; next tier is 25x trial.
6. **Product:** add the website/domain when the backend flow is stable. Add OAuth login/authorization UX and broader account management as needed.
7. **Agent delegation:** bind each agent run to the initiating user and account limits. Prefer a short-lived, narrowly scoped delegation for downstream calls; never put long-lived secrets in prompts or RunSpec.

## Decisions still needed before enabling the corresponding slice

- Public signup: email verification or another proof of account ownership and abuse protection. The quota fallback values above are owner-provided; confirm the token-count window against the existing Ladder policy before implementing quota accounting.
- Google connection: OAuth client/redirect configuration must be provisioned before live connections. MVP scope is `documents.readonly`; Google OAuth app verification may be needed before general public signup.
- Credential storage: MVP uses the existing private D1 behind the Worker plus AES-GCM encryption with a Worker secret. This is an initial vault, not a complete key-rotation/backup lifecycle; implement rotation and disconnect/revocation before broad product rollout.
- Profiles: define whether the first Google connection is account-wide or attached to a named profile. The data model keeps this choice open.

## Workspace

Implementation starts from the `trained-assist-mcp-host` repository because it already owns the MCP protocol, Cloudflare Worker adapters, and the human-authentication slice. Ladder changes remain in `trained-assist-llm-ladder`. The user-facing website can be a separate later deployment; it is not required for the API and OpenCode MVP.

## Implementation status (2026-10-14)

- OpenCode fork `opencode-mem`, branch `out-of-box-integration`: Mem-GPT provider-picker entry and token form implemented; one credential is stored via OpenCode's Auth API, provider config points to Ladder, and MCP can be enabled with the same local credential reference (`authProviderID`). The raw token is not written to the general config.
- MCP core config schema, OpenCode resolver, generated SDK types, and OpenAPI schema include `authProviderID`; remote MCP sends the credential as a Bearer header.
- Ladder auth succeeds for the owner's personal key (`GET /v1/models` → 200). The older `trained-assist-mcp-host-identity` responds MCP `Unauthorized`, so cross-service auth has not passed yet.
- Static type checks passed for core, OpenCode, SDK, and app. Current Ladder tests pass (376/376); MCP host tests pass (37/37); Ladder Wrangler dry-run passes. The OpenCode URL is now staged for the new Ladder-D1-backed human Worker, pending its deployment.
- The supplied owner identity is provisioned as `trained-assist-product-owner`, email as provided, role `admin`. The raw key is saved locally with mode 0600; it was not printed or committed.
- Cloudflare Keychain material documented in the workspace is explicitly sandbox-scoped; it was not used against production. The available GCP identity has no IAM binding for the supplied owner email among accessible projects. No Telegram connector is available to issue `/adduser` as an actual Telegram user; local inspection confirms that legacy command creates a separate password-based KV profile, not the canonical Ladder identity.
- Cloudflare sandbox metadata showed that the older identity Worker is backed by a separate D1. The Ladder production CI deploy applies its own identity and user-credential schema; no direct sandbox D1 writes were made.
- Ladder follow-up: PR [#271](https://github.com/trained-assist/trained-assist-llm-ladder/pull/271) merged and production deploy succeeded. The admin endpoint created the supplied owner account and one-time key. It remains safely stored at `~/agent-tokens/trained-assist/mem-gpt-token` (0600).
- Remaining first-slice follow-up: deploy the new Ladder-D1-backed human gateway, verify token-backed `tools/list` and `identity.whoami`, then test the key through the Mem-GPT flow. Google OAuth still needs production client/redirect/Worker secrets before `google_docs.connect` can complete.
