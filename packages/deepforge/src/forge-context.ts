/**
 * Forge Context — Progressive disclosure prompt builder.
 * 3-layer context: overview (always) → work (role-relevant) → detail (on-demand).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeTask, ForgeProject } from './types.js';

/** Max chars per file read to prevent context bloat */
const MAX_FILE_CHARS = 4000;

function safe(path: string, maxChars = MAX_FILE_CHARS): string {
  try {
    if (!existsSync(path)) return '';
    const content = readFileSync(path, 'utf-8').trim();
    if (content.length <= maxChars) return content;
    return content.substring(0, maxChars) + '\n\n...(truncated, use Read tool for full content)';
  } catch { return ''; }
}

/** Read file but only keep the last N sections (split by ## headings) */
function safeTail(path: string, maxSections: number): string {
  try {
    if (!existsSync(path)) return '';
    const content = readFileSync(path, 'utf-8').trim();
    const sections = content.split(/(?=^## )/m);
    if (sections.length <= maxSections) return content;
    const kept = sections.slice(-maxSections);
    return `...(${sections.length - maxSections} earlier sections omitted)\n\n` + kept.join('');
  } catch { return ''; }
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

    const verifierReport = safe(join(workDir, 'reports', 'verifier-report.md'));
    if (verifierReport) parts.push(`## Verifier 核查结果\n${verifierReport}`);

    // Inject previous iteration task summaries so Leader has full context
    const prevIterSummary = buildPreviousIterSummary(workDir, iteration);
    if (prevIterSummary) parts.push(`## 上轮任务完成摘要\n${prevIterSummary}`);

    // Only keep last 5 iterations to prevent context bloat
    const iterLog = safeTail(join(workDir, 'iteration-log.md'), 5);
    if (iterLog) parts.push(`## 迭代日志（近 5 轮）\n${iterLog}`);
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

/** Build a summary of previous iteration's completed tasks for Leader context */
function buildPreviousIterSummary(workDir: string, currentIteration: number): string {
  if (currentIteration <= 1) return '';
  const statePath = join(workDir, 'forge-state.json');
  try {
    if (!existsSync(statePath)) return '';
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const prevIter = state.iterations?.find((i: any) => i.number === currentIteration - 1);
    if (!prevIter || !prevIter.tasks?.length) return '';

    const lines: string[] = [];
    for (const t of prevIter.tasks) {
      const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
      const dur = t.durationMs ? `${Math.round(t.durationMs / 1000)}s` : '?';
      const desc = (t.description || '').substring(0, 100);
      lines.push(`- ${icon} **${t.id}**（${t.role}，${dur}）: ${desc}${t.error ? ` [错误: ${t.error.substring(0, 80)}]` : ''}`);
    }
    const completed = prevIter.tasks.filter((t: any) => t.status === 'completed').length;
    const failed = prevIter.tasks.filter((t: any) => t.status === 'failed').length;
    lines.unshift(`迭代 ${currentIteration - 1}：${completed} 完成，${failed} 失败，共 ${prevIter.tasks.length} 任务\n`);
    return lines.join('\n');
  } catch { return ''; }
}
