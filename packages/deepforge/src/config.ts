/**
 * DeepForge — Configuration Loader
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeepForgeConfig, AgentConfig, AgentRole, AGENT_ROLES } from './types.js';

const DEFAULT_AGENT: AgentConfig = {
  enabled: true,
  model: 'claude-opus-4-6',
  effort: 'high',
  timeoutMs: 30 * 60_000,
};

const MLB_CLAUDE_PATH = join(homedir(), '.mlb', 'bin', 'claude');

export function loadConfig(configPath: string): DeepForgeConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (!raw.research?.topic) throw new Error('research.topic is required');
  if (!raw.research?.outputDir) throw new Error('research.outputDir is required');

  const expandHome = (p: string) => p.replace(/^~/, homedir());

  const outputDir = expandHome(raw.research.outputDir);
  const workDir = expandHome(raw.research.workDir || raw.research.outputDir);

  // Build agent configs with defaults
  const agents: Record<string, AgentConfig> = {};
  const roleNames: AgentRole[] = ['leader', 'scout', 'ideator', 'coder', 'bench', 'writer', 'verifier', 'reviewer'];
  for (const role of roleNames) {
    const userCfg = raw.agents?.[role] || {};
    agents[role] = {
      ...DEFAULT_AGENT,
      ...userCfg,
      // Writer defaults to sonnet for cost efficiency
      model: userCfg.model || (role === 'writer' ? 'sonnet' : DEFAULT_AGENT.model),
    };
  }

  return {
    research: {
      topic: raw.research.topic,
      description: raw.research.description || '',
      maxIterations: raw.research.maxIterations ?? 5,
      outputDir,
      workDir,
    },
    agents: agents as Record<AgentRole, AgentConfig>,
    limits: {
      maxTotalCostUsd: raw.limits?.maxTotalCostUsd ?? 100,
      maxIterationCostUsd: raw.limits?.maxIterationCostUsd ?? 25,
      maxConcurrentAgents: raw.limits?.maxConcurrentAgents ?? 3,
    },
    feishu: raw.feishu ? {
      appId: raw.feishu.appId,
      appSecret: raw.feishu.appSecret,
      apiBaseUrl: raw.feishu.apiBaseUrl ?? 'https://open.feishu.cn',
      reportChatId: raw.feishu.reportChatId,
      reportIntervalMinutes: raw.feishu.reportIntervalMinutes ?? 30,
    } : undefined,
    claude: {
      binaryPath: raw.claude?.binaryPath || process.env.CLAUDE_PATH || MLB_CLAUDE_PATH,
      env: {
        // Inherit critical API env vars from current process
        ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
        ...(process.env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN } : {}),
        ...(process.env.ANTHROPIC_CUSTOM_HEADERS ? { ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS } : {}),
        // User overrides
        ...(raw.claude?.env || {}),
      },
    },
  };
}
