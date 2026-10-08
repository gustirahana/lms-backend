import * as assert from "node:assert/strict";
import { loadConfig } from "../src/config";

function productionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "4000",
    FRONTEND_ORIGINS: "https://learn.example.test",
    TRUST_PROXY_HOPS: "1",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    AUTH_ENCRYPTION_KEY_VERSION: "v1",
    AUTH_ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 0x5a).toString("base64")}`,
  };
}

const validConfig = loadConfig(productionEnv());
assert.equal(validConfig.isProduction, true);
assert.equal(validConfig.frontendOrigins[0], "https://learn.example.test");
assert.equal(validConfig.trustProxyHops, 1);
assert.equal(validConfig.authEncryptionKeys?.v1.length, 32);

const insecureOrigin = productionEnv();
insecureOrigin.FRONTEND_ORIGINS = "http://learn.example.test";
assert.throws(() => loadConfig(insecureOrigin), /using HTTPS/);

const originWithPath = productionEnv();
originWithPath.FRONTEND_ORIGINS = "https://learn.example.test/app";
assert.throws(() => loadConfig(originWithPath), /exact origins using HTTPS/);

const missingSecretKey = productionEnv();
delete missingSecretKey.SUPABASE_SECRET_KEY;
assert.throws(
  () => loadConfig(missingSecretKey),
  /SUPABASE_SECRET_KEY are required/,
);

const missingEncryptionKey = productionEnv();
delete missingEncryptionKey.AUTH_ENCRYPTION_KEYS;
assert.throws(
  () => loadConfig(missingEncryptionKey),
  /AUTH_ENCRYPTION_KEYS and AUTH_ENCRYPTION_KEY_VERSION/,
);

const shortEncryptionKey = productionEnv();
shortEncryptionKey.AUTH_ENCRYPTION_KEYS = `v1:${Buffer.alloc(16, 0x5a).toString("base64")}`;
assert.throws(() => loadConfig(shortEncryptionKey), /exactly 32 bytes/);

const mismatchedKeyVersion = productionEnv();
mismatchedKeyVersion.AUTH_ENCRYPTION_KEY_VERSION = "v2";
assert.throws(
  () => loadConfig(mismatchedKeyVersion),
  /must match a key version/,
);

const invalidProxyHops = productionEnv();
invalidProxyHops.TRUST_PROXY_HOPS = "11";
assert.throws(
  () => loadConfig(invalidProxyHops),
  /TRUST_PROXY_HOPS must be an integer/,
);

const legacyKeys = productionEnv();
legacyKeys.SUPABASE_ANON_KEY = legacyKeys.SUPABASE_PUBLISHABLE_KEY;
legacyKeys.SUPABASE_SERVICE_ROLE_KEY = legacyKeys.SUPABASE_SECRET_KEY;
delete legacyKeys.SUPABASE_PUBLISHABLE_KEY;
delete legacyKeys.SUPABASE_SECRET_KEY;
assert.equal(
  loadConfig(legacyKeys).supabasePublishableKey,
  "sb_publishable_test",
);
assert.equal(loadConfig(legacyKeys).supabaseSecretKey, "sb_secret_test");

console.log(
  "Config smoke passed: production origins, Supabase credentials, encryption key ring, proxy bounds, and legacy key fallback.",
);
