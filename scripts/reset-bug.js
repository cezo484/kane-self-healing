// Undo scripts/seed-bug.js: restore the fixed app.js from the pristine
// backup the seed script saved (or from git when the backup is missing).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'app', 'public', 'app.js');
const BACKUP = path.join(ROOT, 'app', 'public', '.app.js.fixed');

if (fs.existsSync(BACKUP)) {
  fs.writeFileSync(TARGET, fs.readFileSync(BACKUP, 'utf8'));
  fs.rmSync(BACKUP);
  console.log('Bug removed: app.js restored from the saved fixed copy.');
  process.exit(0);
}
try {
  execFileSync('git', ['checkout', '--', 'app/public/app.js'], { cwd: ROOT, stdio: 'ignore' });
  console.log('Bug removed: app.js restored from git.');
} catch {
  console.error('No backup and no git checkout available. Restore app.js by hand:');
  console.error("  replace getElementById('order-form') with getElementById('checkout-form')");
  process.exit(1);
}
