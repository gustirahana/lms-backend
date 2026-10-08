export interface AppConfig {
  port: number;
  host: string;
  frontendOrigins: string[];
  trustProxyHops: number;
  bodyLimit: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  isProduction: boolean;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  supabaseSecretKey?: string;
  authEncryptionKeyVersion: string;
  authEncryptionKeys?: Record<string, Buffer>;
  cookieSameSite: 'lax' | 'strict' | 'none';
}

function integerValue(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[key];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development';

  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const frontendOrigins = (env.FRONTEND_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of frontendOrigins) {
    let parsed: URL;

    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`FRONTEND_ORIGINS contains an invalid origin: ${origin}`);
    }

    if (parsed.origin !== origin || (nodeEnv === 'production' && parsed.protocol !== 'https:')) {
      throw new Error(`FRONTEND_ORIGINS must contain exact origins${nodeEnv === 'production' ? ' using HTTPS' : ''}`);
    }
  }

  const bodyLimit = env.BODY_LIMIT || '100kb';

  if (!/^\d+(kb|mb)$/i.test(bodyLimit)) {
    throw new Error('BODY_LIMIT must be a size such as 100kb or 1mb');
  }

  const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, '');
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const cookieSameSite = (env.COOKIE_SAME_SITE || 'lax').toLowerCase();

  if (!['lax', 'strict', 'none'].includes(cookieSameSite)) {
    throw new Error('COOKIE_SAME_SITE must be lax, strict, or none');
  }

  if (nodeEnv === 'production') {
    if (frontendOrigins.length === 0 || !env.FRONTEND_ORIGINS) {
      throw new Error('FRONTEND_ORIGINS must contain at least one production HTTPS origin');
    }

    if (!supabaseUrl || !supabasePublishableKey || !supabaseSecretKey) {
      throw new Error('SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY are required in production');
    }

    let parsedSupabaseUrl: URL;

    try {
      parsedSupabaseUrl = new URL(supabaseUrl);
    } catch {
      throw new Error('SUPABASE_URL must be a valid HTTPS URL in production');
    }

    if (
      parsedSupabaseUrl.protocol !== 'https:' ||
      parsedSupabaseUrl.username ||
      parsedSupabaseUrl.password ||
      parsedSupabaseUrl.search ||
      parsedSupabaseUrl.hash ||
      (parsedSupabaseUrl.pathname !== '/' && parsedSupabaseUrl.pathname !== '')
    ) {
      throw new Error('SUPABASE_URL must use HTTPS in production');
    }

    if (!env.AUTH_ENCRYPTION_KEYS || !env.AUTH_ENCRYPTION_KEY_VERSION) {
      throw new Error('AUTH_ENCRYPTION_KEYS and AUTH_ENCRYPTION_KEY_VERSION are required in production');
    }
  }

  const authEncryptionKeyVersion = env.AUTH_ENCRYPTION_KEY_VERSION || 'v1';

  if (!/^[a-zA-Z0-9_-]{1,16}$/.test(authEncryptionKeyVersion)) {
    throw new Error('AUTH_ENCRYPTION_KEY_VERSION must be 1 to 16 letters, numbers, underscores, or hyphens');
  }

  const authEncryptionKeys: Record<string, Buffer> = {};

  if (env.AUTH_ENCRYPTION_KEYS) {
    for (const entry of env.AUTH_ENCRYPTION_KEYS.split(',')) {
      const [version, encodedKey] = entry.trim().split(':');

      if (!version || !/^[a-zA-Z0-9_-]{1,16}$/.test(version) || !encodedKey) {
        throw new Error('AUTH_ENCRYPTION_KEYS must use version:base64 entries separated by commas');
      }

      const key = Buffer.from(encodedKey, 'base64');

      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedKey) ||
        key.toString('base64') !== encodedKey ||
        key.length !== 32) {
        throw new Error(`AUTH_ENCRYPTION_KEYS entry ${version} must decode to exactly 32 bytes`);
      }

      if (authEncryptionKeys[version]) {
        throw new Error(`AUTH_ENCRYPTION_KEYS contains duplicate version ${version}`);
      }

      authEncryptionKeys[version] = key;
    }
  }

  if (Object.keys(authEncryptionKeys).length > 0 && authEncryptionKeys[authEncryptionKeyVersion] === undefined) {
    throw new Error('AUTH_ENCRYPTION_KEY_VERSION must match a key version in AUTH_ENCRYPTION_KEYS');
  }

  if (cookieSameSite === 'none' && nodeEnv !== 'production' && env.COOKIE_SECURE !== 'true') {
    throw new Error('SameSite=None cookies require Secure; use SameSite=Lax for local HTTP development');
  }

  return {
    port: integerValue(env, 'PORT', 4000, 1, 65535),
    host: env.HOST || '0.0.0.0',
    frontendOrigins,
    trustProxyHops: integerValue(env, 'TRUST_PROXY_HOPS', 0, 0, 10),
    bodyLimit,
    rateLimitMax: integerValue(env, 'RATE_LIMIT_MAX', 120, 1, 10000),
    rateLimitWindowMs: integerValue(env, 'RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000),
    authRateLimitMax: integerValue(env, 'AUTH_RATE_LIMIT_MAX', 10, 1, 1000),
    authRateLimitWindowMs: integerValue(env, 'AUTH_RATE_LIMIT_WINDOW_MS', 900000, 1000, 3600000),
    isProduction: nodeEnv === 'production',
    supabaseUrl,
    supabasePublishableKey,
    supabaseSecretKey,
    authEncryptionKeyVersion,
    authEncryptionKeys,
    cookieSameSite: cookieSameSite as AppConfig['cookieSameSite'],
  };
}
