"use strict";
function channelName(value) {
  return String(value || "").trim().replace(/[^ \-=\w#\[\]{}()@|]/g, "-").slice(0, 120);
}
module.exports = { channelName };
