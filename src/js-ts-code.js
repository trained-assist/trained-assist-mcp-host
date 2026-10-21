'use strict';

// JS/TS code-writing provider.
//
// Design constraints that shaped this file:
//  * The host ships with zero runtime dependencies (enforced by CI), so nothing
//    outside Node built-ins may be imported here.
//  * The same module runs in three places: a Node stdio MCP server, a Node
//    script, and a Cloudflare Worker (no `eval`, no `child_process`, no `fs`).
//    Every optional capability is therefore probed at request time and the tool
//    reports `valid: null` instead of guessing when it cannot verify.

const DEFAULT_BASE_URL = 'https://llm-ladder.trainedassist.store/v1';
const DEFAULT_MODEL = 'service';
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 75000;
const DEFAULT_BUDGET_MS = 165000;
const DEFAULT_API_KEY_FILE = '~/.config/opencode/secrets/ladder-api-key';

const MAX_ITERATIONS = 6;
const MAX_WAVE_STEPS = 8;
const MAX_WAVE_STEPS_PER_WAVE = 3;
const MAX_WAVES = 3;

const MODULE_FORMAT_RULES = {
  cjs: 'CommonJS. Load dependencies with require("...") and export with module.exports. Never use ESM import/export syntax.',
  esm: 'ES module. Load dependencies with import ... from "..." and export with export ... . Never use require() or module.exports.',
};

const MODULE_FORMATS = ['cjs', 'esm', 'auto'];

// ---------------------------------------------------------------------------
// runtime capabilities
// ---------------------------------------------------------------------------

// Resolves a Node built-in without a static `require("node:...")`, so bundlers
// for the Worker build never try to resolve modules the Worker does not have.
function builtin(id) {
  try {
    if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
      return process.getBuiltinModule(id) || null;
    }
  } catch {
    // runtime does not implement process.getBuiltinModule
  }
  try {
    if (typeof module !== 'undefined' && typeof module.require === 'function') {
      return module.require(id) || null;
    }
  } catch {
    // module not available in this runtime
  }
  return null;
}

function detectCapabilities() {
  const caps = { eval: false, spawn: false, fs: false, childProcess: null, fsModule: null, pathModule: null };
  try {
    // eslint-disable-next-line no-new-func
    const probe = new Function('return 1');
    probe();
    caps.eval = true;
  } catch {
    // Cloudflare Workers block dynamic code evaluation outside startup.
    caps.eval = false;
  }
  const cp = builtin('node:child_process');
  if (cp && typeof cp.execFileSync === 'function') {
    caps.spawn = true;
    caps.childProcess = cp;
  }
  const fs = builtin('node:fs');
  if (fs && typeof fs.writeFileSync === 'function' && typeof fs.readFileSync === 'function') {
    caps.fs = true;
    caps.fsModule = fs;
  }
  const path = builtin('node:path');
  if (path && typeof path.resolve === 'function') caps.pathModule = path;
  return caps;
}

function isEvalBlocked(message) {
  return /code evaluation|dynamic code|eval|not supported|disallowed/i.test(String(message || ''));
}

// ---------------------------------------------------------------------------
// syntax validation
// ---------------------------------------------------------------------------

