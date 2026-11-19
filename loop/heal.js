// Tiny Shop self-healing loop.
//
//   1. Start the app server (or reuse one already running on the port).
//   2. Run Kane CLI against the checkout flow in a real browser.
//   3. Pass: write the evidence report and stop.
//      Fail: diagnose the failure, patch the code (rules first, then LLM),
//      and run Kane again — up to --max-iterations.
//   4. Did-not-start (auth, Chrome, server): stop immediately with the fix;
//      there is no code bug to heal.
//
// Usage:
//   node loop/heal.js [--flow flows/checkout_test.md] [--mode testmd|run]
//                     [--max-iterations 5] [--port 3000] [--timeout 300]
//                     [--no-llm] [--no-rules] [--provider gemini|groq] [--keep-server]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runKane, checkAuth } from './kane.js';
import { diagnose, applyPatches } from './rules.js';
import { fixWithLlm, availableProviders } from './fixer.js';
import { writeIterationEvidence, writeHealReport, unifiedDiff } from './report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const EVIDENCE_DIR = path.join(ROOT, 'evidence');

const DEFAULT_OBJECTIVE =
  'Go to http://localhost:PORT_PLACEHOLDER and verify the product list shows at least 4 products. ' +
  'Add "Wireless Headphones" to the cart, then add "USB-C Cable" to the cart, and verify the cart shows 2 items. ' +
  "Store the displayed cart total as 'cart_total'. Click \"Checkout\", fill in the form with name \"Test User\", " +
  'email "test@example.com", address "123 Demo Street", card number "4242424242424242", expiry "12/30", CVC "123", ' +
  'and click "Place order". Verify the page shows "Order confirmed" and the confirmation total matches the stored cart total value.';

function loadDotEnv() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const opts = {
    flow: 'flows/checkout_test.md',
    mode: 'testmd',
    objective: null,
    maxIterations: 5,
    port: Number(process.env.PORT || 3000),
    timeout: 300,
    noLlm: false,
    noRules: false,
    provider: null,
    kaneCmd: process.env.KANE_CMD || 'kane-cli',
    keepServer: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--flow') opts.flow = next();
    else if (a === '--mode') opts.mode = next();
    else if (a === '--objective') opts.objective = next();
    else if (a === '--max-iterations') opts.maxIterations = Number(next());
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--timeout') opts.timeout = Number(next());
    else if (a === '--no-llm') opts.noLlm = true;
    else if (a === '--no-rules') opts.noRules = true;
    else if (a === '--provider') opts.provider = next();
    else if (a === '--kane-cmd') opts.kaneCmd = next();
    else if (a === '--keep-server') opts.keepServer = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node loop/heal.js [--flow <path>] [--mode testmd|run] [--objective <text>]');
      console.log('                     [--max-iterations N] [--port N] [--timeout N]');
      console.log('                     [--no-llm] [--no-rules] [--provider gemini|groq] [--kane-cmd <bin>] [--keep-server]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!['testmd', 'run'].includes(opts.mode)) {
    console.error(`--mode must be testmd or run, got "${opts.mode}"`);
    process.exit(2);
  }
  return opts;
}

