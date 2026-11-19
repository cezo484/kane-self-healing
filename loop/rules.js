// Rule-based fixer: deterministic patches for bug classes that can be
// proven from the source alone. Rules run before the LLM fixer: they are
// fast, free, and never guess.
//
// Rule 1 — missing-element-id: client JS references an element id
// (getElementById / querySelector) that no HTML file defines. The fix
// is the id the author meant:
//   a) if the reference is used as a form (reportValidity/submit/reset
//      nearby) and exactly one <form id="..."> exists, that id wins;
//   b) otherwise the closest existing id by normalized edit distance,
//      accepted only when similarity is 0.6 or better.
// Rule 2 — unknown-api-path: client JS fetches an /api/... path the
// server never handles. The fix is the closest server route, accepted
// only when similarity is 0.6 or better.
//
// Both rules refuse to patch when the evidence is ambiguous; the LLM
// fixer then takes the case.
import fs from 'node:fs';
import path from 'node:path';

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function listFiles(dir, exts) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// id -> tag name, from every HTML file under the app dir.
export function collectHtmlIds(appDir) {
  const ids = new Map();
  for (const file of listFiles(appDir, ['.html'])) {
    const html = fs.readFileSync(file, 'utf8');
    const re = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bid=["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(html)) !== null) ids.set(m[2], m[1].toLowerCase());
  }
  return ids;
}

// '/api/...' paths the server handles (string literals in server code).
function collectServerRoutes(appDir) {
  const routes = new Set();
  const serverFile = path.join(appDir, 'server.js');
  if (!fs.existsSync(serverFile)) return routes;
  const src = fs.readFileSync(serverFile, 'utf8');
  const re = /['"`](\/api\/[A-Za-z0-9_/${}.-]*)['"`]/g;
  let m;
  while ((m = re.exec(src)) !== null) routes.add(m[1].replace(/\/:[^/]+/g, ''));
  return routes;
}

const FORM_METHODS = ['reportValidity', 'checkValidity', '.submit(', '.reset(', '.requestSubmit('];

function usedAsForm(jsSrc, refIndex) {
  const window = jsSrc.slice(refIndex, refIndex + 800);
  return FORM_METHODS.some((m) => window.includes(m));
}

/**
 * Diagnose the app sources and return candidate patches.
 * Each patch: { file, find, replace, rule, confidence, explanation }.
 * `failure` is the Kane failure report (used only for logging context).
 */
export function diagnose(appDir, failure = null) {
  const patches = [];
  const htmlIds = collectHtmlIds(appDir);
  const jsFiles = listFiles(path.join(appDir, 'public'), ['.js']);
  const serverRoutes = collectServerRoutes(appDir);

  for (const jsFile of jsFiles) {
    const src = fs.readFileSync(jsFile, 'utf8');

    // Rule 1: getElementById('x') / querySelector('#x') with no such id.
    const refRe = /(?:getElementById\(\s*['"]([^'"]+)['"]\)|querySelector\(\s*['"]#([A-Za-z0-9_-]+)['"]\))/g;
    let m;
    const seen = new Set();
    while ((m = refRe.exec(src)) !== null) {
      const id = m[1] || m[2];
      if (htmlIds.has(id) || seen.has(id)) continue;
      seen.add(id);

      let replacement = null;
      let confidence = null;
      let explanation = '';

      if (usedAsForm(src, m.index)) {
        const forms = [...htmlIds.entries()].filter(([, tag]) => tag === 'form').map(([x]) => x);
        if (forms.length === 1) {
          replacement = forms[0];
          confidence = 'high';
          explanation = `getElementById('${id}') is used as a form but no element has id "${id}". The only <form> id in the HTML is "${forms[0]}".`;
        }
      }
      if (!replacement) {
        let best = null;
        let bestScore = 0;
        for (const existing of htmlIds.keys()) {
          const score = similarity(id, existing);
          if (score > bestScore) { bestScore = score; best = existing; }
        }
        if (best && bestScore >= 0.6) {
          replacement = best;
          confidence = 'medium';
          explanation = `No element has id "${id}"; closest existing id is "${best}" (similarity ${bestScore.toFixed(2)}).`;
        }
      }
      if (replacement) {
        patches.push({
          file: jsFile,
          find: m[0],
          replace: m[0].replace(id, replacement),
          rule: 'missing-element-id',
          confidence,
          explanation,
        });
      }
    }

    // Rule 2: fetch('/api/...') to a path the server never handles.
    const fetchRe = /fetch\(\s*['"`](\/api\/[^'"`]+)['"`]/g;
    const seenPaths = new Set();
    while ((m = fetchRe.exec(src)) !== null) {
      const route = m[1].split('?')[0];
      if (seenPaths.has(route)) continue;
      seenPaths.add(route);
      const handled = [...serverRoutes].some((r) => route === r || route.startsWith(r + '/'));
      if (handled) continue;
      let best = null;
      let bestScore = 0;
      for (const existing of serverRoutes) {
        const score = similarity(route, existing);
        if (score > bestScore) { bestScore = score; best = existing; }
      }
      if (best && bestScore >= 0.6) {
        patches.push({
          file: jsFile,
          find: m[0],
          replace: m[0].replace(route, best),
          rule: 'unknown-api-path',
          confidence: 'medium',
          explanation: `Client fetches "${route}" but the server has no such route; closest is "${best}" (similarity ${bestScore.toFixed(2)}).`,
        });
      }
    }
  }

  return patches;
}

/**
 * Apply patches to disk. A patch applies only when its `find` string
 * occurs exactly once in the file; otherwise it is skipped and reported.
 * Returns { applied, skipped }.
 */
export function applyPatches(patches) {
  const applied = [];
  const skipped = [];
  for (const patch of patches) {
    const src = fs.readFileSync(patch.file, 'utf8');
    const occurrences = src.split(patch.find).length - 1;
    if (occurrences !== 1) {
      skipped.push({ ...patch, reason: `find string occurs ${occurrences} times, expected exactly 1` });
      continue;
    }
    fs.writeFileSync(patch.file, src.replace(patch.find, patch.replace));
    applied.push(patch);
  }
  return { applied, skipped };
}