function looksLikeEsm(code) {
  return /(^|\n)\s*(import\s+[^;]|import\s*[{*'"]|export\s+(default|const|let|var|function|class|async|\{))/.test(String(code || ''));
}

function looksLikeCjs(code) {
  const text = String(code || '');
  return /\brequire\s*\(/.test(text) || /\bmodule\.exports\b/.test(text) || /(^|\n)\s*exports\./.test(text);
}

function detectModuleFormat(code) {
  const esm = looksLikeEsm(code);
  const cjs = looksLikeCjs(code);
  if (esm && !cjs) return 'esm';
  if (cjs && !esm) return 'cjs';
  if (esm && cjs) return 'mixed';
  return 'unknown';
}

function checkScriptSyntax(code, caps) {
  if (!caps.eval) {
    return { valid: null, error: null, note: 'This runtime forbids dynamic code evaluation, so script syntax was not verified.' };
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return { valid: true, error: null, note: null };
  } catch (err) {
    const message = String((err && err.message) || err);
    if (isEvalBlocked(message)) {
      return { valid: null, error: null, note: 'This runtime forbids dynamic code evaluation, so script syntax was not verified.' };
    }
    return { valid: false, error: message, note: null };
  }
}

function checkModuleSyntax(code, caps) {
  if (!caps.spawn || typeof process === 'undefined' || !process.execPath) {
    return { valid: null, error: null, note: 'This runtime cannot spawn a parser, so module syntax was not verified.' };
  }
  try {
    caps.childProcess.execFileSync(process.execPath, ['--check', '--input-type=module'], {
      input: code,
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { valid: true, error: null, note: null };
  } catch (err) {
    const stderr = String((err && err.stderr) || (err && err.message) || err);
    const match = stderr.match(/SyntaxError: ([^\n]+)/);
    return { valid: false, error: match ? match[1].trim() : stderr.slice(0, 300).trim(), note: null };
  }
}

function validateJavaScript(code, caps) {
  const script = checkScriptSyntax(code, caps);
  if (script.valid === true) return script;
  if (script.valid === false && !looksLikeEsm(code)) return script;
  const esm = checkModuleSyntax(code, caps);
  if (esm.valid !== null) return esm;
  return { valid: null, error: null, note: esm.note || 'Module syntax could not be verified in this runtime.' };
}

function validateTypeScript(code, typeCheck, tsc) {
  if (!tsc || typeof tsc.transpile !== 'function') {
    return { valid: null, error: null, note: 'TypeScript validation needs the optional TypeScript compiler, which is not available in this runtime.' };
  }
  const syntax = tsc.transpile(code);
  if (syntax && syntax.error) return { valid: false, error: syntax.error, note: null };
  if (typeCheck && typeof tsc.typeCheck === 'function') return tsc.typeCheck(code);
  return { valid: true, error: null, note: null };
}

// ---------------------------------------------------------------------------
// comment stripping (string, template and regex aware)
// ---------------------------------------------------------------------------

function isRegexStart(previous) {
  if (!previous) return true;
  return '(,=:[!&|?{};+-*%~^<>'.includes(previous);
}

function stripComments(code) {
  const text = String(code || '');
  let out = '';
  let i = 0;
  let previous = '';
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
          out += ch + (text[i + 1] || '');
          i += 2;
          continue;
        }
        out += ch;
        i++;
        if (ch === quote) break;
        if (quote === '`' && ch === '$' && text[i] === '{') {
          let depth = 1;
          i++;
          while (i < text.length && depth > 0) {
            const t = text[i];
            if (t === '{') depth += 1;
            else if (t === '}') depth -= 1;
            if (depth > 0) out += t;
            i++;
          }
          out += '}';
          break;
        }
      }
      previous = quote;
      continue;
    }
    if (c === '/' && isRegexStart(previous)) {
      out += c;
      i++;
      let inClass = false;
      while (i < text.length) {
        const ch = text[i];
        out += ch;
        i++;
        if (ch === '\\') {
          if (i < text.length) {
            out += text[i];
            i++;
          }
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      previous = '/';
      continue;
    }
    if (!/\s/.test(c)) previous = c;
    out += c;
    i++;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// secrets and filesystem
// ---------------------------------------------------------------------------

function resolveApiKey(env, options) {
  const explicit = options && options.apiKey;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const fromEnv = env && typeof env.LADDER_API_KEY === 'string' ? env.LADDER_API_KEY.trim() : '';
  if (fromEnv) return fromEnv;
  const processEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  if (processEnv.LADDER_API_KEY && processEnv.LADDER_API_KEY.trim()) return processEnv.LADDER_API_KEY.trim();
  const file = (options && options.apiKeyFile)
    || (env && typeof env.LADDER_API_KEY_FILE === 'string' ? env.LADDER_API_KEY_FILE : '')
    || processEnv.LADDER_API_KEY_FILE
    || DEFAULT_API_KEY_FILE;
  const fs = builtin('node:fs');
  const path = builtin('node:path');
  const os = builtin('node:os');
  if (fs && path) {
    try {
      const expanded = String(file).replace(/^~(?=$|\/)/, os && os.homedir ? os.homedir() : '~');
      const value = fs.readFileSync(path.resolve(expanded), 'utf8').trim();
      if (value) return value;
    } catch {
      // no readable key file
    }
  }
  return null;
}

function resolveWriteRoot(options, caps) {
  const configured = (options && options.writeRoot)
    || (typeof process !== 'undefined' && process.env ? process.env.JS_TS_CODE_WRITE_ROOT : '')
    || '';
  if (configured && caps.pathModule) return caps.pathModule.resolve(configured);
  if (caps.pathModule) return caps.pathModule.resolve(process.cwd());
  return null;
}

function readSourceFile(relativeOrAbsolute, caps, root) {
  if (!caps.fs || !caps.pathModule) return null;
  const target = caps.pathModule.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : caps.pathModule.resolve(root || process.cwd(), relativeOrAbsolute);
  try {
    return caps.fsModule.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

function writeFileSafe(relativeOrAbsolute, content, caps, root) {
  if (!caps.fs || !caps.pathModule) {
    throw new Error('file writes are not supported in this runtime');
  }
  const target = caps.pathModule.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : caps.pathModule.resolve(root || process.cwd(), relativeOrAbsolute);
  const resolvedRoot = root ? caps.pathModule.resolve(root) : null;
  if (resolvedRoot && target !== resolvedRoot && !target.startsWith(resolvedRoot + caps.pathModule.sep)) {
    throw new Error('writePath must be inside the allowed root (' + resolvedRoot + ')');
  }
  caps.fsModule.mkdirSync(caps.pathModule.dirname(target), { recursive: true });
  caps.fsModule.writeFileSync(target, content, 'utf8');
  return target;
}

// ---------------------------------------------------------------------------
// LLM plumbing
// ---------------------------------------------------------------------------

function stripFences(text) {
  const fenced = String(text || '').match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const raw = String(text || '').trim();
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => /^(import\s|export\s|const\s|let\s|var\s|function\s|class\s|async\s|module\.exports|exports\.)/.test(line.trim()));
  if (start > 0) return lines.slice(start).join('\n').trim();
  return raw;
}

function buildSystemPrompt(language, moduleFormat, noComments) {
  const parts = [
    'You are a code writer. Output ONLY the requested source code. No markdown fences, no explanation, no commentary. Return raw code only.',
  ];
  if (moduleFormat && MODULE_FORMAT_RULES[moduleFormat]) {
    parts.push(`The code must use this module format: ${MODULE_FORMAT_RULES[moduleFormat]}`);
  }
  if (noComments) parts.push('Do not include comments or JSDoc.');
  return parts.join(' ');
}

function buildUserContent(task, language, existingCode, context, moduleFormat) {
  const contextBlock = (typeof context === 'string' && context.trim() !== '')
    ? `\n\nPROJECT CONTEXT / CONVENTIONS:\n${context}`
    : '';
  const formatBlock = moduleFormat && MODULE_FORMAT_RULES[moduleFormat]
    ? `\n\nMODULE FORMAT: ${MODULE_FORMAT_RULES[moduleFormat]}`
    : '';
  if (existingCode) {
    return `Modify the following ${language} code according to the task.${contextBlock}${formatBlock}\n\nTASK:\n${task}\n\nEXISTING CODE:\n${existingCode}`;
  }
  return `Write ${language} code for the following task.${contextBlock}${formatBlock}\n\nTASK:\n${task}`;
}

function resolveEndpoint(env, options) {
  const baseUrl = ((options && options.baseUrl)
    || (env && typeof env.LADDER_BASE_URL === 'string' ? env.LADDER_BASE_URL : '')
    || (typeof process !== 'undefined' && process.env ? process.env.LADDER_BASE_URL : '')
    || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = (options && options.model)
    || (env && typeof env.LADDER_MODEL === 'string' ? env.LADDER_MODEL : '')
    || (typeof process !== 'undefined' && process.env ? process.env.LADDER_MODEL : '')
    || DEFAULT_MODEL;
  return { baseUrl, model };
}

async function callLlm({ baseUrl, apiKey, model, system, user, maxTokens, signal, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed (${res.status})`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM returned empty code');
    return { code: stripFences(content), usage: data?.usage || null };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function generateCode({ env, options, task, language, existingCode, model, maxTokens, noComments, context, moduleFormat, signal, attemptTimeoutMs }) {
  const { baseUrl, model: resolvedModel } = resolveEndpoint(env, options);
  const apiKey = resolveApiKey(env, options);
  if (!apiKey) {
    throw new Error('LADDER_API_KEY is not configured. Set the LADDER_API_KEY environment variable or provide a key file (default ~/.config/opencode/secrets/ladder-api-key).');
  }
  const system = buildSystemPrompt(language, moduleFormat, noComments);
  const user = buildUserContent(task, language, existingCode, context, moduleFormat);
  const attempt = () => callLlm({
    baseUrl,
    apiKey,
    model: model || resolvedModel,
    system,
    user,
    maxTokens: maxTokens || DEFAULT_MAX_TOKENS,
    signal,
    timeoutMs: attemptTimeoutMs,
  });
  try {
    return await attempt();
  } catch (err) {
    const message = String((err && err.message) || err);
    const retryable = /abort|timeout/i.test(message);
    if (!retryable || (signal && signal.aborted)) throw err;
    return attempt();
  }
}

async function planNextSteps({ env, options, task, currentCode, language, context, signal }) {
  const { baseUrl, model } = resolveEndpoint(env, options);
  const apiKey = resolveApiKey(env, options);
  if (!apiKey) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const codeBlock = currentCode ? `\n\nCURRENT CODE:\n${currentCode}` : '';
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [
          { role: 'system', content: 'You are a planning assistant. Given an original task and optional current code, decide if the task is complete. If complete, return []. Otherwise return a JSON array of 2-3 small next implementation steps (strings). Return ONLY a JSON array, no markdown, no explanation.' },
          { role: 'user', content: `Language: ${language}.${context ? '\nCONTEXT:\n' + context : ''}\nORIGINAL TASK:\n${task}${codeBlock}` },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = stripFences(String(content || ''));
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((step) => String(step || '').trim()).filter(Boolean).slice(0, MAX_WAVE_STEPS_PER_WAVE);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

function createJsTsCodeProvider(env = {}, options = {}) {
  const budgetMs = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : DEFAULT_BUDGET_MS;
  const attemptTimeoutMs = Number(options.attemptTimeoutMs) > 0 ? Number(options.attemptTimeoutMs) : DEFAULT_ATTEMPT_TIMEOUT_MS;
  const tsc = options.tsc || null;
  // `capabilities` lets the Worker build (and the tests) pin the runtime
  // profile instead of relying on feature detection.
  const capabilities = options.capabilities || null;

  return {
    id: 'js-ts-code',
    version: '1.1.0',
    tools: [
      {
        name: 'write',
        description:
          'JavaScript/TypeScript code writer. Generates code from a natural-language task with an LLM, validates the syntax, and can write the result to a file. ' +
          'CALL (Code Mode): tools["js-ts-code"].write({ task, language, ... }). ' +
          'IMPORTANT: the Code Mode `execute` sandbox cannot load modules (no require, no import()) and cannot touch the filesystem. ' +
          'Do not run generated code with require()/import() inside execute: land it with writePath (or the file-write tool) and run it with the shell tool. ' +
          'Inputs: task (describe the code to write) | code (existing source to validate only) | existingPath (file to read and modify) | existingCode (current code to modify); ' +
          'iterations (string[]: run steps sequentially, each building on the previous result); ' +
          'language ("javascript"|"typescript", default "javascript"); module ("cjs"|"esm"|"auto", default "auto") pins the module format of the generated code; ' +
          'typeCheck (TypeScript only: full tsc --noEmit, slower, needs the TypeScript compiler); maxTokens (per LLM call, default 2000); ' +
          'model (Ladder model id: service|build|conversation|plan|research|doctor, default service); autoChunk (split a large task into waves of steps); ' +
          'noComments (strip comments/JSDoc); writePath (write the result to this path inside the allowed root); context (project conventions/field names). ' +
          'task takes precedence over code (code ignored); iterations takes precedence over task/code. ' +
          'Returns { code, language, moduleFormat, valid, error, note, iterations, warnings, writtenTo?, usage }. ' +
          'valid is null when the runtime cannot verify the syntax; that is not a failure of the generated code. ' +
          'Limits: one call takes roughly 10-120s and produces about 80-120 lines; use autoChunk for larger work. Single file per call.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Natural-language description of the code to write or modify.' },
            code: { type: 'string', description: 'Existing source code to validate instead of generating.' },
            existingCode: { type: 'string', description: 'Current code to modify according to task.' },
            existingPath: { type: 'string', description: 'Path of an existing file to read and use as the code to modify.' },
            iterations: {
              type: 'array',
              description: 'List of iteration tasks to run sequentially; each builds on the previous result. Use for complex tasks split into steps.',
              items: { type: 'string' },
            },
            language: { type: 'string', enum: ['javascript', 'typescript'], default: 'javascript' },
            module: { type: 'string', enum: MODULE_FORMATS, default: 'auto', description: 'Module format of the generated code: cjs, esm, or auto.' },
            typeCheck: { type: 'boolean', default: false, description: 'For TS: run full tsc --noEmit type checking (slower, needs the TypeScript compiler).' },
            maxTokens: { type: 'number', default: DEFAULT_MAX_TOKENS, description: 'Max output tokens per LLM call; lower = faster/smaller. Default 2000 (~80-120 lines).' },
            model: { type: 'string', description: 'Ladder model id override (default service).' },
            autoChunk: { type: 'boolean', default: false, description: 'Split a large task into waves of 2-3 steps, re-planning from the current code until done.' },
            noComments: { type: 'boolean', default: false, description: 'Suppress comments/JSDoc in generated code (repo style).' },
            writePath: { type: 'string', description: 'Optional: write the resulting code to this file path (inside allowed root). Returns writtenTo.' },
            context: { type: 'string', description: 'Optional project context/conventions (types, field names, structure) to guide generation.' },
          },
          additionalProperties: false,
        },
        requiredBindings: [],
        providerId: 'js-ts-code',
        handler: async (args, providerContext = {}) => {
          const started = Date.now();
          const caps = capabilities || detectCapabilities();
          const root = resolveWriteRoot(options, caps);
          const signal = providerContext.signal || null;
          const {
            task, code, existingCode, existingPath, iterations,
            language, module: moduleInput, typeCheck, maxTokens, model,
            autoChunk, noComments, writePath, context,
          } = args || {};

          const lang = language === 'typescript' ? 'typescript' : 'javascript';
          const requestedFormat = MODULE_FORMATS.includes(moduleInput) ? moduleInput : 'auto';
          const warnings = [];
          const iterLog = [];
          let totalUsage = null;
          const addUsage = (usage) => {
            if (!usage) return;
            if (!totalUsage) totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            totalUsage.prompt_tokens += usage.prompt_tokens || 0;
            totalUsage.completion_tokens += usage.completion_tokens || 0;
            totalUsage.total_tokens += usage.total_tokens || 0;
          };
          const remainingBudget = () => Math.max(0, budgetMs - (Date.now() - started));
          const callGenerate = async (step, current) => {
            const timeout = Math.min(attemptTimeoutMs, Math.max(5000, Math.floor(remainingBudget() / 2)));
            return generateCode({
              env,
              options,
              task: step,
              language: lang,
              existingCode: current,
              model,
              maxTokens,
              noComments,
              context,
              moduleFormat: requestedFormat,
              signal,
              attemptTimeoutMs: timeout,
            });
          };

          if (typeof task === 'string' && task.trim() !== '' && typeof code === 'string' && code.trim() !== '') {
            warnings.push('task took precedence over code (code ignored; use existingCode or existingPath to modify).');
          }
          if (Array.isArray(iterations) && iterations.length > MAX_ITERATIONS) {
            warnings.push(`iterations capped at ${MAX_ITERATIONS} (${iterations.length - MAX_ITERATIONS} dropped).`);
          }
          if (Array.isArray(iterations) && iterations.length > 0 && ((typeof task === 'string' && task.trim() !== '') || (typeof code === 'string' && code.trim() !== ''))) {
            warnings.push('iterations takes precedence; task/code ignored.');
          }

          let baseExisting = (typeof existingCode === 'string' && existingCode.trim() !== '') ? existingCode : null;
          if (!baseExisting && typeof existingPath === 'string' && existingPath.trim() !== '') {
            if (!caps.fs) {
              warnings.push('existingPath ignored: this runtime cannot read files.');
            } else {
              const source = readSourceFile(existingPath, caps, root);
              if (source === null) warnings.push(`existingPath could not be read: ${existingPath}`);
              else baseExisting = source;
            }
          }

          let finalCode = null;
          const useWave = Boolean(autoChunk) && typeof task === 'string' && task.trim() !== '' && !Array.isArray(iterations);
          if (useWave) {
            let current = baseExisting;
            let totalSteps = 0;
            let waveFailed = false;
            for (let wave = 0; wave < MAX_WAVES && totalSteps < MAX_WAVE_STEPS; wave++) {
              const steps = await planNextSteps({ env, options, task, currentCode: current, language: lang, context, signal });
              if (!Array.isArray(steps) || steps.length === 0) break;
              const capped = steps.slice(0, Math.min(MAX_WAVE_STEPS_PER_WAVE, MAX_WAVE_STEPS - totalSteps));
              for (const step of capped) {
                const trimmed = String(step || '').trim();
                if (!trimmed) {
                  iterLog.push({ index: totalSteps, ok: false, error: 'empty task' });
                  continue;
                }
                try {
                  const result = await callGenerate(trimmed, current);
                  current = result.code;
                  addUsage(result.usage);
                  iterLog.push({ index: totalSteps, task: trimmed, ok: true, wave });
                  totalSteps++;
                } catch (err) {
                  iterLog.push({ index: totalSteps, task: trimmed, ok: false, error: String((err && err.message) || err), wave });
                  waveFailed = true;
                  break;
                }
              }
              if (waveFailed) break;
            }
            finalCode = current;
            if (finalCode === null) {
              const lastError = iterLog.length ? (iterLog[iterLog.length - 1].error || 'No code generated') : 'No code generated';
              return { code: null, language: lang, moduleFormat: 'unknown', valid: false, error: lastError, note: null, iterations: iterLog, warnings, usage: totalUsage };
            }
          } else if (Array.isArray(iterations) && iterations.length > 0) {
            let current = baseExisting;
            const capped = iterations.slice(0, MAX_ITERATIONS);
            for (let i = 0; i < capped.length; i++) {
              const trimmed = String(capped[i] || '').trim();
              if (!trimmed) {
                iterLog.push({ index: i, ok: false, error: 'empty task' });
                continue;
              }
              try {
                const result = await callGenerate(trimmed, current);
                current = result.code;
                addUsage(result.usage);
                iterLog.push({ index: i, task: trimmed, ok: true });
              } catch (err) {
                iterLog.push({ index: i, task: trimmed, ok: false, error: String((err && err.message) || err) });
                break;
              }
            }
            finalCode = current;
            if (finalCode === null) {
              const lastError = iterLog.length ? (iterLog[iterLog.length - 1].error || 'No code generated') : 'No code generated';
              return { code: null, language: lang, moduleFormat: 'unknown', valid: false, error: lastError, note: null, iterations: iterLog, warnings, usage: totalUsage };
            }
          } else if (typeof code === 'string' && code.trim() !== '' && !(typeof task === 'string' && task.trim() !== '')) {
            finalCode = code;
          } else if (typeof task === 'string' && task.trim() !== '') {
            const result = await callGenerate(task, baseExisting);
            finalCode = result.code;
            addUsage(result.usage);
          } else if (typeof code === 'string' && code.trim() !== '') {
            finalCode = code;
          } else {
            throw new Error('Either task, code or iterations must be provided');
          }

          // ---- module format ----
          let moduleFormat = detectModuleFormat(finalCode);
          if (requestedFormat !== 'auto' && moduleFormat !== 'unknown' && moduleFormat !== requestedFormat) {
            try {
              const corrected = await callGenerate(
                `Rewrite the same code using the required module format (${requestedFormat}). Keep the behaviour identical.\n\nMODULE FORMAT:\n${MODULE_FORMAT_RULES[requestedFormat]}`,
                finalCode,
              );
              addUsage(corrected.usage);
              const correctedFormat = detectModuleFormat(corrected.code);
              if (correctedFormat === requestedFormat) {
                finalCode = corrected.code;
                moduleFormat = correctedFormat;
              }
            } catch (err) {
              warnings.push(`could not convert the generated code to module format "${requestedFormat}": ${String((err && err.message) || err)}`);
            }
          }
          if (requestedFormat !== 'auto' && moduleFormat !== requestedFormat && moduleFormat !== 'unknown') {
            warnings.push(`module format mismatch: requested "${requestedFormat}", generated "${moduleFormat}".`);
          }

          // ---- comment stripping ----
          if (noComments && typeof finalCode === 'string') {
            const stripped = stripComments(finalCode);
            const check = lang === 'javascript'
              ? validateJavaScript(stripped, caps)
              : validateTypeScript(stripped, false, tsc);
            if (check.valid === false) warnings.push('noComments stripping broke the syntax; the original code was kept.');
            else if (check.valid === null) {
              const original = lang === 'javascript'
                ? validateJavaScript(finalCode, caps)
                : validateTypeScript(finalCode, false, tsc);
              if (original.valid === false) warnings.push('noComments stripping could not be verified; the original code was kept.');
              else finalCode = stripped;
            } else finalCode = stripped;
          }

          const truncated = typeof finalCode === 'string' && finalCode.length > (maxTokens || DEFAULT_MAX_TOKENS) * 3;
          if (truncated) warnings.push('output may be truncated by maxTokens (hint, not a hard cap).');

          // ---- validation ----
          const validation = lang === 'javascript'
            ? validateJavaScript(finalCode, caps)
            : validateTypeScript(finalCode, Boolean(typeCheck), tsc);

          // ---- write ----
          let writtenTo = null;
          if (writePath && typeof finalCode === 'string') {
            if (validation.valid === false) {
              warnings.push('write skipped: the generated code is invalid.');
            } else if (!caps.fs) {
              warnings.push('write skipped: file writes are not supported in this runtime.');
            } else {
              try {
                writtenTo = writeFileSafe(writePath, finalCode, caps, root);
              } catch (err) {
                warnings.push('write failed: ' + String((err && err.message) || err));
              }
            }
          }

          return {
            code: finalCode,
            language: lang,
            moduleFormat,
            valid: validation.valid,
            error: validation.error,
            note: validation.note || null,
            iterations: iterLog,
            warnings,
            ...(writtenTo ? { writtenTo } : {}),
            usage: totalUsage,
          };
        },
      },
    ],
  };
}

module.exports = {
  createJsTsCodeProvider,
  // exported for tests
  detectModuleFormat,
  stripComments,
  validateJavaScript,
  validateTypeScript,
};
