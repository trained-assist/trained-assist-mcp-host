-- Disposable per-run MCP identities. This lane stores only identifiers and lease state.
CREATE TABLE IF NOT EXISTS mcp_sandbox_users (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES identity_users(user_id),
  profile_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_sandbox_users_expiry ON mcp_sandbox_users(expires_at, revoked_at);
