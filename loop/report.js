// Evidence writer: every heal run leaves a full audit trail under
// evidence/ — raw Kane NDJSON per iteration, parsed results, applied
// patches (as unified diffs), and a human-readable report.
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Minimal unified diff for two versions of one file (line based, with
// 3 lines of context around each change, like `git diff`).
export function unifiedDiff(relPath, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  // LCS table.
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Edit script: ops of { type: ' ' | '-' | '+', aLine, bLine, text }.
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      ops.push({ type: ' ', aLine: i + 1, bLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ type: '+', aLine: null, bLine: j + 1, text: b[j] });
      j++;
    } else {
      ops.push({ type: '-', aLine: i + 1, bLine: null, text: a[i] });
      i++;
    }
  }
  // Group into hunks: a change plus 3 context lines on each side.
  const CONTEXT = 3;
  const changed = ops.map((op, idx) => (op.type !== ' ' ? idx : -1)).filter((x) => x >= 0);
  if (changed.length === 0) return `--- a/${relPath}\n+++ b/${relPath}\n(no changes)`;
  const hunks = [];
  let start = Math.max(0, changed[0] - CONTEXT);
  let end = Math.min(ops.length, changed[0] + CONTEXT + 1);
  for (let k = 1; k < changed.length; k++) {
    const c = changed[k];
    if (c - CONTEXT <= end) {
      end = Math.min(ops.length, c + CONTEXT + 1);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, c - CONTEXT);
      end = Math.min(ops.length, c + CONTEXT + 1);
    }
  }
  hunks.push([start, end]);

  const lines = [`--- a/${relPath}`, `+++ b/${relPath}`];
  for (const [hs, he] of hunks) {
    const slice = ops.slice(hs, he);
    const aStart = slice.find((op) => op.aLine !== null)?.aLine ?? 1;
    const bStart = slice.find((op) => op.bLine !== null)?.bLine ?? 1;
    const aCount = slice.filter((op) => op.type !== '+').length;
    const bCount = slice.filter((op) => op.type !== '-').length;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) lines.push(op.type + op.text);
  }
  return lines.join('\n');
}

export function writeIterationEvidence(evidenceDir, iteration, kaneResult) {
  const runsDir = path.join(evidenceDir, 'runs');
  ensureDir(runsDir);
  const base = `iter-${String(iteration).padStart(2, '0')}`;
  fs.writeFileSync(path.join(runsDir, `${base}.ndjson`), kaneResult.rawStdout || '');
  if (kaneResult.rawStderr) {
    fs.writeFileSync(path.join(runsDir, `${base}.stderr.log`), kaneResult.rawStderr);
  }
  const parsed = {
    iteration,
    outcome: kaneResult.outcome,
    exitCode: kaneResult.exitCode,
    status: kaneResult.status,
    summary: kaneResult.summary,
    reason: kaneResult.reason,
    failedSteps: kaneResult.failedSteps,
    storedValues: kaneResult.storedValues,
    creditsConsumed: kaneResult.creditsConsumed,
    testUrl: kaneResult.testUrl,
    sessionDir: kaneResult.sessionDir,
    duration: kaneResult.duration,
  };
  fs.writeFileSync(path.join(runsDir, `${base}.json`), JSON.stringify(parsed, null, 2));
  return parsed;
}

export function writeHealReport(evidenceDir, report) {
  ensureDir(evidenceDir);
  fs.writeFileSync(path.join(evidenceDir, 'heal-report.json'), JSON.stringify(report, null, 2));

  const lines = [];
  lines.push('# Tiny Shop heal report');
  lines.push('');
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Finished: ${report.finishedAt}`);
  lines.push(`- Outcome: **${report.outcome}**`);
  lines.push(`- Flow: ${report.flow} (mode: ${report.mode})`);
  lines.push(`- Iterations: ${report.iterations.length} (max ${report.maxIterations})`);
  if (report.totalCredits !== null && report.totalCredits !== undefined) {
    lines.push(`- Kane credits used: ${report.totalCredits}`);
  }
  lines.push('');
  for (const it of report.iterations) {
    lines.push(`## Iteration ${it.n} — ${it.outcome}`);
    lines.push('');
    if (it.kane.summary) lines.push(`Kane: ${it.kane.summary}`);
    if (it.kane.testUrl) lines.push(`Test Manager: ${it.kane.testUrl}`);
    if (it.kane.failedSteps && it.kane.failedSteps.length > 0) {
      lines.push('');
      lines.push('Failing steps:');
      for (const s of it.kane.failedSteps) lines.push(`- ${s.step}: ${s.remark}`);
    }
    if (it.fix) {
      lines.push('');
      lines.push(`Fix (${it.fix.via}${it.fix.provider ? `, ${it.fix.provider}/${it.fix.model}` : ''}): ${it.fix.explanation}`);
      if (it.fix.diff) {
        lines.push('');
        lines.push('```diff');
        lines.push(it.fix.diff);
        lines.push('```');
      }
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(evidenceDir, 'heal-report.md'), lines.join('\n'));
}
