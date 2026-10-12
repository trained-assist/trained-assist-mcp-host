#!/usr/bin/env node
// probe-disabled-user.mjs — negative probe: a disabled identity user is
// rejected by the identity-lane MCP gateway on the next request, including
// from an already-open client (Epic #253 I05.c). No LLM involved.
//
//   IDENTITY_GATEWAY=https://...-identity.skillset-apply.workers.dev/mcp \
//     DISABLED_KEY=<personal key of a user toggled to status=disabled> \
//     DISABLED_USER_ID=u-... OTHER_KEY=<active user key> OTHER_ROLE=recruiter \
//     node scripts/epic253/probe-disabled-user.mjs
//
// Keys are never printed. Expected: every disabled-user request is denied
// with -32001 and no role data leaks; the other user (if provided) still
// passes tools/list, proving the denial is scoped to the disabled user.

const gateway = process.env.IDENTITY_GATEWAY || 'https://trained-assist-mcp-host-identity.skillset-apply.workers.dev/mcp';
const disabledKey = process.env.DISABLED_KEY || '';
const disabledUserId = process.env.DISABLED_USER_ID || '';
const otherKey = process.env.OTHER_KEY || '';
const otherRole = process.env.OTHER_ROLE || '';

let failures = 0;

function check(name, ok, evidence) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence === undefined ? '' : ` — ${evidence}`}`);
  if (!ok) failures += 1;
}

async function rpc(body, key, sessionId) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(gateway, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { parseError: text.slice(0, 200) }; }
  return { status: response.status, payload, sessionId: response.headers.get('mcp-session-id'), text };
}

if (!disabledKey) {
  console.log('SKIP: DISABLED_KEY not provided');
  process.exit(0);
}

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'epic253-i05c-disabled-probe', version: '1.0' } } });
check('initialize (open client)', init.status === 200 && init.payload?.result?.serverInfo?.name === 'trained-assist-mcp-host', `http=${init.status} session=${init.sessionId ? 'issued' : 'none'}`);

const openSessionId = init.sessionId || '';

const listAnon = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, disabledKey);
check('disabled user tools/list denied', listAnon.payload?.error?.code === -32001, `code=${listAnon.payload?.error?.code}`);

const listOpen = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, disabledKey, openSessionId);
check('disabled user tools/list denied (open client)', listOpen.payload?.error?.code === -32001, `code=${listOpen.payload?.error?.code}`);

const whoami = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'identity.whoami', arguments: {} } }, disabledKey);
check('disabled user whoami denied', whoami.payload?.error?.code === -32001, `code=${whoami.payload?.error?.code}`);

const fixture = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'recruiter.fixture_read', arguments: { nonce: `i05c-disabled-${Date.now()}` } } }, disabledKey);
const markerLeaked = String(fixture.text).includes('recruiter-fixture-marker');
check('disabled user fixture_read denied', fixture.payload?.error?.code === -32001 && !markerLeaked, `code=${fixture.payload?.error?.code} markerLeaked=${markerLeaked}`);

if (otherKey) {
  const otherList = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, otherKey);
  const otherNames = (otherList.payload?.result?.tools || []).map((t) => t.name);
  check(`${otherRole} user unaffected`, otherList.status === 200 && Array.isArray(otherNames), `http=${otherList.status} tools=${JSON.stringify(otherNames)}`);
}

console.log(failures === 0 ? 'PROBE_PASS' : `PROBE_FAIL count=${failures}`);
process.exit(failures === 0 ? 0 : 1);
