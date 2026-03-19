import { join } from 'node:path';
import { homedir } from 'node:os';

/** Root directory for all bridge workspaces */
export const WORKSPACE_ROOT = join(homedir(), 'mlb-workspace');

/** Default Feishu API base URL */
export const DEFAULT_API_BASE_URL = 'https://open.feishu.cn';

/** PID file name within a workspace */
export const PID_FILE = 'bridge.pid';

/** Log file name within a workspace */
export const LOG_FILE = 'bridge.log';

/** Error log file name within a workspace */
export const ERR_LOG_FILE = 'bridge.err.log';

/** Config file name within a workspace */
export const CONFIG_FILE = 'config.json';

/** Session file name within a workspace */
export const SESSION_FILE = 'session.json';

/** Default bridge config values */
/** Default Claude Code env — injected per-process, not written to global settings */
export const DEFAULT_CLAUDE_ENV = {
  ANTHROPIC_BASE_URL: 'https://talkie-ali-virginia-prod-internal.xaminim.com/llm/debug/claude',
  ANTHROPIC_AUTH_TOKEN: 'none',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Biz-Id: claude-code',
};

export const DEFAULT_BRIDGE_CONFIG = {
  api_base_url: DEFAULT_API_BASE_URL,
  claude: {
    mode: 'default',
    model: 'sonnet',
    effort: 'medium',
    env: { ...DEFAULT_CLAUDE_ENV },
  },
  stream_preview: {
    enabled: true,
    interval_ms: 2000,
    min_delta_chars: 50,
    max_chars: 3000,
  },
  auto_start: false,
} as const;

/** Feishu registration URL for QR code flow */
export const FEISHU_REGISTRATION_URL = 'https://accounts.feishu.cn/oauth/v1/app/registration';

/** Bridge process monitoring interval (ms) */
export const MONITOR_INTERVAL_MS = 5000;

/** LaunchAgents directory on macOS */
export const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

/** Launchd plist label prefix */
export const PLIST_LABEL_PREFIX = 'com.mlb.bridge';
