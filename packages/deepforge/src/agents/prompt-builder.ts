/**
 * DeepForge — Prompt Builder
 *
 * Progressive disclosure: Layer 0 (always) → Layer 1 (role-relevant) → Layer 2 (listed, read on demand)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskState, AgentRole } from '../types.js';
import type { ForgeStateManager } from '../state/forge-state.js';

function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8').trim() : '';
  } catch {
    return '';
  }
}

function listDir(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.c') || f.endsWith('.py')) : [];
  } catch {
    return [];
  }
}

export function buildPrompt(task: TaskState, stateManager: ForgeStateManager): string {
  const dir = stateManager.outputDir;
  const iterNum = stateManager.state.currentIteration;
  const iterDir = join(dir, 'iterations', String(iterNum).padStart(3, '0'));
  const parts: string[] = [];

  // ========== Layer 0: Always included (overview) ==========

  const brief = safeRead(join(dir, 'research-brief.md'));
  if (brief) {
    parts.push(`## Research Brief\n${brief}`);
  }

  const status = safeRead(join(dir, 'research-status.md'));
  if (status) {
    parts.push(`## Research Status\n${status}`);
  }

  const index = safeRead(join(dir, 'findings-index.md'));
  if (index) {
    const lineCount = index.split('\n').filter(l => l.trim()).length;
    parts.push(`## Findings Index (${lineCount} items)\n${index}`);
  }

  // ========== Layer 1: Role-relevant (automatic) ==========

  // Own previous report (continuity)
  const myReport = safeRead(join(dir, 'reports', `${task.role}-report.md`));
  if (myReport) {
    parts.push(`## Your Previous Report\n${myReport}`);
  }

  // Current iteration plan
  const plan = safeRead(join(iterDir, 'plan.md'));
  if (plan) {
    parts.push(`## Current Iteration Plan\n${plan}`);
  }

  // Role-specific context
  if (task.role === 'leader') {
    // Leader sees ALL member reports
    const reportDir = join(dir, 'reports');
    const roles: AgentRole[] = ['scout', 'ideator', 'coder', 'bench', 'writer', 'verifier', 'reviewer'];
    for (const role of roles) {
      const report = safeRead(join(reportDir, `${role}-report.md`));
      if (report) {
        parts.push(`## ${role} Report\n${report}`);
      }
    }

    // Leader sees iteration log (strategic memory)
    const iterLog = safeRead(join(dir, 'iteration-log.md'));
    if (iterLog) {
      parts.push(`## Iteration Log\n${iterLog}`);
    }
  }

  if (task.role === 'writer' || task.role === 'leader') {
    const feedback = safeRead(join(dir, 'review-feedback.md'));
    if (feedback) {
      parts.push(`## Review Feedback\n${feedback}`);
    }
  }

  if (task.role === 'verifier') {
    const writerReport = safeRead(join(dir, 'reports', 'writer-report.md'));
    if (writerReport) {
      parts.push(`## Writer Report (what was changed)\n${writerReport}`);
    }
  }

  // ========== Layer 2: Listed files (Agent reads on demand) ==========

  const availableFiles: string[] = [];
  for (const subdir of ['research', 'ideas', 'code', 'data', 'figures', 'paper']) {
    const files = listDir(join(dir, subdir));
    for (const f of files) {
      availableFiles.push(`${subdir}/${f}`);
    }
  }

  if (availableFiles.length > 0) {
    parts.push(`## Available Files (use Read tool to access as needed)\n${availableFiles.map(f => `- ${f}`).join('\n')}`);
  }

  // ========== Task Description ==========

  parts.push(`## Your Task\nTask ID: ${task.id}\nPriority: ${task.priority}\n\n${task.description}`);

  if (task.context) {
    parts.push(`## Context\n${task.context}`);
  }

  // Working directory reminder
  parts.push(`## Working Directory\n${dir}\nSave all outputs within this directory.`);

  return parts.join('\n\n---\n\n');
}
