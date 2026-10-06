'use strict';

function attachStdio(protocol, { input = process.stdin, output = process.stdout, authorization } = {}) {
  let pending = '';
  input.setEncoding('utf8');
  input.on('data', async (chunk) => {
    pending += chunk;
    if (pending.length > 8 * 1024 * 1024 && !pending.includes('\n')) {
      pending = '';
      return;
    }
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        continue;
      }
      const reply = await protocol.handle({ message, authorization });
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    }
  });
  input.on('end', () => {
    const line = pending.trim();
    if (!line) return;
    try {
      Promise.resolve(protocol.handle({ message: JSON.parse(line), authorization })).then((reply) => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      });
    } catch { /* incomplete final line is discarded */ }
  });
}

module.exports = { attachStdio };
