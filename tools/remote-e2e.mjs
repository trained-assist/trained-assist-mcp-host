#!/usr/bin/env node
import { createPrivateKey, randomUUID, sign } from 'node:crypto';

const baseUrl = (process.env.MCP_TEST_URL || 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp').replace(/\/$/, '');
const token = process.env.MCP_TEST_AUTH_TOKEN;
const privateJwkText = process.env.MCP_TEST_E2E_PRIVATE_JWK;
if (!token || !privateJwkText) {
  console.error('MCP_TEST_AUTH_TOKEN and MCP_TEST_E2E_PRIVATE_JWK must come from trusted test secret storage.');
  process.exit(2);
}

const taskId = `sde-${randomUUID()}`;
const runId = `run_${randomUUID()}`;
const principalId = 'integration-telegram-ux-v1';
const profileId = 'integration-telegram-ux-v1';
const serverId = 'trained-assist-registry-test';
const bindingRef = 'registry-mcp-test-160-read';
const policyVersion = 'registry-fixture-policy-v1';
const catalogueVersion = 'registry-fixture-catalogue-v1';
const registryDigest = '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9';
const scope = 'registry:fixture-read';
const toolName = 'registry.fixture_read';
const base64url = (value) => Buffer.from(value).toString('base64url');
const post = async (id, method, params, headers) => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${method} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
};

const discoveryHeaders = {
  'X-MCP-Operation': 'discovery',
  'X-MCP-User-Task-Id': taskId,
  'X-MCP-Generation': '1',
  'X-MCP-Profile': profileId,
  'X-MCP-Principal-Id': principalId,
};
const listed = await post('discovery', 'tools/list', {}, discoveryHeaders);
if (!listed.result?.tools?.some((tool) => tool.name === toolName)) throw new Error('discovery did not expose the pinned fixture tool');

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'EdDSA', typ: 'JWT', kid: 'sandbox-e2e-v1' };
const claims = {
  allowedTools: [toolName], aud: 'trained-assist:registry-mcp:test', bindingRef,
  catalogueVersion, exp: now + 300, iat: now, iss: 'trained-assist-agent-runner',
  policyVersion, principalId, profileId, registryDigest, runId, scope, serverId,
  sub: runId, userTaskId: taskId,
};
const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
const privateKey = createPrivateKey({ key: JSON.parse(privateJwkText), format: 'jwk' });
const proof = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`;
const invocationHeaders = {
  'X-MCP-Operation': 'invocation',
  'X-MCP-Scope': scope,
  'X-MCP-User-Task-Id': taskId,
  'X-MCP-Profile': profileId,
  'X-MCP-Run-Id': runId,
  'X-MCP-Run-Binding': proof,
};
const called = await post('invocation', 'tools/call', { name: toolName, arguments: {} }, invocationHeaders);
const content = called.result?.content?.find((item) => item.type === 'text')?.text;
let fixture;
try { fixture = JSON.parse(content); } catch { throw new Error('fixture invocation returned no JSON marker'); }
if (fixture.marker !== 'registry-fixture-marker-160-v1' || fixture.taskId !== taskId || fixture.runId !== runId || fixture.profileId !== profileId) {
  throw new Error('fixture invocation returned mismatched marker or run binding');
}

const expiredClaims = { ...claims, exp: now - 1 };
const expiredInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(expiredClaims))}`;
const expiredProof = `${expiredInput}.${sign(null, Buffer.from(expiredInput), privateKey).toString('base64url')}`;
const expiredResponse = await fetch(baseUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...invocationHeaders,
    'X-MCP-Run-Binding': expiredProof,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'expired', method: 'tools/call', params: { name: toolName, arguments: {} } }),
});
const expiredBody = await expiredResponse.json().catch(() => null);
if (expiredResponse.ok && !expiredBody?.error) throw new Error('expired proof was accepted');

console.log(JSON.stringify({ ok: true, endpoint: baseUrl, taskId, runId, profileId, tool: toolName, marker: fixture.marker, expiredProofRejected: true }));
