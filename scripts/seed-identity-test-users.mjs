#!/usr/bin/env node
// seed-identity-test-users.mjs — synthetic users + personal keys in the
// identity-lane D1 (Epic #253 I05.c). Sandbox-only ops command.
//
//   SEED_RUN_ID=i05c-20261012-a SEED_PUBLIC_KEY_PEM="$(cat public.pem)" \
//     node scripts/seed-identity-test-users.mjs [--dry-run]
//
// D1 receives key hashes only; plaintext keys are sealed with the provided
// RSA public key and printed as SEED_SEALED lines for local recovery.
// Re-runs with the same SEED_RUN_ID keep users, revoke prior keys with the
// same labels, and issue fresh keys (no duplicate accumulation).

import { spawnSync } from 'node:child_process';
import { constants, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runId = process.env.SEED_RUN_ID || '';
if (!/^[a-z0-9][a-z0-9-]{2,23}$/.test(runId)) {
  throw new Error('SEED_RUN_ID must match /^[a-z0-9][a-z0-9-]{2,23}$/');
}

let publicKey;
try {
  publicKey = createPublicKey(process.env.SEED_PUBLIC_KEY_PEM || '');
} catch {
  throw new Error('SEED_PUBLIC_KEY_PEM must be an RSA public key PEM');
}

const dryRun = process.argv.includes('--dry-run') || process.env.SEED_DRY_RUN === 'true';

const users = [
  { suffix: 'recruiter', role: 'recruiter' },
  { suffix: 'sales', role: 'sales' },
];

function sqlStr(value) {
  if (!/^[a-z0-9@._-]+$/.test(value)) throw new Error(`unsafe SQL value: ${value}`);
  return `'${value}'`;
}

function seal(plain) {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plain, 'utf8'),
  ).toString('base64');
}

async function hashSha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const now = Date.now();
const statements = [];
const issued = [];

for (const user of users) {
  const userId = `u-i05c-${runId}-${user.suffix}`;
  const email = `i05c-${runId}-${user.suffix}@test.epic253.invalid`;
  const label = `epic253-i05c-${runId}-${user.suffix}`;
  const key = `mcp_i05c_${randomBytes(24).toString('hex')}`;
  const keyHash = await hashSha256Hex(key);
  statements.push(
    `INSERT OR IGNORE INTO identity_users (user_id, email, role, service, status, created_at, updated_at) VALUES (${sqlStr(userId)}, ${sqlStr(email)}, ${sqlStr(user.role)}, 'mcp-host', 'active', ${now}, ${now});`,
    `UPDATE identity_api_keys SET revoked_at = ${now} WHERE label = ${sqlStr(label)} AND revoked_at IS NULL;`,
    `INSERT OR IGNORE INTO identity_api_keys (key_hash, user_id, label, status, created_at) VALUES (${sqlStr(keyHash)}, ${sqlStr(userId)}, ${sqlStr(label)}, 'active', ${now});`,
  );
  issued.push({ userId, email, role: user.role, label, keyHash, key });
}

const sql = statements.join('\n');
const sqlPath = join(mkdtempSync(join(tmpdir(), 'epic253-seed-')), 'seed.sql');
writeFileSync(sqlPath, `${sql}\n`);

console.log(`SEED_RUN_ID ${runId}`);
console.log(`SEED_NOW ${now}`);
for (const row of issued) {
  console.log(`SEED_USER user_id=${row.userId} email=${row.email} role=${row.role} label=${row.label} key_hash=${row.keyHash}`);
  console.log(`SEED_SEALED ${row.userId} ${seal(row.key)}`);
}

if (dryRun) {
  console.log('SEED_DRY_RUN sql follows');
  console.log(sql);
  process.exit(0);
}

function wrangler(args) {
  const result = spawnSync('npx', ['--yes', 'wrangler@4.146.0', ...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

wrangler(['d1', 'execute', 'trained-assist-mcp-identity', '--remote', '--config', 'wrangler.identity.jsonc', '--file', sqlPath]);
const verify = wrangler([
  'd1', 'execute', 'trained-assist-mcp-identity', '--remote', '--config', 'wrangler.identity.jsonc', '--json', '--command',
  `SELECT u.user_id, u.email, u.role, u.status, k.label, k.status AS key_status, k.revoked_at IS NULL AS key_live FROM identity_users u JOIN identity_api_keys k ON k.user_id = u.user_id WHERE u.user_id LIKE 'u-i05c-${runId}-%' ORDER BY u.user_id, k.label;`,
]);
console.log(`SEED_VERIFY ${verify.trim()}`);
