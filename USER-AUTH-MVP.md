# Personal key: first OpenCode setup

This slice connects a Ladder account to the MCP human gateway and adds Google Docs read-only access. It does not enable public signup or user quota enforcement.

## Create a user and issue a key

An administrator uses the Ladder endpoint with the existing owner `LADDER_TOKEN`. It returns the `user_id` and personal `token`; an administrator can supply `user_id` to preserve an existing trusted identity such as a Telegram username, or omit it to generate one. The raw token is shown only once and the database keeps only its hash. Avoid printing or pasting the response into chat/history. With `jq` installed, this saves it directly into a private local file:

```sh
set -euo pipefail
umask 077
mkdir -p "$HOME/agent-tokens/trained-assist"
token_file="$HOME/agent-tokens/trained-assist/personal-token"
test ! -e "$token_file" || { echo 'token file already exists; refusing to overwrite' >&2; exit 1; }
response=$(curl -fsS https://llm-ladder.trainedassist.store/v1/admin/users \
  -H "Authorization: Bearer $LADDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"person-user-001","email":"person@example.com","role":"user","label":"OpenCode"}')
printf '%s' "$response" | jq -er .token > "$token_file"
unset response
```

The owner token is not the user's runtime credential. An additional personal key may be issued with `POST /v1/users/{user_id}/tokens` (admin-only; the `/v1/admin/users/{user_id}/keys` alias is also supported).

Personal keys are restricted in Ladder to `GET /v1/models` and `POST /v1/chat/completions`; they cannot call administrative or aggregate operational endpoints. Calls are attributed to the authenticated `user_id`, regardless of a caller-supplied `x-ladder-user` header.

Use the personal key as the Bearer credential for both the Ladder OpenAI-compatible provider and the MCP remote server. The MCP sandbox deployment binds to the same `trained-assist-llm-ladder-trace` D1 database. The existing machine test Worker and its Ed25519 run-binding contract remain separate and unchanged.

OpenCode remote MCP configuration uses a static authorization header for this key. Keep the key in an environment variable and set `oauth: false` so OpenCode does not start an OAuth flow for an API-key server ([OpenCode MCP configuration](https://opencode.ai/docs/mcp-servers/)):

```json
{
  "mcp": {
    "trained-assist": {
      "type": "remote",
      "url": "https://<deployed-user-worker>/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:TRAINED_ASSIST_TOKEN}"
      }
    }
  }
}
```

## Google Docs read-only connection

The MCP server exposes `google_docs.connect` and `google_docs.get_document` to authenticated users. Call `google_docs.connect` in OpenCode and open the returned authorization URL in a browser. Google returns to `/oauth/google/callback`; the callback stores the refresh token encrypted in the same Ladder D1 identity database. Then call `google_docs.get_document` with a document ID. The integration requests only `documents.readonly`; there is no Drive search/listing or write tool.

Before enabling this flow in a Worker deployment:

1. Enable the Google Docs API and create a Google OAuth Web application client.
2. Set `GOOGLE_REDIRECT_URI` to the exact deployed URL ending in `/oauth/google/callback` and register that exact redirect URI in Google Cloud Console.
3. Set Worker secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `USER_CREDENTIALS_KEY`. The last value must be a randomly generated 32-byte base64url key; keep a backup in the team's secret manager. Never use a Wrangler `--var` for these values.
4. Apply Ladder migration `0013_user_credentials.sql` to the shared identity D1 before deploying the user gateway.

No OAuth secrets or real user credentials are present in this repository. The callback returns only a generic success/failure page; token values never go to the browser or MCP response. Disconnect/revoke UI and encryption-key rotation are follow-up product work.

## Current boundary

The personal key proves the account identity; it is not a Google credential. Google access is separately granted by the owner of the Google account and scoped to that user.

Public self-registration stays disabled until trial limits and abuse controls are enforced in Ladder. User-supplied provider credentials must be added through a dedicated secure connection flow and resolved internally by the provider, never returned in MCP output.
