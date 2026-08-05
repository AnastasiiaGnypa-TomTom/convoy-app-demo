/**
 * Zero-dependency .env loader.
 *
 * Real process environment always wins over the .env file, which is exactly how
 * Azure App Service application settings behave — so local dev and the deployed
 * app read config through the same accessor with no code change.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

function parseDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = parseDotEnv(join(ROOT, '.env'));

/** Read a config value. Process env first, then .env, then the given default. */
export function env(key, fallback = '') {
  return process.env[key] || fileEnv[key] || fallback;
}

export const config = {
  port: Number(env('PORT', '8080')),
  tomtomKey: env('TOMTOM_API_KEY'),
  vantorApiKey: env('VANTOR_API_KEY'),
  isProduction: env('NODE_ENV') === 'production',
};

/**
 * Log what is configured WITHOUT ever printing a secret value.
 * Presence only — never length, never a prefix, never a fragment.
 */
export function logConfigSummary() {
  console.log('[config] port                 =', config.port);
  console.log('[config] TOMTOM_API_KEY       =', config.tomtomKey ? 'set' : 'MISSING');
  console.log('[config] VANTOR_API_KEY       =', config.vantorApiKey ? 'set' : 'MISSING');
}
