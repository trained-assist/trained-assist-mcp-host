#!/usr/bin/env node
import { createPrivateKey, randomUUID, sign } from 'node:crypto';

const endpoint = 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp';
const profileId = 'integration-telegram-ux-v1';
const principalId = 'integration-telegram-ux-v1';
const serverId = 'trained-assist-registry-test';
const bindingRef = 'registry-mcp-test-160-read';
const toolName = 'registry.fixture_read';
const policyVersion = 'registry-fixture-policy-v1';
const catalogueVersion = 'registry-fixture-catalogue-v1';
const registryDigest = '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9';
const audience = 'trained-assist:registry-mcp:test';
const scope = 'registry:fixture-read';
const token = process.env.MCP_TEST_AUTH_TOKEN;
if (!token || token.length < 16) throw new Error('MCP_TEST_AUTH_TOKEN is missing or too short');

let privateKey;
try {
  const jwk = JSON.parse(process.env.MCP_TEST_E2E_PRIVATE_JWK || 'null');
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || !jwk.d || typeof jwk.x !== 'string' || !jwk.x) throw new Error();
  privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
} catch {
  throw new Error('MCP_TEST_E2E_PRIVATE_JWK must be a valid test-only Ed25519 private JWK');
}

const taskId = `ut-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const runId = `run_${randomUUID()}`;
const now = Math.floor(Date.now() / 1000);

function proof({ issuedAt = now, expiresAt = now + 90 } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    allowedTools: [toolName], aud: audience, bindingRef, catalogueVersion, exp: expiresAt,
    iat: issuedAt, iss: 'trained-assist-agent-runner', policyVersion, principalId,
    profileId, registryDigest, runId, scope, serverId, sub: runId, userTaskId: taskId,
  })).toString('base64url');
  const content = `${header}.${claims}`;
  return `${content}.${sign(null, Buffer.from(content), privateKey).toString('base64url')}`;
}

async function post(message, operation, runBinding = null) {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2024-11-05',
    'x-mcp-operation': operation,
    'x-mcp-user-task-id': taskId,
    'x-mcp-generation': '1',
    'x-mcp-profile': profileId,
    'x-mcp-principal-id': principalId,
  };
  if (operation === 'invocation') {
    headers['x-mcp-scope'] = scope;
    headers['x-mcp-run-id'] = runId;
    headers['x-mcp-run-binding'] = runBinding;
  }
  const response = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(15_000),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Remote MCP returned non-JSON at ${operation} (HTTP ${response.status})`); }
  return { response, body };
}

const discoveryId = `${taskId}:discovery`;
const discovery = await post({ jsonrpc: '2.0', id: discoveryId, method: 'tools/list', params: {} }, 'discovery');
if (!discovery.response.ok || discovery.body?.jsonrpc !== '2.0' || discovery.body?.id !== discoveryId
    || !Array.isArray(discovery.body?.result?.tools)
    || discovery.body.result.tools.length !== 1 || discovery.body.result.tools[0]?.name !== toolName) {
  throw new Error(`CP-style discovery failed (HTTP ${discovery.response.status})`);
}

const runBinding = proof();
const invocationId = `${taskId}:invocation-list`;
const invocationList = await post({ jsonrpc: '2.0', id: invocationId, method: 'tools/list', params: {} }, 'invocation', runBinding);
if (!invocationList.response.ok || invocationList.body?.jsonrpc !== '2.0' || invocationList.body?.id !== invocationId
    || !Array.isArray(invocationList.body?.result?.tools)
    || invocationList.body.result.tools.length !== 1 || invocationList.body.result.tools[0]?.name !== toolName) {
  const errorCode = Number.isInteger(invocationList.body?.error?.code) ? invocationList.body.error.code : 'none';
  const responseShape = invocationList.body?.error ? 'jsonrpc-error' : Array.isArray(invocationList.body?.result?.tools) ? 'tools-result' : 'other';
  const idMatches = invocationList.body?.id === invocationId;
  throw new Error(`Signed invocation listing failed (HTTP ${invocationList.response.status}, shape ${responseShape}, errorCode ${errorCode}, idMatches ${idMatches})`);
}

const callId = `${taskId}:call`;
const call = await post({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: toolName, arguments: {} } }, 'invocation', runBinding);
const text = call.body?.result?.content?.[0]?.text;
let fixture;
try { fixture = JSON.parse(text); } catch { fixture = null; }
if (!call.response.ok || call.body?.jsonrpc !== '2.0' || call.body?.id !== callId
    || fixture?.marker !== 'registry-fixture-marker-160-v1' || fixture?.profileId !== profileId
    || fixture?.taskId !== taskId || fixture?.runId !== runId) {
  throw new Error(`Signed fixture invocation failed (HTTP ${call.response.status})`);
}

const expiredId = `${taskId}:expired-proof`;
const expired = await post({ jsonrpc: '2.0', id: expiredId, method: 'tools/list', params: {} }, 'invocation', proof({ issuedAt: now - 120, expiresAt: now - 60 }));
if (!expired.response.ok || expired.body?.jsonrpc !== '2.0' || expired.body?.id !== expiredId
    || expired.body?.error?.code !== -32001) {
  throw new Error(`Expired proof was not rejected (HTTP ${expired.response.status})`);
}

console.log(JSON.stringify({
  ok: true, endpointHost: new URL(endpoint).hostname, profileId, principalId, serverId, toolName,
  taskId, runId, discovery: 'pass', invocation: 'pass', marker: fixture.marker, expiredProof: 'rejected',
}));
