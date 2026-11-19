// LLM fixer: when the rule-based fixer has no patch, ask an LLM to fix
// the bug. The model gets the Kane failure report plus the app sources
// and must return ONE corrected file as JSON. Keys come from the
// environment only; nothing is ever hardcoded or logged.
//
// Providers (both OpenAI-compatible chat completions, plain fetch):
//   - Gemini: GEMINI_API_KEY (endpoint .../v1beta/openai, default model
//     gemini-3.1-flash-lite, override with GEMINI_MODEL)
//   - Groq:   GROQ_API_KEY (endpoint api.groq.com/openai/v1, default
//     model llama-3.3-70b-versatile, override with GROQ_MODEL)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const PROVIDERS = {
  gemini: {
    envKey: 'GEMINI_API_KEY',
    envModel: 'GEMINI_MODEL',
    defaultModel: 'gemini-3.1-flash-lite',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
  groq: {
    envKey: 'GROQ_API_KEY',
    envModel: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
    url: 'https://api.groq.com/openai/v1/chat/completions',
  },
};

export function availableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => process.env[p.envKey])
    .map(([name, p]) => ({ name, model: process.env[p.envModel] || p.defaultModel }));
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in model reply');
  return JSON.parse(candidate.slice(start, end + 1));
}

function checkJsSyntax(filePath, content) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `heal-check-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(tmp, content);
    execFile(process.execPath, ['--check', tmp], (err) => {
      fs.rmSync(tmp, { force: true });
      resolve(err ? err.message.trim().split('\n')[0] : null);
    });
  });
}

function buildPrompt(failure, files, previousError) {
  const fileBlocks = files
    .map((f) => `--- ${f.relPath} ---\n${f.content}`)
    .join('\n\n');
  const failedSteps = (failure.failedSteps || [])
    .map((s) => `- step "${s.step}": ${s.remark}`)
    .join('\n') || '(no failing step recorded)';
  return [
    'You are fixing a bug in a small demo web shop (Tiny Shop). A browser test run with Kane CLI failed.',
    '',
    '## Kane failure',
    `Summary: ${failure.summary || '(none)'}`,
    failure.reason ? `Reason: ${failure.reason}` : '',
    'Failing steps:',
    failedSteps,
    '',
    '## Rules',
    '- Fix the root cause in the app source. Do not change the test or weaken any check.',
    '- Return exactly ONE file: the single file that needs to change, with its FULL corrected content.',
    '- Keep every other part of the file unchanged, including all comments and formatting. Do not add features.',
    '- Reply with JSON only, no prose: {"file": "<relative path>", "content": "<full file content>", "explanation": "<one or two sentences>"}',
    previousError ? `\n## Previous attempt failed\n${previousError}\nFix the problem and try again.` : '',
    '',
    '## App sources',
    fileBlocks,
  ].filter(Boolean).join('\n');
}

async function callChat(provider, model, prompt) {
  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env[provider.envKey]}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 6000,
      messages: [
        { role: 'system', content: 'You fix bugs in small web apps. You reply with JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM call failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM returned an empty reply');
  return text;
}

/**
 * Ask the LLM to fix the failure. `files` is [{ relPath, absPath, content }].
 * Returns { file, content, explanation, provider, model } on success.
 * Throws on failure (caller decides whether to retry or give up).
 */
export async function fixWithLlm({ failure, files, providerName = null }) {
  const available = availableProviders();
  if (available.length === 0) {
    throw new Error('No LLM provider configured. Set GEMINI_API_KEY or GROQ_API_KEY, or run with --no-llm for rules only.');
  }
  const chosen = providerName
    ? available.find((p) => p.name === providerName)
    : available[0];
  if (!chosen) throw new Error(`Provider "${providerName}" is not configured (no API key in env).`);
  const provider = PROVIDERS[chosen.name];

  let previousError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await callChat(provider, chosen.model, buildPrompt(failure, files, previousError));
    let parsed;
    try {
      parsed = extractJson(reply);
    } catch (e) {
      previousError = `Could not parse your reply as JSON: ${e.message}. Reply with JSON only.`;
      continue;
    }
    if (!parsed.file || typeof parsed.content !== 'string') {
      previousError = 'Your reply lacked "file" and "content" fields. Reply with JSON only: {"file": "...", "content": "...", "explanation": "..."}.';
      continue;
    }
    const target = files.find((f) => f.relPath === parsed.file || f.absPath.endsWith(parsed.file));
    if (!target) {
      previousError = `File "${parsed.file}" is not one of the provided sources. Fix one of: ${files.map((f) => f.relPath).join(', ')}.`;
      continue;
    }
    if (parsed.content === target.content) {
      previousError = 'Your "content" is identical to the current file. Change something.';
      continue;
    }
    if (target.relPath.endsWith('.js')) {
      const syntaxError = await checkJsSyntax(target.absPath, parsed.content);
      if (syntaxError) {
        previousError = `The corrected file has a syntax error: ${syntaxError}`;
        continue;
      }
    }
    return {
      file: target.relPath,
      absPath: target.absPath,
      content: parsed.content,
      explanation: parsed.explanation || '',
      provider: chosen.name,
      model: chosen.model,
    };
  }
  throw new Error(`LLM fixer failed after 2 attempts. Last error: ${previousError}`);
}
