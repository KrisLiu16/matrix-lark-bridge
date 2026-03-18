import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BridgeConfig } from '@mlb/shared';
import { CONFIG_FILE, DEFAULT_BRIDGE_CONFIG } from '@mlb/shared';

// Re-export for bridge modules
export type { BridgeConfig };

function defaults(): BridgeConfig {
  return {
    name: '',
    app_id: '',
    app_secret: '',
    work_dir: process.cwd(),
    api_base_url: DEFAULT_BRIDGE_CONFIG.api_base_url,
    claude: {
      mode: DEFAULT_BRIDGE_CONFIG.claude.mode,
    },
    stream_preview: {
      enabled: DEFAULT_BRIDGE_CONFIG.stream_preview.enabled,
      interval_ms: DEFAULT_BRIDGE_CONFIG.stream_preview.interval_ms,
      min_delta_chars: DEFAULT_BRIDGE_CONFIG.stream_preview.min_delta_chars,
      max_chars: DEFAULT_BRIDGE_CONFIG.stream_preview.max_chars,
    },
    auto_start: DEFAULT_BRIDGE_CONFIG.auto_start,
  };
}

/**
 * Load bridge config from a workspace directory.
 * Reads `<workspace>/config.json`.
 */
export function loadConfig(workspace: string): BridgeConfig {
  const configPath = join(workspace, CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, 'utf-8');
  console.log(`[config] loaded from ${configPath}`);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const cfg = defaults();

  if (typeof parsed.name === 'string') cfg.name = parsed.name;
  if (typeof parsed.app_id === 'string') cfg.app_id = parsed.app_id;
  if (typeof parsed.app_secret === 'string') cfg.app_secret = parsed.app_secret;
  if (typeof parsed.work_dir === 'string') cfg.work_dir = parsed.work_dir.replace(/^~/, homedir());
  if (typeof parsed.bot_name === 'string') cfg.bot_name = parsed.bot_name;
  if (typeof parsed.api_base_url === 'string') cfg.api_base_url = parsed.api_base_url.replace(/\/+$/, '');
  if (typeof parsed.auto_start === 'boolean') cfg.auto_start = parsed.auto_start;

  const VALID_CLAUDE_MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;

  const claude = parsed.claude as Record<string, unknown> | undefined;
  if (claude) {
    if (typeof claude.mode === 'string') {
      if (!(VALID_CLAUDE_MODES as readonly string[]).includes(claude.mode)) {
        throw new Error(`Invalid claude.mode "${claude.mode}". Must be one of: ${VALID_CLAUDE_MODES.join(', ')}`);
      }
      cfg.claude.mode = claude.mode as BridgeConfig['claude']['mode'];
    }
    if (typeof claude.model === 'string') cfg.claude.model = claude.model;
    if (typeof claude.system_prompt === 'string') cfg.claude.system_prompt = claude.system_prompt;
    if (Array.isArray(claude.allowed_tools)) {
      cfg.claude.allowed_tools = claude.allowed_tools as string[];
    }
  }

  const sp = parsed.stream_preview as Record<string, unknown> | undefined;
  if (sp) {
    if (typeof sp.enabled === 'boolean') cfg.stream_preview.enabled = sp.enabled;
    if (typeof sp.interval_ms === 'number') cfg.stream_preview.interval_ms = sp.interval_ms;
    if (typeof sp.min_delta_chars === 'number') cfg.stream_preview.min_delta_chars = sp.min_delta_chars;
    if (typeof sp.max_chars === 'number') cfg.stream_preview.max_chars = sp.max_chars;
  }

  if (!cfg.app_id || !cfg.app_secret) {
    throw new Error('app_id and app_secret are required in config');
  }
  return cfg;
}
