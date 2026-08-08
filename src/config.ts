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
  /** OpenAI API key (preferred — cheaper models). */
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),

  /** Allowed CORS origins (comma-separated). Empty or * = allow all (dev only). */
  CORS_ORIGINS: optionalEnv('CORS_ORIGINS', ''),

  /** Max JSON body size for express.json() */
  JSON_BODY_LIMIT: optionalEnv('JSON_BODY_LIMIT', '50kb'),

  /** Message limit per user before 429 (reset not implemented; consider daily reset later). */
  MESSAGE_QUOTA_PER_USER: parseInt(optionalEnv('MESSAGE_QUOTA_PER_USER', '10'), 10),

  /** OpenAI model and max tokens. */
  OPENAI_MODEL: optionalEnv('OPENAI_MODEL', 'gpt-4o-mini'),
  OPENAI_MAX_TOKENS: parseInt(optionalEnv('OPENAI_MAX_TOKENS', '4096'), 10),

  /** UTM source tag appended to retailer affiliate links. */
  UTM_SOURCE: optionalEnv('UTM_SOURCE', 'my-food-sorted'),
} as const;

/** Retailers supported for affiliate links. */
export const RETAILERS = ['tesco', 'sainsburys'] as const;
export type Retailer = (typeof RETAILERS)[number];
