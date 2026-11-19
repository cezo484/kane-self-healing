// Kane CLI runner: spawns kane-cli, captures its NDJSON stream, and turns
// it into a structured result the heal loop can act on.
//
// Kane CLI contract (kane-cli 0.10.x, --agent mode):
//   - stdout is NDJSON, one JSON event per line.
//   - Progress events have `step`, `status` (running|done|failed) and
//     `remark`, and no `type` field.
//   - Typed events have a `type`; the last one is `run_end` (for `run`) or
//     `test_md_done` (for `testmd run`).
//   - Exit codes: 0 pass, 1 fail, 2 did-not-start (auth/Chrome/URL), 3 timeout.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const KANE_EXIT = { PASS: 0, FAIL: 1, DID_NOT_START: 2, TIMEOUT: 3 };

// Where to look for a Chrome binary when CHROME_PATH is not set and Chrome
// is not on PATH. Kane CLI honors CHROME_PATH.
const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome-for-testing',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/meta-chromium/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Playwright's bundled Chromium, when present.
  const home = process.env.HOME || '';
  const pwDir = path.join(home, '.cache', 'ms-playwright');
  if (fs.existsSync(pwDir)) {
    for (const entry of fs.readdirSync(pwDir)) {
      if (!entry.startsWith('chromium-')) continue;
      const exe = path.join(pwDir, entry, 'chrome-linux64', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function kaneEnv(extra = {}) {
  const env = { ...process.env, KANE_CLI_USER_AGENT: 'tiny-shop-self-healing', ...extra };
  if (!env.CHROME_PATH) {
    const chrome = findChrome();
    if (chrome) env.CHROME_PATH = chrome;
  }
  return env;
}

function runCommand(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: kaneEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref();
    }
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 2, stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut: false, spawnError: err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 3 : (code ?? 2), stdout, stderr, timedOut, spawnError: null });
    });
  });
}

/**
 * Parse a kane-cli --agent NDJSON stream.
 * Returns { status, summary, reason, failedSteps, storedValues,
 *           creditsConsumed, testUrl, sessionDir, duration, rawEvents }.
 * status is 'passed' | 'failed' | 'unknown'.
 */
export function parseNdjson(text) {
  const events = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON lines (banners, warnings) are ignored.
    }
  }

  const failedSteps = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === undefined && ev.status === 'failed' && ev.step) {
      failedSteps.push({ step: ev.step, remark: ev.remark || '', status: ev.status });
    }
  }

  const terminal =
    [...events].reverse().find((e) => e && (e.type === 'run_end' || e.type === 'test_md_done')) || null;

  let status = 'unknown';
  let summary = '';
  let reason = '';
  let storedValues = {};
  let creditsConsumed = null;
  let testUrl = null;
  let sessionDir = null;
  let duration = null;

  if (terminal) {
    if (terminal.type === 'run_end') {
      status = terminal.status === 'passed' ? 'passed' : terminal.status === 'failed' ? 'failed' : 'unknown';
      summary = terminal.summary || terminal.one_liner || '';
      reason = terminal.reason || '';
      storedValues = terminal.final_state || {};
      creditsConsumed = terminal.credits_consumed ?? null;
      testUrl = terminal.test_url || null;
      sessionDir = terminal.session_dir || null;
      duration = terminal.duration ?? null;
    } else {
      // test_md_done
      status = terminal.overall_status === 'passed' ? 'passed' : terminal.overall_status === 'failed' ? 'failed' : 'unknown';
      summary = terminal.summary || '';
      sessionDir = terminal.session_id ? `session ${terminal.session_id}` : null;
      duration = terminal.duration_s ?? null;
    }
  }

  return {
    status, summary, reason, failedSteps, storedValues,
    creditsConsumed, testUrl, sessionDir, duration, rawEvents: events,
  };
}

/**
 * Run one Kane check. Options:
 *   mode: 'testmd' | 'run'
 *   flowPath: path to *_test.md (testmd mode)
 *   objective: inline objective string (run mode)
 *   url: start URL
 *   timeout: Kane-side timeout in seconds
 *   kaneCmd: binary to invoke (default 'kane-cli'; override for self-tests)
 *   extraArgs: extra CLI args
 */
export async function runKane({ mode = 'testmd', flowPath = null, objective = null, url, timeout = 300, kaneCmd = 'kane-cli', extraArgs = [] }) {
  const args = [];
  if (mode === 'testmd') {
    args.push('testmd', 'run', flowPath);
  } else {
    args.push('run', objective);
  }
  args.push('--agent', '--headless', '--url', url, '--timeout', String(timeout), ...extraArgs);

  // Give the shell-side kill a margin over Kane's own timeout so run_end
  // still arrives when Kane times out internally.
  const { exitCode, stdout, stderr, timedOut, spawnError } = await runCommand(
    kaneCmd, args, { timeoutMs: (timeout + 120) * 1000 },
  );

  const parsed = parseNdjson(stdout);
  // Exit code is authoritative; the parsed status is a second opinion.
  let outcome;
  if (exitCode === KANE_EXIT.PASS) outcome = 'passed';
  else if (exitCode === KANE_EXIT.FAIL) outcome = 'failed';
  else if (exitCode === KANE_EXIT.DID_NOT_START) outcome = 'did-not-start';
  else outcome = 'timeout';
  // If Kane exited 0 but the terminal event says failed (upload failure can
  // do this), trust the event.
  if (exitCode === KANE_EXIT.PASS && parsed.status === 'failed') outcome = 'failed';

  return {
    outcome,
    exitCode,
    timedOut,
    spawnError,
    ...parsed,
    rawStdout: stdout,
    rawStderr: stderr,
  };
}

/** Check Kane CLI auth without spending credits. Returns { ok, detail }. */
export function checkAuth(kaneCmd = 'kane-cli') {
  return new Promise((resolve) => {
    execFile(kaneCmd, ['whoami'], { env: kaneEnv(), timeout: 30000 }, (err, stdout) => {
      const out = String(stdout || '') + (err ? `\n${err.message}` : '');
      if (/Not logged in/i.test(out)) {
        resolve({ ok: false, detail: 'Not logged in. Run `kane-cli login --oauth`, or set LT_USERNAME and LT_ACCESS_KEY.' });
      } else if (err && !/Profile/i.test(out)) {
        resolve({ ok: false, detail: `kane-cli whoami failed: ${err.message}` });
      } else {
        resolve({ ok: true, detail: out.trim().split('\n').slice(0, 6).join(' ') });
      }
    });
  });
}
