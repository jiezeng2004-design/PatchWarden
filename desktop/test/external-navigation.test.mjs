import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedExternalNavigation } from "../dist/external-navigation.js";

describe("desktop external navigation allowlist", () => {
  it("allows only exact approved HTTPS hosts", () => {
    for (const url of [
      "https://platform.openai.com/settings/organization/tunnels",
      "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
      "https://chatgpt.com/#settings/Plugins",
      "https://github.com/jiezeng2004-design/PatchWarden",
    ]) assert.equal(isAllowedExternalNavigation(url), true, url);
    for (const url of [
      "http://github.com/example",
      "https://github.com.attacker.invalid/example",
      "https://user@github.com/example",
      "https://github.com:444/example",
      "file:///C:/Windows/System32/calc.exe",
      "javascript:alert(1)",
      "not-a-url",
    ]) assert.equal(isAllowedExternalNavigation(url), false, url);
  });
});
