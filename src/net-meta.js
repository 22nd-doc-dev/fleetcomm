"use strict";
const PREFIX = "FLEETCOMM_META:";

function normalMeta(meta) {
  const value = meta || {};
  const freq = /^\d{1,3}\.\d{3}$/.test(String(value.freq || "")) ? String(value.freq) : null;
  return { freq, ship: !!value.ship };
}
function encodeMeta(meta) {
  return PREFIX + Buffer.from(JSON.stringify(normalMeta(meta))).toString("base64url");
}
function decodeMeta(description) {
  const text = String(description || "");
  const at = text.indexOf(PREFIX);
  if (at >= 0) {
    const encoded = text.slice(at + PREFIX.length).split(/\s|</, 1)[0];
    try { return normalMeta(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); }
    catch (error) {}
  }
  const legacy = text.match(/(?:Net|Subnet)\s+(\d{1,3}\.\d{3})/i);
  return { freq: legacy ? legacy[1] : null, ship: null };
}

module.exports = { PREFIX, decodeMeta, encodeMeta, normalMeta };
