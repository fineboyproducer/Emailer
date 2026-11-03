"use strict";

// "ada@example.com" -> "a***@example.com". Run summaries are printed in GitHub Actions logs,
// and this repository (and so its logs) is public, so recipient addresses must never appear in them.
const mask = (email) => String(email).replace(/^(.).*(@.*)$/, "$1***$2");

// Masks any email address that appears inside a longer message (e.g. a provider error).
const maskIn = (text) => String(text).replace(/[^\s@<>"']+@[^\s@<>"']+/g, (m) => mask(m));

module.exports = { mask, maskIn };
