import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const smokePath = resolve(root, "scripts/checks/package-install-smoke.js");

function readSmokeSource() {
  return readFileSync(smokePath, "utf-8");
}

async function importSmoke() {
  const nonce = randomBytes(8).toString("hex");
  return await import(`${pathToFileURL(smokePath).href}?package-gate-test=${nonce}`);
}

describe("package installation gate", () => {
  it("is import-safe and does not execute the smoke automatically", async () => {
    const messages = [];
    const originalLog = console.log;
    console.log = (...args) => messages.push(args.join(" "));
    try {
      const smoke = await importSmoke();
      assert.equal(typeof smoke.runPackageInstallSmoke, "function");
      assert.equal(typeof smoke.collectExactProxyValues, "function");
      assert.equal(typeof smoke.redactDiagnosticTail, "function");
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(messages, []);
  });

  it("redacts randomized exact proxy values and endpoint derivatives", async () => {
    const { collectExactProxyValues, redactDiagnosticTail } = await importSmoke();
    const user = randomBytes(8).toString("hex");
    const password = randomBytes(8).toString("hex");
    const host = `proxy-${randomBytes(8).toString("hex")}.invalid`;
    const exact = ["https://", user, ":", password, "@", host, ":9443"].join("");
    const exactValues = collectExactProxyValues({ HTTPS_PROXY: exact });
    const variants = [exact, `${exact}/`, `https://${host}:9443`, `https://${host}:9443/`, `${host}:9443`, host];
    for (const variant of variants) assert.equal(exactValues.includes(variant), true);

    const schemelessHost = `edge-${randomBytes(8).toString("hex")}.invalid`;
    const schemeless = [user, ":", password, "@", schemelessHost, ":8080"].join("");
    const schemelessValues = collectExactProxyValues({ HTTP_PROXY: schemeless });
    const schemelessVariants = [
      schemeless,
      `${schemeless}/`,
      `http://${schemelessHost}:8080`,
      `http://${schemelessHost}:8080/`,
      `${schemelessHost}:8080`,
      schemelessHost,
    ];
    for (const variant of schemelessVariants) {
      assert.equal(schemelessValues.includes(variant), true);
    }

    const allVariants = [...variants, ...schemelessVariants];
    const redacted = redactDiagnosticTail(allVariants.join("\n"), [...exactValues, ...schemelessValues], 4096);
    for (const variant of allVariants) assert.equal(redacted.includes(variant), false);
    assert.match(redacted, /<redacted-exact-value>/);
  });

  it("uses the supervised bounded package-install contract", () => {
    const smoke = readSmokeSource();
    assert.match(smoke, /^#!\/usr\/bin\/env node/);
    assert.match(smoke, /import\("\.\.\/\.\.\/dist\/runner\/simpleProcess\.js"\)/);
    assert.match(smoke, /await runSimpleProcess\(/);
    assert.doesNotMatch(smoke, /spawnSync/);
    assert.doesNotMatch(smoke, /buildChildEnvironment/);
    assert.doesNotMatch(smoke, /resolvePackageManagerInvocation/);
    assert.doesNotMatch(smoke, /processSecurity\.js/);
    assert.match(smoke, /const NPM_STEP_TIMEOUT_MS = 90_000/);
    assert.match(smoke, /timeoutMs: NPM_STEP_TIMEOUT_MS/);
    assert.match(smoke, /--prefer-offline/);
    assert.match(smoke, /--fetch-retries=0/);
    assert.match(smoke, /--fetch-timeout=15000/);
    assert.equal(smoke.match(/"--ignore-scripts"/g)?.length, 2);
    assert.match(smoke, /async function run\(command, args, cwd, name, environmentVariableNames = \[\]\)/);
    assert.match(smoke, /environmentVariableNames,\s+environmentOverrides/);
    assert.match(smoke, /return await run\(npm, \[\.\.\.NPM_NETWORK_ARGS, \.\.\.args\], cwd, name, PROXY_ENVIRONMENT_NAMES\)/);
    const nodeChecks = smoke.match(/await run\(process\.execPath, \["--check"[^\n]+/g) || [];
    assert.equal(nodeChecks.length, 2);
    assert.equal(nodeChecks.every((line) => !line.includes("PROXY_ENVIRONMENT_NAMES")), true);
    assert.match(smoke, /if \(isMainModule\(\)\) await runPackageInstallSmoke\(\);/);
  });
});
