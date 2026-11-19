// Install the demo bug: the checkout handler looks up a form id that does
// not exist ("order-form" instead of "checkout-form"). The form lookup
// returns null, form.reportValidity() throws, and clicking "Place order"
// does nothing. This is a real defect in real code — the Kane run fails
// on it, and the heal loop must find and fix it.
//
// Run: node scripts/seed-bug.js   (undo with: node scripts/reset-bug.js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'app', 'public', 'app.js');
const BACKUP = path.join(ROOT, 'app', 'public', '.app.js.fixed');

const FIXED = "document.getElementById('checkout-form')";
const BUGGY = "document.getElementById('order-form')";

const src = fs.readFileSync(TARGET, 'utf8');
if (src.includes(BUGGY) && !src.includes(FIXED)) {
  console.log('Bug is already seeded.');
  process.exit(0);
}
if (!src.includes(FIXED)) {
  console.error('Expected the fixed lookup in app.js but did not find it. Is the file already modified?');
  process.exit(1);
}
// Keep a pristine copy of the fixed file so reset works without git.
if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, src);
fs.writeFileSync(TARGET, src.replace(FIXED, BUGGY));
console.log('Bug seeded: checkout now looks up getElementById(\'order-form\'), which does not exist.');
console.log('Run `node scripts/demo.js` to watch the loop heal it, or `node scripts/reset-bug.js` to undo.');
