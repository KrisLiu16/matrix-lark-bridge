import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.local.json');

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  [key: string]: unknown;
}

function readSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: ClaudeSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Build a permission pattern from tool name and input.
 * Examples:
 *   Bash {command: "curl https://example.com"} → "Bash(curl:*)"
 *   Read {file_path: "/Users/x/foo.ts"}        → "Read(/Users/x/**)"
 *   WebFetch {url: "https://example.com/foo"}   → "WebFetch(domain:example.com)"
 *   Other                                       → "ToolName(*)"
 */
export function buildPermissionPattern(toolName: string, toolInput?: Record<string, unknown>): string {
  if (!toolInput) return `${toolName}(*)`;

  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '').trim();
    const firstWord = cmd.split(/\s+/)[0] || '*';
    return `${toolName}(${firstWord}:*)`;
  }

  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    const filePath = String(toolInput.file_path || '');
    if (filePath) {
      // Use the directory as pattern base
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      return `${toolName}(${dir}/**)`;
    }
  }

  if (toolName === 'WebFetch') {
    const url = String(toolInput.url || '');
    try {
      const hostname = new URL(url).hostname;
      return `${toolName}(domain:${hostname})`;
    } catch { /* ignore */ }
  }

  // MCP tools don't support parentheses patterns — use bare tool name
  if (toolName.startsWith('mcp__')) {
    return toolName;
  }

  return `${toolName}(*)`;
}

/**
 * Add a permission pattern to ~/.claude/settings.local.json (deduped).
 */
export function addAllowedPermission(pattern: string): void {
  const settings = readSettings();
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  if (!settings.permissions.allow.includes(pattern)) {
    settings.permissions.allow.push(pattern);
    writeSettings(settings);
    console.log(`[claude-settings] added permission: ${pattern}`);
  }
}

/**
 * Check if a tool call is allowed by ~/.claude/settings.local.json permissions.
 */
export function isPermissionAllowed(toolName: string, toolInput?: Record<string, unknown>): boolean {
  const settings = readSettings();
  const allowed = settings.permissions?.allow;
  if (!allowed?.length) return false;

  for (const pattern of allowed) {
    if (matchPermission(pattern, toolName, toolInput)) return true;
  }
  return false;
}

/**
 * Match a permission pattern against a tool call.
 * Pattern format: "ToolName(value)"
 */
function matchPermission(pattern: string, toolName: string, toolInput?: Record<string, unknown>): boolean {
  // MCP tools are stored as bare names (no parentheses)
  if (pattern.startsWith('mcp__')) {
    return pattern === toolName;
  }

  const match = pattern.match(/^(\w+)\((.+)\)$/);
  if (!match) return false;

  const [, patternTool, patternValue] = match;
  if (patternTool !== toolName) return false;

  // Wildcard — allow everything for this tool
  if (patternValue === '*') return true;

  if (toolName === 'Bash' && toolInput?.command) {
    const cmd = String(toolInput.command).trim();
    const firstWord = cmd.split(/\s+/)[0];

    // Pattern like "Bash(curl:*)" — match first word
    if (patternValue.endsWith(':*')) {
      const prefix = patternValue.slice(0, -2);
      return firstWord === prefix;
    }
  }

  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && toolInput?.file_path) {
    const filePath = String(toolInput.file_path);

    // Pattern like "Read(/Users/x/**)" — match path prefix
    if (patternValue.endsWith('/**')) {
      const dir = patternValue.slice(0, -3);
      return filePath.startsWith(dir + '/');
    }
  }

  if (toolName === 'WebFetch' && toolInput?.url) {
    // Pattern like "WebFetch(domain:example.com)"
    if (patternValue.startsWith('domain:')) {
      const domain = patternValue.slice(7);
      try {
        return new URL(String(toolInput.url)).hostname === domain;
      } catch {
        return false;
      }
    }
  }

  return false;
}
