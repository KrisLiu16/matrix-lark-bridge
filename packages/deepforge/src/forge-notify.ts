/**
 * Forge Notifications — Async non-blocking notifications to user.
 * CC writes to pending/, Forge sends to Feishu, user replies go to resolved/.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface ForgeNotification {
  id: string;
  from: string;          // role name
  type: 'question' | 'info' | 'action_needed';
  title: string;
  detail: string;
  blocking: boolean;     // false = don't block, just inform
  createdAt: string;
  userReply?: string;
  resolvedAt?: string;
}

export class ForgeNotifier {
  private workDir: string;
  private pendingDir: string;
  private sentDir: string;
  private resolvedDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.pendingDir = join(workDir, 'notifications', 'pending');
    this.sentDir = join(workDir, 'notifications', 'sent');
    this.resolvedDir = join(workDir, 'notifications', 'resolved');
    for (const d of [this.pendingDir, this.sentDir, this.resolvedDir]) {
      mkdirSync(d, { recursive: true });
    }
  }

  /** Scan pending notifications, return them for sending */
  getPending(): ForgeNotification[] {
    try {
      const files = readdirSync(this.pendingDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        const data = JSON.parse(readFileSync(join(this.pendingDir, f), 'utf-8'));
        return data as ForgeNotification;
      });
    } catch {
      return [];
    }
  }

  /** Mark a notification as sent (move pending → sent) */
  markSent(id: string): void {
    const src = join(this.pendingDir, `${id}.json`);
    const dst = join(this.sentDir, `${id}.json`);
    if (existsSync(src)) renameSync(src, dst);
  }

  /** Resolve a notification with user reply (move sent → resolved) */
  resolve(id: string, reply: string): void {
    const src = join(this.sentDir, `${id}.json`);
    if (!existsSync(src)) return;
    const data: ForgeNotification = JSON.parse(readFileSync(src, 'utf-8'));
    data.userReply = reply;
    data.resolvedAt = new Date().toISOString();
    const dst = join(this.resolvedDir, `${id}.json`);
    // Write resolved version first, then remove sent
    writeFileSync(dst, JSON.stringify(data, null, 2));
    try { unlinkSync(src); } catch { /* ignore */ }
  }

  /** Get all resolved notifications (for Leader to read) */
  getResolved(): ForgeNotification[] {
    try {
      const files = readdirSync(this.resolvedDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        const data = JSON.parse(readFileSync(join(this.resolvedDir, f), 'utf-8'));
        return data as ForgeNotification;
      });
    } catch {
      return [];
    }
  }

  /** Get count of pending + sent (unresolved) notifications */
  unresolvedCount(): number {
    const pending = readdirSync(this.pendingDir).filter(f => f.endsWith('.json')).length;
    const sent = readdirSync(this.sentDir).filter(f => f.endsWith('.json')).length;
    return pending + sent;
  }
}
