import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.FIXTURE_PORT || 8731);
const TRACE_PATH = process.env.FIXTURE_TRACE_PATH || "/tmp/epic253-fixture-trace.jsonl";
const SERVER_NAME = "trained-assist-registry-fixture-local";
const TOOL_NAME = "fixture.echo";
const PROTOCOL_VERSION = "2025-06-18";

writeFileSync(TRACE_PATH, "");

function send(res, status, value) {
  const body = value == null ? "" : JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return jsonRpcError(null, -32600, "Invalid request");
  const { id, method, params } = msg;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: "0.1.0-epic253-z00c" },
      },
    };
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: TOOL_NAME,
            description: "Epic #253 Z00.c local fixture: echo a nonce back. Records the call to the trace file.",
            inputSchema: {
              type: "object",
              properties: {
                nonce: { type: "string", description: "Opaque nonce to echo back" },
              },
              required: ["nonce"],
            },
          },
        ],
      },
    };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name !== TOOL_NAME) return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    const nonce = typeof args.nonce === "string" ? args.nonce : "";
    const traceEntry = {
      ts: new Date().toISOString(),
      tool: TOOL_NAME,
      nonce,
      server: SERVER_NAME,
    };
    appendFileSync(TRACE_PATH, JSON.stringify(traceEntry) + "\n");
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ echoed: nonce, fixture: "epic253-z00c", server: SERVER_NAME }) }],
        isError: false,
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "POST" || url.pathname !== "/mcp") {
    return send(res, 404, { error: "not found" });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let msg;
  try {
    msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(res, 400, { error: "bad json" });
  }
  const reply = handleMessage(msg);
  if (!reply) {
    res.writeHead(202);
    return res.end();
  }
  send(res, 200, reply);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fixture-mcp-server listening on http://127.0.0.1:${PORT}/mcp trace=${TRACE_PATH}`);
});
