-- I05.a: align identity tables with canonical shared schema (Ladder I02.a)
-- No production data; additive-only. Safe to re-run (IF NOT EXISTS).
-- Adds columns for service, user status, key status, and key expiry.

ALTER TABLE identity_users ADD COLUMN service TEXT NOT NULL DEFAULT 'mcp-host';
ALTER TABLE identity_users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE identity_api_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE identity_api_keys ADD COLUMN expires_at INTEGER;
