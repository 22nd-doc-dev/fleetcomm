"use strict";
/* The endpoint rule, exercised directly — including against the address this
   build actually ships with.
   Both v0.10.x sign-in outages were failures of exactly this: nothing checked
   that the packaged endpoint could survive the client's own validation. The
   relay suites, the unit suites, lint, and the Electron boot test all passed
   while sign-in was completely dead, because the boot test disables Discord
   mode and never reached this code. */
const assert = require("assert");
const path = require("path");
const { accountBase, isInsecure, insecureNote } = require("../src/accounts-url");
const config = require("../config/22nd-package.json");

let n = 0; const ok = (m) => console.log("  ✓ " + m, ++n);

/* THE regression guard: whatever we ship must pass our own front door. */
assert.doesNotThrow(() => accountBase(config.accounts.url),
  "the packaged accounts URL must be accepted by the client's own validation");
ok("the shipped accounts endpoint passes validation (" + config.accounts.url + ")");

/* both schemes are usable; anything else is not */
assert.doesNotThrow(() => accountBase("https://example.org"));
assert.doesNotThrow(() => accountBase("http://68.183.103.215:8722"));
for (const bad of ["ftp://h/x", "file:///etc/passwd", "javascript:alert(1)", "", "not a url"])
  assert.throws(() => accountBase(bad), "must reject " + JSON.stringify(bad));
ok("http and https accepted; other schemes and junk rejected");

/* plaintext across a network is permitted but never silent */
assert(isInsecure("http://68.183.103.215:8722"), "remote http is flagged");
assert(/unencrypted/i.test(insecureNote("http://68.183.103.215:8722")), "and it says so plainly");
assert(!isInsecure("https://68.183.103.215"), "https is not flagged");
assert(!isInsecure("http://127.0.0.1:8722"), "loopback never leaves the machine");
assert(!isInsecure("http://localhost:8722"));
assert.strictEqual(insecureNote("https://example.org"), "", "nothing to say about https");
ok("plaintext to a remote host is permitted, flagged, and explained");

/* the shipped endpoint's own posture is reported truthfully either way */
const note = insecureNote(config.accounts.url);
ok(note ? "shipped endpoint correctly reports: " + note
        : "shipped endpoint is encrypted; no warning shown");

console.log("\n✔ ACCOUNTS URL PASS — what we ship can actually sign in, and plaintext is never silent");
process.exit(0);
