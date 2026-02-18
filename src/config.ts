/**
 * Central config with startup validation. Server must not start without required env.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value.trim() === '') {
    console.error(`FATAL: ${name} is required. Set it in .env (and never commit real secrets).`);
    process.exit(1);
  }
  return value.trim();
}

function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value != null && value.trim() !== '' ? value.trim() : defaultValue;
}

/** Validated at startup; no fallback for secrets. */
export const config = {
  PORT: parseInt(optionalEnv('PORT', '3000'), 10),
  DATABASE_URL: requireEnv('DATABASE_URL'),
  JWT_SECRET: requireEnv('JWT_SECRET'),
  CLAUDE_API_KEY: requireEnv('CLAUDE_API_KEY'),

  /** Allowed CORS origins (comma-separated). Empty or * = allow all (dev only). */
  CORS_ORIGINS: optionalEnv('CORS_ORIGINS', ''),

  /** Max JSON body size for express.json() */
  JSON_BODY_LIMIT: optionalEnv('JSON_BODY_LIMIT', '50kb'),

  /** Message limit per user before 429 (reset not implemented; consider daily reset later). */
  MESSAGE_QUOTA_PER_USER: 10,

  /** Claude model and max tokens (for clarity; override via env if needed later). */
  CLAUDE_MODEL: optionalEnv('CLAUDE_MODEL', 'claude-sonnet-4-5-20250929'),
  CLAUDE_MAX_TOKENS: parseInt(optionalEnv('CLAUDE_MAX_TOKENS', '4096'), 10),
} as const;

/** Retailers supported for affiliate links. */
export const RETAILERS = ['tesco', 'sainsburys'] as const;
export type Retailer = (typeof RETAILERS)[number];
