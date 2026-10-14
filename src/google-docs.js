'use strict';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/documents.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const PROFILE_ID = 'default';
const MAX_DOCUMENT_CHARS = 40_000;

function b64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sha256(value) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function encryptionKey(env) {
  if (!env.USER_CREDENTIALS_KEY) throw new Error('Google connection is not configured');
  const raw = fromB64url(env.USER_CREDENTIALS_KEY);
  if (raw.byteLength !== 32) throw new Error('Credential encryption key must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptJson(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key, plaintext);
  return `${b64url(iv)}.${b64url(ciphertext)}`;
}

async function decryptJson(env, encoded) {
  const [ivPart, ciphertextPart] = String(encoded).split('.');
  if (!ivPart || !ciphertextPart) throw new Error('Stored credential is invalid');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64url(ivPart) },
    await encryptionKey(env),
    fromB64url(ciphertextPart),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function oauthConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
    && env.MCP_IDENTITY_DB && env.USER_CREDENTIALS_KEY);
}

async function beginGoogleAuthorization(env, identity) {
  if (!oauthConfigured(env)) throw new Error('Google OAuth is not configured on this gateway');
  await env.MCP_IDENTITY_DB.prepare('DELETE FROM identity_oauth_states WHERE expires_at <= ?').bind(Date.now()).run();
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const stateHash = await sha256(state);
  const verifierCiphertext = await encryptJson(env, { verifier });
  const now = Date.now();
  await env.MCP_IDENTITY_DB.prepare(
    `INSERT INTO identity_oauth_states
      (state_hash, user_id, provider, verifier_ciphertext, created_at, expires_at)
     VALUES (?, ?, 'google', ?, ?, ?)`
  ).bind(stateHash, identity.userId, verifierCiphertext, now, now + 10 * 60 * 1000).run();

  const challenge = await sha256(verifier);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
}

async function exchangeGoogleCode(env, code, verifier) {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.refresh_token || !String(payload.scope || '').split(/\s+/).includes(GOOGLE_SCOPE)) {
    throw new Error('Google authorization failed; reconnect and grant read-only offline access');
  }
  return payload;
}

async function finishGoogleAuthorization(env, url) {
  if (!oauthConfigured(env)) return htmlPage('Google connection is not configured.', 503);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!state || !code || url.searchParams.has('error')) return htmlPage('Google authorization was cancelled or invalid.', 400);

  const stateHash = await sha256(state);
  const row = await env.MCP_IDENTITY_DB.prepare(
    `SELECT user_id, verifier_ciphertext, expires_at FROM identity_oauth_states
     WHERE state_hash = ? AND provider = 'google'`
  ).bind(stateHash).first();
  if (!row || row.expires_at <= Date.now()) return htmlPage('This Google authorization link expired. Start again in OpenCode.', 400);
  // State is single-use. Google also enforces one-time authorization codes.
  await env.MCP_IDENTITY_DB.prepare('DELETE FROM identity_oauth_states WHERE state_hash = ?').bind(stateHash).run();

  try {
    const { verifier } = await decryptJson(env, row.verifier_ciphertext);
    const tokens = await exchangeGoogleCode(env, code, verifier);
    const previous = await env.MCP_IDENTITY_DB.prepare(
      `SELECT ciphertext FROM identity_user_credentials
       WHERE user_id = ? AND profile_id = ? AND provider = 'google'`
    ).bind(row.user_id, PROFILE_ID).first();
    const oldCredential = previous ? await decryptJson(env, previous.ciphertext) : {};
    const ciphertext = await encryptJson(env, {
      refreshToken: tokens.refresh_token || oldCredential.refreshToken,
    });
    const now = Date.now();
    await env.MCP_IDENTITY_DB.prepare(
      `INSERT INTO identity_user_credentials
        (user_id, profile_id, provider, ciphertext, key_version, scopes, created_at, updated_at)
       VALUES (?, ?, 'google', ?, 'v1', ?, ?, ?)
       ON CONFLICT(user_id, profile_id, provider) DO UPDATE SET
         ciphertext = excluded.ciphertext, key_version = excluded.key_version,
         scopes = excluded.scopes, updated_at = excluded.updated_at`
    ).bind(row.user_id, PROFILE_ID, ciphertext, GOOGLE_SCOPE, now, now).run();
    return htmlPage('Google Docs connected. You can return to OpenCode.', 200);
  } catch {
    return htmlPage('Could not finish Google authorization. Start again in OpenCode.', 400);
  }
}

function htmlPage(message, status) {
  const escaped = message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Google Docs connection</title><p>${escaped}</p>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

async function accessTokenForUser(env, userId) {
  if (!oauthConfigured(env)) throw new Error('Google Docs is not configured on this gateway');
  const row = await env.MCP_IDENTITY_DB.prepare(
    `SELECT ciphertext FROM identity_user_credentials
     WHERE user_id = ? AND profile_id = ? AND provider = 'google'`
  ).bind(userId, PROFILE_ID).first();
  if (!row) throw new Error('Google Docs is not connected. Call google_docs.connect first.');
  const credential = await decryptJson(env, row.ciphertext);
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: credential.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) throw new Error('Google authorization expired or was revoked. Reconnect Google Docs.');
  return token.access_token;
}

function collectText(value, chunks) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.content === 'string' && value.content) chunks.push(value.content);
  if (typeof value.textRun?.content === 'string' && value.textRun.content) chunks.push(value.textRun.content);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'textRun' || key === 'content') continue;
    if (Array.isArray(child)) for (const item of child) collectText(item, chunks);
    else if (child && typeof child === 'object') collectText(child, chunks);
  }
}

async function getGoogleDocument(env, userId, documentId) {
  if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(documentId)) {
    throw new Error('documentId must be a Google Docs document ID');
  }
  const accessToken = await accessTokenForUser(env, userId);
  const response = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?includeTabsContent=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Google cannot read this document; check its access or reconnect Google Docs.');
    if (response.status === 404) throw new Error('Google Docs document not found or not accessible.');
    throw new Error('Google Docs request failed.');
  }
  const document = await response.json();
  const chunks = [];
  collectText(document.tabs || document.body, chunks);
  let text = chunks.join('');
  const truncated = text.length > MAX_DOCUMENT_CHARS;
  if (truncated) text = text.slice(0, MAX_DOCUMENT_CHARS);
  return { documentId, title: document.title || '', text, truncated };
}

function createGoogleDocsProvider(env) {
  return {
    id: 'google-docs-readonly',
    version: '1.0.0',
    tools: [
      {
        name: 'google_docs.connect',
        description: 'Start a secure Google Docs read-only connection for the signed-in user.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        requiredBindings: [],
        providerId: 'google-docs-readonly',
        handler: async (_args, context) => beginGoogleAuthorization(env, context.identity),
      },
      {
        name: 'google_docs.get_document',
        description: 'Read the text of a Google document the connected user can access (read-only).',
        inputSchema: {
          type: 'object',
          properties: { documentId: { type: 'string', minLength: 10, maxLength: 200 } },
          required: ['documentId'],
          additionalProperties: false,
        },
        requiredBindings: [],
        providerId: 'google-docs-readonly',
        handler: async (args, context) => getGoogleDocument(env, context.identity.userId, args.documentId),
      },
    ],
  };
}

module.exports = {
  GOOGLE_SCOPE,
  beginGoogleAuthorization,
  finishGoogleAuthorization,
  createGoogleDocsProvider,
  getGoogleDocument,
};