function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status, body } = await httpGetJson(`http://localhost:${port}/api/health`);
      if (status === 200 && body && body.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startServer(port) {
  // Reuse a server that is already running on this port.
  try {
    const { status, body } = await httpGetJson(`http://localhost:${port}/api/health`);
    if (status === 200 && body && body.ok) return { child: null, reused: true };
  } catch {
    // Nothing listening; start our own.
  }
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const up = await waitForServer(port);
  if (!up) {
    child.kill('SIGKILL');
    return { child: null, reused: false, failed: true };
  }
  return { child, reused: false };
}

function collectFixFiles() {
  const files = [];
  const addFile = (relPath) => {
    const absPath = path.join(ROOT, relPath);
    if (fs.existsSync(absPath)) {
      files.push({ relPath, absPath, content: fs.readFileSync(absPath, 'utf8') });
    }
  };
  addFile('app/public/app.js');
  addFile('app/public/index.html');
  addFile('app/public/checkout.html');
  addFile('app/public/confirmation.html');
  addFile('app/server.js');
  return files;
}

function log(...args) {
  console.log(`[heal ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function main() {
  loadDotEnv();
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const report = {
    startedAt,
    finishedAt: null,
    outcome: null,
    flow: opts.mode === 'testmd' ? opts.flow : '(inline objective)',
    mode: opts.mode,
    maxIterations: opts.maxIterations,
    totalCredits: null,
    iterations: [],
  };
  let server = null;
  let exitCode = 0;

  try {
    log(`Tiny Shop self-healing loop — mode=${opts.mode}, max-iterations=${opts.maxIterations}`);
    const flowPath = path.join(ROOT, opts.flow);
    if (opts.mode === 'testmd' && !fs.existsSync(flowPath)) {
      console.error(`Flow file not found: ${flowPath}`);
      process.exit(2);
    }

    server = await startServer(opts.port);
    if (server.failed) {
      console.error(`Could not start the app server on port ${opts.port}. Is the port taken by something else?`);
      process.exit(2);
    }
    log(server.reused
      ? `Reusing the app server already running on port ${opts.port}.`
      : `App server started on http://localhost:${opts.port}`);

    // Auth preflight (skipped when a stub kane command is injected for tests).
    const usingRealKane = opts.kaneCmd === 'kane-cli';
    if (usingRealKane && !(process.env.LT_USERNAME && process.env.LT_ACCESS_KEY)) {
      const auth = await checkAuth(opts.kaneCmd);
      if (!auth.ok) {
        console.error(`Kane CLI is not signed in: ${auth.detail}`);
        console.error('Sign in once with `kane-cli login --oauth`, or set LT_USERNAME and LT_ACCESS_KEY.');
        console.error('Nothing ran and no credits were used.');
        process.exit(2);
      }
      log('Kane CLI signed in.');
    } else if (usingRealKane) {
      log('Using basic auth from LT_USERNAME / LT_ACCESS_KEY.');
    } else {
      log(`Using injected Kane command: ${opts.kaneCmd} (self-test mode)`);
    }

    const llmProviders = opts.noLlm ? [] : availableProviders();
    log(llmProviders.length > 0
      ? `LLM fixer available: ${llmProviders.map((p) => `${p.name}/${p.model}`).join(', ')}`
      : 'No LLM provider configured (rules only). Set GEMINI_API_KEY or GROQ_API_KEY to enable the LLM fixer.');

    const baseUrl = `http://localhost:${opts.port}`;
    const objective = (opts.objective || DEFAULT_OBJECTIVE).replaceAll('PORT_PLACEHOLDER', String(opts.port));
    let totalCredits = 0;
    let healed = false;

    for (let n = 1; n <= opts.maxIterations; n++) {
      log(`--- Iteration ${n}/${opts.maxIterations}: running Kane ---`);
      const result = await runKane({
        mode: opts.mode,
        flowPath,
        objective,
        url: baseUrl,
        timeout: opts.timeout,
        kaneCmd: opts.kaneCmd,
      });
      const parsed = writeIterationEvidence(EVIDENCE_DIR, n, result);
      if (typeof result.creditsConsumed === 'number') totalCredits += result.creditsConsumed;

      const iteration = { n, outcome: result.outcome, kane: parsed, fix: null };
      report.iterations.push(iteration);

      if (result.outcome === 'passed') {
        log(`PASS: ${result.summary || 'flow passed'}`);
        if (result.testUrl) log(`Test Manager: ${result.testUrl}`);
        healed = true;
        break;
      }
      if (result.outcome === 'did-not-start' || result.outcome === 'timeout') {
        log(`Kane did not complete (outcome: ${result.outcome}, exit ${result.exitCode}).`);
        if (result.spawnError) log(`Spawn error: ${result.spawnError}`);
        const stderrTail = (result.rawStderr || '').trim().split('\n').slice(-5).join('\n');
        if (stderrTail) log(`Kane stderr:\n${stderrTail}`);
        log('This is an environment problem, not a code bug. Stopping without patching.');
        break;
      }

      // Failed: diagnose and fix.
      log(`FAIL: ${result.summary || 'flow failed'}`);
      for (const s of result.failedSteps) log(`  failing step — ${s.step}: ${s.remark}`);
      const failure = {
        summary: result.summary,
        reason: result.reason,
        failedSteps: result.failedSteps,
      };

      // 1. Rule-based fixer.
      const patches = opts.noRules ? [] : diagnose(APP_DIR, failure);
      if (patches.length > 0) {
        const before = new Map(patches.map((p) => [p.file, fs.readFileSync(p.file, 'utf8')]));
        const { applied, skipped } = applyPatches(patches);
        for (const s of skipped) log(`  rule skipped (${s.rule}): ${s.reason}`);
        if (applied.length > 0) {
          const diffs = applied.map((p) => {
            const rel = path.relative(ROOT, p.file);
            return unifiedDiff(rel, before.get(p.file), fs.readFileSync(p.file, 'utf8'));
          }).join('\n');
          iteration.fix = {
            via: 'rules',
            provider: null,
            model: null,
            explanation: applied.map((p) => p.explanation).join(' '),
            diff: diffs,
          };
          log(`  rule fix applied (${applied.map((p) => p.rule).join(', ')}): ${iteration.fix.explanation}`);
          continue;
        }
      } else {
        log(opts.noRules ? '  rules skipped (--no-rules).' : '  no rule-based patch applies.');
      }

      // 2. LLM fixer.
      if (opts.noLlm || llmProviders.length === 0) {
        log('  LLM fixer unavailable; cannot fix this failure.');
        break;
      }
      log('  asking the LLM fixer…');
      try {
        const fix = await fixWithLlm({ failure, files: collectFixFiles(), providerName: opts.provider });
        const before = fs.readFileSync(fix.absPath, 'utf8');
        fs.writeFileSync(fix.absPath, fix.content);
        iteration.fix = {
          via: 'llm',
          provider: fix.provider,
          model: fix.model,
          explanation: fix.explanation || `Patched ${fix.file}.`,
          diff: unifiedDiff(fix.file, before, fix.content),
        };
        log(`  LLM fix applied (${fix.provider}/${fix.model}): ${iteration.fix.explanation}`);
      } catch (err) {
        log(`  LLM fixer failed: ${err.message}`);
        break;
      }
    }

    report.finishedAt = new Date().toISOString();
    report.totalCredits = totalCredits;
    if (healed) {
      report.outcome = 'healed';
      log(`HEALED after ${report.iterations.length} iteration(s). Evidence in ${EVIDENCE_DIR}`);
    } else if (report.iterations.some((it) => it.outcome === 'did-not-start' || it.outcome === 'timeout')) {
      report.outcome = 'did-not-start';
      exitCode = 2;
    } else {
      report.outcome = 'not-healed';
      log(`NOT HEALED after ${report.iterations.length} iteration(s). See ${EVIDENCE_DIR}/heal-report.md`);
      exitCode = 1;
    }
    writeHealReport(EVIDENCE_DIR, report);
  } finally {
    if (server && server.child && !opts.keepServer) {
      server.child.kill('SIGTERM');
    } else if (server && server.child && opts.keepServer) {
      log(`Server left running on http://localhost:${opts.port} (--keep-server). Stop it with Ctrl+C.`);
      // Keep the process alive so the server stays up.
      await new Promise(() => {});
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
