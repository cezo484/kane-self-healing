# Tiny Shop — a self-healing web app (Kane CLI Hackathon)

An agent builds a web app. Kane CLI checks it in a real browser. When Kane
finds a bug, the loop fixes the code and runs Kane again — until green.
This repo is that loop, working end to end on a small demo store.

Built for the [Kane CLI Hackathon](http://kaneclihack.sh) (TestMu AI).
Deadline: 26 November 2026, 11:59 PM IST.

## The demo in 30 seconds

```bash
npm run demo
```

1. A real bug is seeded into the checkout code: the "Place order" handler
   looks up a form id that does not exist, so clicking the button does
   nothing.
2. Kane CLI runs the checkout flow in a real browser and **fails** — the
   confirmation page never appears.
3. The loop reads the failing step, patches the code, and re-runs Kane.
4. Kane **passes**. The full trail (Kane logs, patch diff, credits used)
   is in `evidence/heal-report.md`.

Nothing is faked: the bug is real code, the failure is a real Kane verdict,
and the fix is a real patch. Re-run the demo any time; it seeds the bug
fresh on each run.

## What is in here

| Path | What it is |
|---|---|
| `app/` | Tiny Shop: a demo store (product list, cart, checkout form, order confirmation) with a zero-dependency Node server. No real payments. |
| `flows/checkout_test.md` | The Kane flow in plain English: add two products, check the total, fill the demo form, place the order, verify the confirmation and its total. |
| `loop/heal.js` | The self-healing loop: start the server, run Kane, diagnose, patch, repeat (max 5 iterations). |
| `loop/kane.js` | Kane CLI runner: spawns `kane-cli`, parses its NDJSON stream (exit codes, `run_end` / `test_md_done`, failing steps with remarks). |
| `loop/rules.js` | Rule-based fixer: deterministic patches for provable bug classes (a JS reference to an element id no HTML file defines; a fetch to an API path the server never handles). Runs first; free and fast. |
| `loop/fixer.js` | LLM fixer: sends the Kane failure report plus the app sources to Gemini or Groq (OpenAI-compatible endpoints) and applies the returned patch after a syntax check. Runs only when no rule applies. |
| `loop/report.js` | Evidence writer: raw Kane NDJSON per iteration, parsed results, patch diffs, and the human-readable `evidence/heal-report.md`. |
| `scripts/seed-bug.js` | Installs the demo bug. `scripts/reset-bug.js` undoes it. |
| `test/` | Unit tests (`npm test`) plus a Kane test double for harness self-tests (see below). |

## How the loop works

```
seed bug ──▶ Kane run ──▶ PASS? ──yes──▶ report + stop
                │  ▲          no
                │  │           ▼
                │  │     failure report (failing step + remark)
                │  │           ▼
                │  │     rule fixer ──▶ patch? ──▶ re-run Kane
                │  │           │ no
                │  │           ▼
                │  └──── LLM fixer ──▶ patch ──▶ re-run Kane
                │
                └── after 5 iterations without a pass: stop, report
```

- **Kane is the only judge of "fixed".** A patch counts only when the next
  Kane run passes. The loop never edits the flow or weakens a check to get
  a pass.
- **Did-not-start is not a bug.** If Kane exits 2 (not signed in, no
  Chrome, no start URL) or 3 (timeout), the loop stops immediately with
  the fix instead of patching code.
- **The server never restarts between iterations.** It serves files from
  disk on every request with `no-store`, so a patch is live for the next
  Kane run at once.

## Setup

Requirements: Node.js 18+, Chrome (any install; the loop also honors
`CHROME_PATH`), and a TestMu AI account.

```bash
npm install -g @testmuai/kane-cli   # Kane CLI
kane-cli login --oauth              # sign in once in your browser
kane-cli whoami                     # verify
kane-cli balance                    # 10,000 free credits for new accounts
```

Then, in this repo:

```bash
cp .env.example .env   # optional: only needed for the LLM fixer
```

| Variable | What it is for |
|---|---|
| `GEMINI_API_KEY` | LLM fixer via Gemini (OpenAI-compatible endpoint). Optional; the rules fix the demo bug on their own. |
| `GROQ_API_KEY` | LLM fixer via Groq. Same role; Gemini is tried first when both are set. |
| `LT_USERNAME` / `LT_ACCESS_KEY` | Basic auth for Kane CLI (from the TestMu dashboard > Credentials). Only needed where OAuth cannot open a browser, e.g. CI. |
| `PORT` | App server port (default 3000). |

No key is ever committed: `.env` is gitignored, and the fixer reads keys
from the environment only.

## Running it

```bash
npm run demo        # seed the bug + run the loop (the red-to-green story)
npm run heal        # run the loop on the current code (no seeding)
npm run heal -- --mode run        # same flow as an inline objective instead of the testmd file
npm run heal -- --no-llm          # rules only
npm run heal -- --no-rules        # LLM fixer only (needs GEMINI_API_KEY or GROQ_API_KEY)
npm run heal -- --keep-server     # leave the app running after the loop, for a manual look
npm start           # just the shop, at http://localhost:3000
npm test            # unit tests for the parser and the rule fixer
```

Exit codes: `0` healed (Kane green), `1` not healed within the iteration
cap, `2` did not start (auth, Chrome, or server problem — see the message).

## The seeded bug

`scripts/seed-bug.js` changes one line in `app/public/app.js`: the checkout
handler looks up `getElementById('order-form')` instead of
`getElementById('checkout-form')`. The form lookup returns `null`,
`form.reportValidity()` throws, and "Place order" silently does nothing.
The shop otherwise works fine — products load, the cart updates, totals are
right — so only an end-to-end run through checkout catches it.

The rule fixer finds it without knowing the seed: it scans the JS for
element ids, finds one no HTML file defines, sees it is used as a form, and
matches it to the only `<form>` id in the HTML. The LLM fixer finds it from
the Kane failure report alone.

## Evidence

Every heal run writes to `evidence/` (gitignored except the folder itself):

- `evidence/heal-report.md` — the readable trail: iterations, Kane
  summaries, failing steps, applied patches as diffs, credits used.
- `evidence/heal-report.json` — the same, machine-readable.
- `evidence/runs/iter-NN.ndjson` — the raw Kane NDJSON per iteration.
- `evidence/runs/iter-NN.json` — the parsed result per iteration.

Kane also seals its own evidence pack (per-step screenshots, network and
console logs) per run; the Test Manager link is printed in the console and
recorded in the report when the upload succeeds.

## Harness self-tests (no TestMu account needed)

`test/stub-kane.sh` is a test double for `kane-cli`: it emits the same
NDJSON shapes (a failing run when the seeded bug is present, a passing run
when it is not). It exists only to test the loop harness without spending
credits, and is never used in a real run:

```bash
KANE_CMD=./test/stub-kane.sh node scripts/demo.js
```

Unit tests cover the NDJSON parser (pass, fail, `test_md_done`, missing
terminal event), the similarity scoring, and the rule fixer (fix, no-op,
ambiguous-patch refusal).

## For the judges

- **Ships:** `npm start` serves a real store; `npm run demo` runs the
  whole red-to-green story with no manual steps beyond Kane sign-in.
- **Verified:** Kane caught a real defect (a dead checkout button) that no
  static check in this repo would find, and proved the fix with a green
  run. The failing step and its remark are in the evidence report.
- **Closed loop:** Kane's NDJSON output feeds the fixer directly — the
  failing step and remark become the diagnosis input, and the patch is
  verified by the next Kane run. No human in the loop.
- **Craft:** zero runtime dependencies, plain Node, small files, every
  decision documented. `npm test` passes; the loop refuses to patch when
  its evidence is ambiguous and refuses to call a did-not-start a failure.

## Demo video & launch posts

- Demo video (3:32): https://youtu.be/WhAYTFpNXUU
- X post: https://x.com/melisim001/status/2123400146029339116
- Reddit post: https://www.reddit.com/user/cezo484/comments/1y08qp2/i_built_a_demo_store_that_heals_itself_kane_cli/

## License

MIT.
