import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BridgeConfig, WechatChannelState } from '@mlb/shared';
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
  if (typeof parsed.max_queue === 'number' && parsed.max_queue >= 1) cfg.max_queue = parsed.max_queue;

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
    const VALID_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
    if (typeof claude.effort === 'string' && (VALID_EFFORTS as readonly string[]).includes(claude.effort)) {
      cfg.claude.effort = claude.effort as BridgeConfig['claude']['effort'];
    }
    if (typeof claude.context_limit === 'number' && claude.context_limit > 0) {
      cfg.claude.context_limit = claude.context_limit;
    }
    if (claude.env && typeof claude.env === 'object' && !Array.isArray(claude.env)) {
      cfg.claude.env = claude.env as BridgeConfig['claude']['env'];
    }
  }

  const sp = parsed.stream_preview as Record<string, unknown> | undefined;
  if (sp) {
    if (typeof sp.enabled === 'boolean') cfg.stream_preview.enabled = sp.enabled;
    if (typeof sp.interval_ms === 'number') cfg.stream_preview.interval_ms = sp.interval_ms;
    if (typeof sp.min_delta_chars === 'number') cfg.stream_preview.min_delta_chars = sp.min_delta_chars;
    if (typeof sp.max_chars === 'number') cfg.stream_preview.max_chars = sp.max_chars;
  }

  // WeChat config (optional — feishu-only setups omit this)
  const VALID_WECHAT_STATES: readonly WechatChannelState[] = ['disconnected', 'scanning', 'scanned', 'connected', 'reconnecting', 'expired'];
  const wc = parsed.wechat as Record<string, unknown> | undefined;
  if (wc) {
    const wechatState: WechatChannelState =
      typeof wc.state === 'string' && (VALID_WECHAT_STATES as readonly string[]).includes(wc.state)
        ? (wc.state as WechatChannelState)
        : 'disconnected';
    cfg.wechat = {
      bot_token: typeof wc.bot_token === 'string' ? wc.bot_token : '',
      ilink_bot_id: typeof wc.ilink_bot_id === 'string' ? wc.ilink_bot_id : '',
      state: wechatState,
      last_active: typeof wc.last_active === 'string' ? wc.last_active : undefined,
      qrcode_url: typeof wc.qrcode_url === 'string' ? wc.qrcode_url : undefined,
      auto_reconnect: typeof wc.auto_reconnect === 'boolean' ? wc.auto_reconnect : true,
    };
  }

  if (!cfg.wechat && (!cfg.app_id || !cfg.app_secret)) {
    throw new Error('app_id and app_secret are required when wechat channel is not configured');
  }
  return cfg;
}
