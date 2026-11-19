// Unit tests for the NDJSON parser and the rule-based fixer.
// Run: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNdjson } from '../loop/kane.js';
import { diagnose, applyPatches, collectHtmlIds, levenshtein, similarity } from '../loop/rules.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');

describe('parseNdjson', () => {
  it('parses a failing run_end with the failing step and remark', () => {
    const text = fs.readFileSync(path.join(TEST_DIR, 'sample-fail.ndjson'), 'utf8');
    const parsed = parseNdjson(text);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.summary, 'Checkout failed: Place order did nothing.');
    assert.equal(parsed.failedSteps.length, 1);
    assert.equal(parsed.failedSteps[0].step, 'Checkout');
    assert.match(parsed.failedSteps[0].remark, /Place order/);
    assert.equal(parsed.storedValues.cart_total, '$102.49');
    assert.equal(parsed.creditsConsumed, 12);
    assert.equal(parsed.testUrl, 'https://example.test/t/123');
  });

  it('parses a passing run_end with no failed steps', () => {
    const text = fs.readFileSync(path.join(TEST_DIR, 'sample-pass.ndjson'), 'utf8');
    const parsed = parseNdjson(text);
    assert.equal(parsed.status, 'passed');
    assert.equal(parsed.failedSteps.length, 0);
    assert.equal(parsed.summary, 'Checkout passed end to end.');
  });

  it('parses test_md_done as the terminal event', () => {
    const parsed = parseNdjson(
      '{"type":"stream_start"}\n' +
      '{"step":"Checkout","status":"failed","remark":"no confirmation"}\n' +
      '{"type":"test_md_done","overall_status":"failed","duration_s":42,"session_id":"s1","summary":"bad"}\n',
    );
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.summary, 'bad');
    assert.equal(parsed.failedSteps.length, 1);
  });

  it('returns unknown status when no terminal event exists', () => {
    const parsed = parseNdjson('{"step":"Open","status":"done","remark":"ok"}\nnot json at all\n');
    assert.equal(parsed.status, 'unknown');
    assert.equal(parsed.failedSteps.length, 0);
  });
});

describe('similarity', () => {
  it('scores identical strings at 1 and unrelated ones low', () => {
    assert.equal(similarity('abc', 'abc'), 1);
    assert.ok(similarity('checkout-form', 'checkout-form') > 0.99);
    assert.ok(similarity('order-form', 'checkout-form') < 0.6);
  });

  it('computes Levenshtein distances', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });
});

describe('rules: missing-element-id', () => {
  function makeApp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-rules-'));
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'checkout.html'),
      '<form id="checkout-form"><input id="field-name"></form>');
    fs.writeFileSync(path.join(dir, 'public', 'index.html'),
      '<button id="cart-button">Cart</button>');
    return dir;
  }

  it('fixes a form lookup that points at a nonexistent id', () => {
    const dir = makeApp();
    const js = path.join(dir, 'public', 'app.js');
    fs.writeFileSync(js,
      "const form = document.getElementById('order-form');\n" +
      "if (!form.reportValidity()) return;\n");
    const patches = diagnose(dir);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].rule, 'missing-element-id');
    assert.equal(patches[0].confidence, 'high');
    assert.match(patches[0].replace, /checkout-form/);
    const { applied, skipped } = applyPatches(patches);
    assert.equal(applied.length, 1);
    assert.equal(skipped.length, 0);
    assert.match(fs.readFileSync(js, 'utf8'), /checkout-form/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('proposes nothing when every referenced id exists', () => {
    const dir = makeApp();
    fs.writeFileSync(path.join(dir, 'public', 'app.js'),
      "const form = document.getElementById('checkout-form');\n" +
      "const btn = document.getElementById('cart-button');\n");
    assert.equal(diagnose(dir).length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to patch when the find string occurs more than once', () => {
    const dir = makeApp();
    const js = path.join(dir, 'public', 'app.js');
    fs.writeFileSync(js,
      "const a = document.getElementById('order-form');\n" +
      "const b = document.getElementById('order-form');\n" +
      "if (!a.reportValidity()) return;\n");
    const patches = diagnose(dir);
    assert.equal(patches.length, 1);
    const { applied, skipped } = applyPatches(patches);
    assert.equal(applied.length, 0);
    assert.equal(skipped.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('collects ids with their tag names from HTML', () => {
    const dir = makeApp();
    const ids = collectHtmlIds(dir);
    assert.equal(ids.get('checkout-form'), 'form');
    assert.equal(ids.get('cart-button'), 'button');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('repo files', () => {
  it('the shipped app.js references the real form id', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
    assert.match(src, /getElementById\('checkout-form'\)/);
    assert.doesNotMatch(src, /getElementById\('order-form'\)/);
  });

  it('the checkout flow file exists and ends every flow in an assertion', () => {
    const flow = fs.readFileSync(path.join(ROOT, 'flows', 'checkout_test.md'), 'utf8');
    assert.match(flow, /Verify the page shows "Order confirmed"/);
    assert.match(flow, /Verify the confirmation total matches/);
  });
});
