import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BridgeConfig } from '@mlb/shared';
import { WORKSPACE_ROOT, CONFIG_FILE, DEFAULT_BRIDGE_CONFIG } from '@mlb/shared';

export class ConfigStore {
  /**
   * Read a bridge's config from its workspace directory.
   */
  readConfig(name: string): BridgeConfig {
    const configPath = join(WORKSPACE_ROOT, name, CONFIG_FILE);
    if (!existsSync(configPath)) {
      throw new Error(`Config not found for bridge "${name}": ${configPath}`);
    }

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as BridgeConfig;
    return parsed;
  }

  /**
   * Write (create or update) a bridge's config.
   */
  writeConfig(name: string, config: BridgeConfig): void {
    const workspace = join(WORKSPACE_ROOT, name);
    if (!existsSync(workspace)) {
      mkdirSync(workspace, { recursive: true });
    }

    const configPath = join(workspace, CONFIG_FILE);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[config-store] saved config for "${name}"`);
  }

  /**
   * Update specific fields of a bridge's config (partial update).
   */
  updateConfig(name: string, updates: Partial<BridgeConfig>): BridgeConfig {
    const existing = this.readConfig(name);
    const merged = this.deepMerge(existing, updates);
    this.writeConfig(name, merged);
    return merged;
  }

  /**
   * List all bridge names (directories with config.json).
   */
  listNames(): string[] {
    if (!existsSync(WORKSPACE_ROOT)) return [];

    const names: string[] = [];
    try {
      const entries = readdirSync(WORKSPACE_ROOT);
      for (const entry of entries) {
        const dir = join(WORKSPACE_ROOT, entry);
        try {
          if (statSync(dir).isDirectory() && existsSync(join(dir, CONFIG_FILE))) {
            names.push(entry);
          }
        } catch { /* skip */ }
      }
    } catch { /* empty */ }

    return names;
  }

  /**
   * Validate a config, returning a list of error messages (empty = valid).
   */
  validateConfig(config: Partial<BridgeConfig>): string[] {
    const errors: string[] = [];

    if (!config.name?.trim()) {
      errors.push('name is required');
    } else if (!/^[a-zA-Z0-9_-]+$/.test(config.name)) {
      errors.push('name must contain only letters, numbers, hyphens, and underscores');
    }

    // At least one platform must be configured (Feishu or WeChat)
    const hasFeishu = !!(config.app_id?.trim() && config.app_secret?.trim());
    const hasWechat = !!config.wechat?.bot_token;
    if (!hasFeishu && !hasWechat) {
      errors.push('至少需要配置一个平台（飞书或微信）');
    }
    // If Feishu fields are partially filled, require both
    if ((config.app_id?.trim() && !config.app_secret?.trim()) ||
        (!config.app_id?.trim() && config.app_secret?.trim())) {
      errors.push('飞书 app_id 和 app_secret 必须同时填写');
    }
    if (!config.work_dir?.trim()) errors.push('work_dir is required');

    if (config.claude?.mode) {
      const validModes = ['default', 'acceptEdits', 'bypassPermissions'];
      if (!validModes.includes(config.claude.mode)) {
        errors.push(`claude.mode must be one of: ${validModes.join(', ')}`);
      }
    }

    return errors;
  }

  /**
   * Create a default config for a new bridge.
   */
  createDefault(name: string): BridgeConfig {
    return {
      name,
      app_id: '',
      app_secret: '',
      api_base_url: DEFAULT_BRIDGE_CONFIG.api_base_url,
      work_dir: process.cwd(),
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

  // --- Internal ---

  private deepMerge(target: BridgeConfig, source: Partial<BridgeConfig>): BridgeConfig {
    const result = { ...target };

    for (const key of Object.keys(source) as (keyof BridgeConfig)[]) {
      const val = source[key];
      if (val === undefined) continue;

      if (key === 'claude' && typeof val === 'object' && val !== null) {
        result.claude = { ...result.claude, ...(val as Partial<BridgeConfig['claude']>) };
      } else if (key === 'stream_preview' && typeof val === 'object' && val !== null) {
        result.stream_preview = { ...result.stream_preview, ...(val as Partial<BridgeConfig['stream_preview']>) };
      } else {
        (result as any)[key] = val;
      }
    }

    return result;
  }
}
