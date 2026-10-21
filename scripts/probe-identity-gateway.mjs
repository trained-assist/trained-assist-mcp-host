#!/usr/bin/env node
// probe-identity-gateway.mjs — component probe for the identity-lane MCP
// gateway personal-key auth (Epic #253 I05.c). No LLM involved.
//
//   IDENTITY_GATEWAY=https://...-identity.skillset-apply.workers.dev/mcp \
//     RECRUITER_KEY=mcp_i05c_... SALES_KEY=mcp_i05c_... \
//     node scripts/probe-identity-gateway.mjs
//
// Checks: initialize; unauthenticated tools/list denied; product catalog
// tools/list per key; whoami identity; synthetic fixture tools stay hidden
// from every role; unknown key denied. The ZeroCreds wallet tools are part of
// the allowed set because a wallet profile can be mapped for a user, so they
// are accepted when present and are never required. Keys are never printed.

const gateway = process.env.IDENTITY_GATEWAY || 'https://trained-assist-mcp-host-identity.skillset-apply.workers.dev/mcp';
const recruiterKey = process.env.RECRUITER_KEY || '';
const salesKey = process.env.SALES_KEY || '';

let failures = 0;

function check(name, ok, evidence) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence === undefined ? '' : ` — ${evidence}`}`);
  if (!ok) failures += 1;
}

async function rpc(body, key) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(gateway, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { parseError: text.slice(0, 200) }; }
  return { status: response.status, payload };
}

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'epic253-i05c-probe', version: '1.0' } } });
check('initialize', init.status === 200 && init.payload?.result?.serverInfo?.name === 'trained-assist-mcp-host', `http=${init.status} server=${init.payload?.result?.serverInfo?.name}`);

const anonList = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
check('unauthenticated tools/list denied', anonList.payload?.error?.code === -32001, `code=${anonList.payload?.error?.code}`);

if (!recruiterKey || !salesKey) {
  console.log('SKIP role checks: RECRUITER_KEY/SALES_KEY not both provided');
  process.exit(failures === 0 ? 0 : 1);
}

const productCatalog = ['google_docs.connect', 'google_docs.get_document', 'identity.whoami'];
const walletTools = ['zerocreds_wallet_form_create', 'zerocreds_wallet_form_status',
  'zerocreds_wallet_connection_status', 'zerocreds_wallet_connection_revoke'];
const allowedTools = [...productCatalog, ...walletTools];

function catalogOk(names) {
  const sorted = [...names].sort();
  return productCatalog.every((name) => sorted.includes(name))
    && sorted.every((name) => allowedTools.includes(name));
}

const recruiterList = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, recruiterKey);
const recruiterNames = (recruiterList.payload?.result?.tools || []).map((t) => t.name);
check('recruiter tools/list', catalogOk(recruiterNames), JSON.stringify(recruiterNames));

const salesList = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, salesKey);
const salesNames = (salesList.payload?.result?.tools || []).map((t) => t.name);
check('sales tools/list', catalogOk(salesNames), JSON.stringify(salesNames));

const whoami = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'identity.whoami', arguments: {} } }, recruiterKey);
let whoamiParsed = null;
try { whoamiParsed = JSON.parse(whoami.payload?.result?.content?.[0]?.text || 'null'); } catch {}
check('recruiter whoami', whoamiParsed?.role === 'recruiter' && typeof whoamiParsed?.trace?.userId === 'string', `role=${whoamiParsed?.role} userId=${whoamiParsed?.trace?.userId}`);

const nonce = `i05c-probe-${Date.now()}`;
const fixture = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'recruiter.fixture_read', arguments: { nonce } } }, recruiterKey);
const fixtureText = String(fixture.payload?.result?.content?.[0]?.text || '');
const fixtureDenied = fixture.payload?.result?.isError === true || fixture.payload?.error !== undefined;
check('synthetic fixture tool hidden from recruiter', fixtureDenied && !fixtureText.includes('recruiter-fixture-marker'), `isError=${fixture.payload?.result?.isError} text=${fixtureText.slice(0, 80)}`);

const crossRole = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'recruiter.fixture_read', arguments: { nonce } } }, salesKey);
const crossRoleDenied = crossRole.payload?.result?.isError === true || crossRole.payload?.error !== undefined;
check('synthetic fixture tool hidden from sales', crossRoleDenied && !String(crossRole.payload?.result?.content?.[0]?.text || '').includes('recruiter-fixture-marker'), `isError=${crossRole.payload?.result?.isError} text=${String(crossRole.payload?.result?.content?.[0]?.text || '').slice(0, 80)}`);

const unknown = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }, 'mcp_i05c_definitely_not_a_valid_key_0000000000000000');
check('unknown key denied', unknown.payload?.error?.code === -32001, `code=${unknown.payload?.error?.code}`);

console.log(failures === 0 ? 'PROBE_PASS' : `PROBE_FAIL count=${failures}`);
process.exit(failures === 0 ? 0 : 1);
