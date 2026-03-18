import { readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');

export interface LocalSession {
  id: string;
  project: string;       // project dir name
  cwd: string;            // working directory
  firstMessage: string;   // first user message (truncated)
  timestamp: string;      // ISO timestamp
}

/**
 * Scan all local Claude Code sessions from ~/.claude/projects/
 * Returns sessions sorted by most recent first.
 */
export async function scanLocalSessions(limit = 20): Promise<LocalSession[]> {
  const sessions: LocalSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(CLAUDE_DIR);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(CLAUDE_DIR, projectDir);
    let files: string[];
    try {
      files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(projectPath, file);

      try {
        const info = parseSessionHead(filePath);
        sessions.push({
          id: sessionId,
          project: projectDir,
          cwd: info.cwd,
          firstMessage: info.firstMessage,
          timestamp: info.timestamp,
        });
      } catch {
        // Skip unparseable files
      }
    }
  }

  // Sort by timestamp descending (most recent first)
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions.slice(0, limit);
}

/**
 * Read only the head of a JSONL file (first ~4KB) to avoid loading
 * entire session files which can be 10+ MB.
 */
function readHead(filePath: string, maxBytes = 4096): string[] {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return [];
  }

  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    const content = buf.toString('utf-8', 0, bytesRead);
    // Take only complete lines (drop partial last line)
    const lines = content.split('\n');
    if (!content.endsWith('\n')) lines.pop();
    return lines.slice(0, 10);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

function parseSessionHead(filePath: string): {
  cwd: string;
  firstMessage: string;
  timestamp: string;
} {
  // Read only the first ~4KB to extract metadata from the first few lines
  const lines = readHead(filePath);

  let timestamp = '';
  let cwd = '';
  let firstMessage = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);

      // Get timestamp from first line
      if (!timestamp && data.timestamp) {
        timestamp = data.timestamp;
      }

      // Get first user message
      if (data.type === 'user' && data.message?.content) {
        cwd = data.cwd || '';
        const msgContent = data.message.content;
        firstMessage = typeof msgContent === 'string'
          ? msgContent.substring(0, 60)
          : JSON.stringify(msgContent).substring(0, 60);
        break;
      }

      // Fallback: queue-operation has content
      if (data.type === 'queue-operation' && data.operation === 'enqueue' && data.content) {
        firstMessage = String(data.content).substring(0, 60);
        if (!timestamp) timestamp = data.timestamp || '';
      }
    } catch {
      continue;
    }
  }

  return { cwd, firstMessage, timestamp };
}
