import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { SessionState, StepInfo } from './types.js';
import { SESSION_FILE } from '@mlb/shared';

export class SessionStore {
  private state: SessionState;
  private filePath: string;
  private busy = false;

  /**
   * @param workspace — the bridge workspace directory (e.g., ~/mlb-workspace/my-project)
   * @param defaultWorkDir — the Claude Code working directory
   */
  constructor(workspace: string, defaultWorkDir: string) {
    this.filePath = join(workspace, SESSION_FILE);
    this.state = {
      workDir: defaultWorkDir,
      lastActivity: new Date().toISOString(),
      stepCount: 0,
      steps: [],
    };
    this.load();
  }

  // --- Read/Write ---

  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<SessionState>;
      if (data.agentSessionId !== undefined) this.state.agentSessionId = data.agentSessionId;
      if (data.workDir) this.state.workDir = data.workDir;
      if (data.lastActivity) this.state.lastActivity = data.lastActivity;
      if (data.currentMessageId) this.state.currentMessageId = data.currentMessageId;
      if (typeof data.stepCount === 'number') this.state.stepCount = data.stepCount;
      if (typeof data.startTime === 'number') this.state.startTime = data.startTime;
      if (Array.isArray(data.steps)) this.state.steps = data.steps;
      if (Array.isArray(data.history)) this.state.history = data.history;
      if (typeof data.noticeMode === 'boolean') this.state.noticeMode = data.noticeMode;
      if (typeof data.contextLimit === 'number') this.state.contextLimit = data.contextLimit;
      console.log(`[session-store] loaded: agentSessionId=${this.state.agentSessionId || 'none'}`);
    } catch (err) {
      console.warn('[session-store] load error:', err);
    }
  }

  save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn('[session-store] save error:', err);
    }
  }

  // --- State access ---

  getState(): SessionState {
    return this.state;
  }

  setAgentSessionId(id: string | undefined): void {
    this.state.agentSessionId = id;
    this.state.lastActivity = new Date().toISOString();
    this.save();
  }

  setWorkDir(dir: string): void {
    this.state.workDir = dir;
    this.state.lastActivity = new Date().toISOString();
    this.save();
  }

  // --- Card state management ---

  resetTurn(): void {
    this.state.stepCount = 0;
    this.state.steps = [];
    this.state.startTime = Math.floor(Date.now() / 1000);
    this.state.currentMessageId = undefined;
  }

  setMessageId(id: string): void {
    this.state.currentMessageId = id;
    this.save();
  }

  addStep(step: StepInfo): void {
    this.state.steps.push(step);
    if (this.state.steps.length > 200) {
      this.state.steps = this.state.steps.slice(-200);
    }
  }

  addHistory(role: 'user' | 'assistant', content: string): void {
    if (!this.state.history) {
      this.state.history = [];
    }
    this.state.history.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });
    // Keep max 100 entries
    if (this.state.history.length > 100) {
      this.state.history = this.state.history.slice(-100);
    }
    this.save();
  }

  incrementStepCount(): number {
    this.state.stepCount++;
    return this.state.stepCount;
  }

  // --- Lock ---

  tryLock(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  unlock(): void {
    this.busy = false;
  }
}
