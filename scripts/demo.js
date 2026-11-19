// Full red-to-green demo in one command:
//   1. seed the checkout bug,
//   2. run the heal loop (Kane fails, the loop patches, Kane passes),
//   3. print the result and where the evidence lives.
// Any arguments are passed through to loop/heal.js.
// Requires Kane CLI auth (see README). For a no-credit dry run of the
// harness itself, use: KANE_CMD=./test/stub-kane.sh node scripts/demo.js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(nodeArgs, label) {
  console.log(`\n=== ${label} ===\n`);
  const res = spawnSync(process.execPath, nodeArgs, { cwd: ROOT, stdio: 'inherit', env: process.env });
  return res.status ?? 1;
}

const seedStatus = run(['scripts/seed-bug.js'], 'Seeding the demo bug');
if (seedStatus !== 0) process.exit(seedStatus);

const healStatus = run(['loop/heal.js', ...process.argv.slice(2)], 'Running the heal loop');
console.log('');
// Clean up the seed backup: after a successful heal the app is fixed again,
// so the pristine copy is no longer needed. If healing failed, the backup
// stays so `npm run reset` can still restore the fixed file.
if (healStatus === 0) {
  try {
    const backup = path.join(ROOT, 'app', 'public', '.app.js.fixed');
    const target = path.join(ROOT, 'app', 'public', 'app.js');
    if (fs.existsSync(backup) && fs.existsSync(target) &&
        fs.readFileSync(backup, 'utf8') === fs.readFileSync(target, 'utf8')) {
      fs.rmSync(backup);
    }
  } catch { /* backup cleanup is best-effort */ }
}
if (healStatus === 0) {
  console.log('Demo complete: the bug was seeded, Kane caught it, the loop fixed it, Kane passed.');
  console.log('Evidence: evidence/heal-report.md + evidence/runs/');
} else {
  console.log(`Demo ended with exit code ${healStatus}. See evidence/heal-report.md for the trail.`);
}
process.exit(healStatus);
