import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenData } from './oauth.js';

const TOKENS_FILE = 'tokens.json';

export function loadTokens(dataDir: string): TokenData | null {
  const path = join(dataDir, TOKENS_FILE);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!data.user_access_token) return null;
    return data as TokenData;
  } catch {
    return null;
  }
}

export function saveTokens(dataDir: string, tokens: TokenData): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(join(dataDir, TOKENS_FILE), JSON.stringify(tokens, null, 2) + '\n');
  console.log('[auth] tokens saved');
}

/** Clear stored tokens (e.g., when refresh_token is consumed/invalid). */
export function clearTokens(dataDir: string): void {
  const path = join(dataDir, TOKENS_FILE);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      console.log('[auth] tokens cleared');
    }
  } catch { /* ignore */ }
}

/**
 * Check if the stored user token is still valid (not expired).
 */
export function isTokenValid(tokens: TokenData | null): boolean {
  if (!tokens?.user_access_token || !tokens.token_expiry) return false;
  // Consider expired 5 minutes before actual expiry
  return new Date(tokens.token_expiry).getTime() - 5 * 60 * 1000 > Date.now();
}
