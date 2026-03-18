// --- Bridge Config (persisted in workspace/config.json) ---

export interface BridgeConfig {
  name: string;
  app_id: string;
  app_secret: string;
  api_base_url: string;
  work_dir: string;
  claude: {
    mode: 'default' | 'acceptEdits' | 'bypassPermissions';
    model?: string;
    system_prompt?: string;
    allowed_tools?: string[];
  };
  stream_preview: {
    enabled: boolean;
    interval_ms: number;
    min_delta_chars: number;
    max_chars: number;
  };
  auto_start: boolean;
  bot_name?: string;
}

// --- Bridge Status (runtime, computed by Manager) ---

export interface BridgeStatus {
  name: string;
  workspace: string;
  state: 'running' | 'stopped' | 'error';
  pid?: number;
  uptime?: number;
  lastActivity?: string;
  sessionId?: string;
  autoStart: boolean;
}

// --- Session State (persisted in workspace/session.json) ---

export interface SessionState {
  agentSessionId?: string;
  workDir: string;
  lastActivity: string;
  currentMessageId?: string;
  stepCount: number;
  startTime?: number;
  steps: StepInfo[];
}

export interface StepInfo {
  tool: string;
  label: string;
}

// --- Feishu Setup ---

export interface FeishuQRInit {
  verificationUrl: string;
  deviceCode: string;
  expiresIn: number;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuValidation {
  valid: boolean;
  botName?: string;
  error?: string;
}

// --- Electron IPC Protocol ---

export interface IPCChannels {
  // Bridge management
  'bridge:list': () => BridgeStatus[];
  'bridge:start': (name: string) => void;
  'bridge:stop': (name: string) => void;
  'bridge:restart': (name: string) => void;
  'bridge:create': (config: BridgeConfig) => void;
  'bridge:delete': (name: string) => void;
  'bridge:update-config': (name: string, config: Partial<BridgeConfig>) => void;

  // Logs
  'bridge:logs': (name: string, lines?: number) => string[];
  'bridge:logs-stream': (name: string) => void;
  'bridge:logs-stop': (name: string) => void;

  // Session
  'bridge:session': (name: string) => SessionState | null;

  // Feishu setup
  'feishu:init-qr': () => FeishuQRInit;
  'feishu:poll-qr': (deviceCode: string) => FeishuCredentials | null;
  'feishu:validate': (appId: string, appSecret: string) => FeishuValidation;

  // Auto-start
  'autostart:enable': (name: string) => void;
  'autostart:disable': (name: string) => void;
  'autostart:status': (name: string) => boolean;

  // System
  'app:get-workspace-root': () => string;
}
