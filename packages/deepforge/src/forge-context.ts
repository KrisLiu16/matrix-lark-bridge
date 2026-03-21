/**
 * Forge Context — Progressive disclosure prompt builder.
 * 3-layer context: overview (always) → work (role-relevant) → detail (on-demand).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeTask, ForgeProject } from './types.js';

function safe(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf-8').trim() : ''; }
  catch { return ''; }
}

function listFiles(dir: string): string[] {
  try { return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter(f => !f.startsWith('.')) : []; }
  catch { return []; }
}

export function buildForgePrompt(
  role: string,
  task: ForgeTask,
  project: ForgeProject,
  workDir: string,
  iteration: number,
): string {
  const parts: string[] = [];

  // === Layer 0: Always included ===
  const brief = safe(join(workDir, 'brief.md'));
  if (brief) parts.push(`## 项目简介\n${brief}`);

  const status = safe(join(workDir, 'status.md'));
  if (status) parts.push(`## 当前状态\n${status}`);

  const index = safe(join(workDir, 'index.md'));
  if (index) {
    const lines = index.split('\n').filter(l => l.trim()).length;
    parts.push(`## 产出索引（${lines} 条）\n${index}`);
  }

  // === Layer 1: Role-relevant ===
  const myReport = safe(join(workDir, 'reports', `${role}-report.md`));
  if (myReport) parts.push(`## 你上一次的汇报\n${myReport}`);

  const plan = safe(join(workDir, 'iterations', String(iteration).padStart(3, '0'), 'plan.md'));
  if (plan) parts.push(`## 本轮计划\n${plan}`);

  // Leader sees all reports
  if (role === 'leader') {
    for (const r of project.roles) {
      if (r.name === 'leader') continue;
      const report = safe(join(workDir, 'reports', `${r.name}-report.md`));
      if (report) parts.push(`## ${r.label} 汇报\n${report}`);
    }
    const criticReport = safe(join(workDir, 'reports', 'critic-report.md'));
    if (criticReport) parts.push(`## Critic 汇报\n${criticReport}`);

    const iterLog = safe(join(workDir, 'iteration-log.md'));
    if (iterLog) parts.push(`## 迭代日志\n${iterLog}`);
  }

  // All roles see feedback (Critic's negative feedback + user requirements)
  const feedback = safe(join(workDir, 'feedback.md'));
  if (feedback) parts.push(`## 反馈（Critic + 用户）\n${feedback}`);

  // === Layer 2: File listing (Agent reads on demand) ===
  const files = listFiles(join(workDir, 'artifacts'));
  if (files.length > 0) {
    parts.push(`## 可用文件（用 Read 工具按需查看）\n${files.map(f => `- artifacts/${f}`).join('\n')}`);
  }

  // === Task ===
  parts.push(`## 你的任务\nID: ${task.id}\n优先级: ${task.priority}\n\n${task.description}`);
  parts.push(`## 工作目录\n${workDir}\n所有产出保存在此目录内。`);

  return parts.join('\n\n---\n\n');
}
