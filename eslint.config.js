"use strict";
const globals = require("globals");

module.exports = [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["*.js", "src/**/*.js", "server/**/*.js", "scripts/**/*.js", "test/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: globals.node },
    rules: { "no-undef": "error", "no-unreachable": "error" }
  },
  {
    files: ["renderer/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: globals.browser },
    rules: { "no-undef": "error", "no-unreachable": "error" }
  },
  {
    files: ["renderer/mic-worklet.js"],
    languageOptions: { globals: Object.assign({}, globals.browser, {
      AudioWorkletProcessor: "readonly", currentTime: "readonly", registerProcessor: "readonly", sampleRate: "readonly"
    }) }
  }
];
