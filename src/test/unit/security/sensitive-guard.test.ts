import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  guardSensitivePath,
  hasWindowsAlternateDataStream,
  isSensitivePath,
} from "../../../security/sensitiveGuard.js";
import { PatchWardenError } from "../../../errors.js";

describe("isSensitivePath", () => {
  it("blocks .env files", () => {
    assert.equal(isSensitivePath(".env"), true);
    assert.equal(isSensitivePath("path/to/.env"), true);
    assert.equal(isSensitivePath(".env.production"), true);
    assert.equal(isSensitivePath(".env.local"), true);
  });

  it("blocks .ENV case insensitive", () => {
    assert.equal(isSensitivePath(".ENV"), true);
    assert.equal(isSensitivePath("path/to/.ENV"), true);
    assert.equal(isSensitivePath(".Env.Production"), true);
  });

  it("blocks config.json case insensitive", () => {
    assert.equal(isSensitivePath("config.json"), true);
    assert.equal(isSensitivePath("Config.json"), true);
    assert.equal(isSensitivePath("CONFIG.JSON"), true);
    assert.equal(isSensitivePath("path/to/Config.json"), true);
  });

  it("blocks SSH keys", () => {
    assert.equal(isSensitivePath("id_rsa"), true);
    assert.equal(isSensitivePath("id_dsa"), true);
    assert.equal(isSensitivePath("id_ed25519"), true);
    assert.equal(isSensitivePath("id_ecdsa"), true);
    assert.equal(isSensitivePath("path/to/id_rsa"), true);
    assert.equal(isSensitivePath(".ssh/id_rsa"), true);
  });

  it("blocks credentials and tokens", () => {
    assert.equal(isSensitivePath("credentials"), true);
    assert.equal(isSensitivePath("path/to/credentials.json"), true);
    assert.equal(isSensitivePath("token.txt"), true);
    assert.equal(isSensitivePath("token-store.json"), true);
    assert.equal(isSensitivePath("access_token"), true);
    assert.equal(isSensitivePath("refresh-token.json"), true);
    assert.equal(isSensitivePath("api_key.txt"), true);
    assert.equal(isSensitivePath("client_secret"), true);
    assert.equal(isSensitivePath("path/to/token"), true);
    assert.equal(isSensitivePath(".netrc"), true);
    assert.equal(isSensitivePath(".npmrc"), true);
    assert.equal(isSensitivePath(".pypirc"), true);
    assert.equal(isSensitivePath(".envrc"), true);
    assert.equal(isSensitivePath("tokenizer.ts"), false);
    assert.equal(isSensitivePath("credentials-handler.ts"), false);
  });

  it("blocks private key files", () => {
    assert.equal(isSensitivePath("server.pem"), true);
    assert.equal(isSensitivePath("private.key"), true);
    assert.equal(isSensitivePath("cert.pfx"), true);
    assert.equal(isSensitivePath("cert.p12"), true);
    assert.equal(isSensitivePath("putty.ppk"), true);
  });

  it("blocks browser data files", () => {
    assert.equal(isSensitivePath("cookies"), true);
    assert.equal(isSensitivePath("cookies.db"), true);
    assert.equal(isSensitivePath("Web Data"), true);
    assert.equal(isSensitivePath("Login Data"), true);
    assert.equal(isSensitivePath("Local State"), true);
  });

  it("blocks .git-credentials", () => {
    assert.equal(isSensitivePath(".git-credentials"), true);
    assert.equal(isSensitivePath("path/to/.git-credentials"), true);
    assert.equal(isSensitivePath(".git/config"), true);
  });

  it("blocks docker and kube config", () => {
    assert.equal(isSensitivePath(".docker/config.json"), true);
    assert.equal(isSensitivePath(".kube/config"), true);
    assert.equal(isSensitivePath("kubeconfig"), true);
    assert.equal(isSensitivePath("application_default_credentials.json"), true);
    assert.equal(isSensitivePath("service-account-prod.json"), true);
  });

  it("allows ordinary PatchWarden artifacts but never exempts sensitive names", () => {
    assert.equal(isSensitivePath(".patchwarden/tasks/task-001/status.json"), false);
    assert.equal(isSensitivePath(".patchwarden"), false);
    assert.equal(isSensitivePath(".patchwarden/.env"), true);
    assert.equal(isSensitivePath(".patchwarden/config.json"), true);
    assert.equal(isSensitivePath(".patchwarden/credentials.json"), true);
    assert.equal(isSensitivePath(".patchwarden/id_rsa"), true);
    assert.equal(isSensitivePath("workspace/.PATCHWARDEN/token.txt"), true);
  });

  it("does not treat lookalike or traversing PatchWarden paths as special", () => {
    assert.equal(isSensitivePath("foo.patchwarden/.env"), true);
    assert.equal(isSensitivePath("foo.patchwarden/config.json"), true);
    assert.equal(isSensitivePath("nested/foo.patchwarden/token.txt"), true);
    assert.equal(isSensitivePath(".patchwarden/../.env"), true);
  });

  it("blocks NTFS alternate data stream paths before safe-prefix handling", () => {
    assert.equal(isSensitivePath(".env::$DATA"), true);
    assert.equal(isSensitivePath("config.json:secret"), true);
    assert.equal(isSensitivePath("README.md:secret"), true);
    assert.equal(isSensitivePath(".patchwarden/config.json::$DATA"), true);
    assert.equal(hasWindowsAlternateDataStream("C:\\repo\\README.md"), false);
    assert.equal(hasWindowsAlternateDataStream("C:\\repo\\README.md:secret"), true);
  });

  it("allows non-sensitive files", () => {
    assert.equal(isSensitivePath("src/main.ts"), false);
    assert.equal(isSensitivePath("README.md"), false);
    assert.equal(isSensitivePath("package.json"), false);
    assert.equal(isSensitivePath("docs/guide.md"), false);
  });

  it("handles Windows backslash paths", () => {
    assert.equal(isSensitivePath("path\\to\\.env"), true);
    assert.equal(isSensitivePath("path\\to\\config.json"), true);
    assert.equal(isSensitivePath(".patchwarden\\tasks\\status.json"), false);
    assert.equal(isSensitivePath(".patchwarden\\credentials.json"), true);
  });

  it("handles null byte in path", () => {
    const nullPath = "config.json\x00.txt";
    assert.equal(isSensitivePath(nullPath), true);
    assert.equal(isSensitivePath("config.json"), true);
  });

  it("handles Unicode lookalike characters", () => {
    // Full-width dot (U+FF0E) should not match .env pattern
    // This is expected behavior — Unicode lookalikes are NOT matched
    const fullWidthPath = "\uFF0Eenv";
    assert.equal(isSensitivePath(fullWidthPath), false);
  });
});

describe("guardSensitivePath", () => {
  it("throws PatchWardenError for sensitive paths", () => {
    assert.throws(
      () => guardSensitivePath(".env"),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
    assert.throws(
      () => guardSensitivePath("README.md:secret"),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
  });

  it("does not throw for non-sensitive paths", () => {
    assert.doesNotThrow(() => guardSensitivePath("src/main.ts"));
    assert.doesNotThrow(() => guardSensitivePath("README.md"));
  });

  it("does not throw for .patchwarden paths", () => {
    assert.doesNotThrow(() => guardSensitivePath(".patchwarden/tasks/status.json"));
  });
});
