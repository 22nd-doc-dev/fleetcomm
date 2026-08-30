"use strict";
const assert = require("assert");
const { RadioStack } = require("../src/radio-stack");

function fakeClient() {
  const channels = new Map([
    [0, { channelId: 0, name: "Root", parent: null }],
    [10, { channelId: 10, name: "ORG", parent: 0 }],
    [11, { channelId: 11, name: "ALPHA", parent: 10 }],
    [12, { channelId: 12, name: "CHILD", parent: 11 }]
  ]);
  return {
    channels, users: new Map(), edits: [],
    channelByName(name) { for (const [id, channel] of channels) if (channel.name === name) return id; return null; },
    async editChannel(id, fields) { this.edits.push({ id, fields }); return fields; }
  };
}

(async () => {
  const client = fakeClient();
  const stack = new RadioStack({ callsign: "TEST", rootChannel: "ORG" });
  stack.nets.push({ cfg: { name: "ALPHA" }, client, dead: false });
  let result = await stack.moveNet("ALPHA", "");
  assert(result.ok && client.edits[0].fields.parent === 10, "top-level means org root, never server root");
  result = await stack.moveNet("ALPHA", "CHILD");
  assert(!result.ok && /descendants/.test(result.error), "parent cycles are rejected before relay mutation");
  assert(!(await stack.renameNet("ORG", "RENAMED")).ok, "org root cannot be renamed by a command client");
  assert(!(await stack.removeNet("ORG")).ok, "org root cannot be deleted by a command client");

  const missing = new RadioStack({ callsign: "TEST", rootChannel: "MISSING" });
  missing.nets.push({ cfg: {}, client, dead: false });
  assert.deepStrictEqual(missing.atcView(), [], "missing org root must not expose the whole relay tree");
  console.log("✔ RADIO STACK UNIT PASS — org boundary and cycle checks are fail-closed");
})().catch(error => { console.error("✘ FAIL:", error); process.exitCode = 1; });
