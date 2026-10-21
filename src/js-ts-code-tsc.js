'use strict';

// Optional TypeScript compiler bridge.
//
// The host ships with zero runtime dependencies, so `typescript` is a
// devDependency and this module is only loaded by Node entry points (the
// stdio MCP server and the tests). The Worker build never imports it, so the
// Worker bundle never pulls in the compiler.

function createTypeScriptBridge() {
  let ts = null;
  try {
    // eslint-disable-next-line
    ts = require('typescript');
  } catch {
    return null;
  }

  function positionOf(compiler, diagnostic) {
    try {
      const { line, character } = compiler.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start);
      return `line ${line + 1}, col ${character + 1}`;
    } catch {
      return '';
    }
  }

  function transpile(code) {
    try {
      const result = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2020,
          isolatedModules: true,
          noEmit: true,
        },
        reportDiagnostics: true,
        fileName: 'check.ts',
      });
      const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (errors.length) {
        const first = errors[0];
        const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
        const where = first.start != null && first.file ? positionOf(ts, first) : '';
        return { error: where ? `${where}: ${message}` : message };
      }
      return { error: null };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }

  function typeCheck(code) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const cp = require('node:child_process');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsts-'));
    const file = path.join(tmpDir, 'check.ts');
    fs.writeFileSync(file, code, 'utf8');
    try {
      cp.execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'es2020', '--module', 'commonjs', '--skipLibCheck', file], {
        timeout: 30000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { valid: true, error: null, note: null };
    } catch (err) {
      const out = String((err && err.stdout) || (err && err.stderr) || (err && err.message) || err);
      const match = out.match(/error TS\d+:[^\n]*/);
      return { valid: false, error: match ? match[0].trim() : out.slice(0, 300).trim(), note: null };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  return { transpile, typeCheck };
}

module.exports = { createTypeScriptBridge };
