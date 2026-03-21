#!/usr/bin/env node
/**
 * Forge CLI — Standalone multi-agent orchestration tool.
 *
 * Usage:
 *   deepforge start --config <path>     Start a new project
 *   deepforge list                       List running projects
 *   deepforge status <id>                Show project status
 *   deepforge stop <id>                  Stop a project
 *   deepforge inject <id> <message>      Inject feedback into a running project
 */
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { ForgeEngine } from './forge-engine.js';
import type { ForgeProject } from './types.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (positionals.length === 0 && !values.help) {
  console.log(`
  DeepForge — 多 Agent 编排框架

  命令:
    deepforge start     启动项目
    deepforge list      查看所有项目
    deepforge status    查看项目详情
    deepforge stop      停止项目
    deepforge inject    注入反馈

  使用 deepforge <命令> --help 查看详细用法
`);
  process.exit(0);
}

if (values.help && positionals.length === 0) {
  console.log(`
  DeepForge — 多 Agent 编排框架

  启动一个 AI 团队，自主迭代完成复杂任务。
  每个角色是独立的 Claude Code 进程，并行执行。
  框架强制 3 个角色：Leader（规划）、Critic（找问题）、Verifier（核查）。

  命令:
    deepforge start --config <path>      启动项目（从配置文件）
    deepforge list                        列出所有项目
    deepforge status <id>                 查看项目详情
    deepforge stop <id>                   停止运行中的项目
    deepforge inject <id> "<消息>"        向运行中的项目注入反馈

  使用 deepforge <命令> --help 查看每个命令的详细参数
`);
  process.exit(0);
}

const command = positionals[0];

switch (command) {
  case 'start': {
    if (values.help) {
      console.log(`
  deepforge start — 启动一个 Forge 项目

  用法: deepforge start --config <配置文件路径>

  配置文件格式 (JSON):
    {
      "id":          "项目唯一ID",
      "title":       "项目标题",
      "description": "项目描述（Leader 会读到）",
      "roles": [
        {
          "name":         "角色代号（英文）",
          "label":        "角色显示名（中文）",
          "description":  "职责描述",
          "systemPrompt": "角色的系统提示词"
        }
      ],
      "model":        "模型名（默认 opus[1m]）",
      "effort":       "推理力度（默认 max）",
      "maxConcurrent": 5
    }

  框架自动包含 3 个强制角色（不需要配置）:
    - Leader:   每轮规划任务和总结
    - Critic:   每轮找问题、给负反馈
    - Verifier: 核查产出真实性

  示例:
    deepforge start --config ~/.forge/projects/my-research/forge-project.json
`);
      process.exit(0);
    }

    if (!values.config) {
      console.error('错误: 需要 --config <路径>，使用 deepforge start --help 查看详情');
      process.exit(1);
    }

    const configPath = resolve(values.config);
    if (!existsSync(configPath)) {
      console.error(`Config not found: ${configPath}`);
      process.exit(1);
    }

    const project: ForgeProject = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Validate
    if (!project.id || !project.title) {
      console.error('Config must have "id" and "title"');
      process.exit(1);
    }
    if (!project.roles || project.roles.length === 0) {
      console.error('Config must have at least one role in "roles"');
      process.exit(1);
    }

    project.model = project.model || 'opus[1m]';
    project.effort = project.effort || 'max';
    project.maxConcurrent = project.maxConcurrent || 5;

    console.log(`
╔══════════════════════════════════════════════════╗
║  Forge — Multi-Agent Orchestration               ║
║  Project: ${project.title.substring(0, 38).padEnd(38)} ║
║  Roles: ${String(project.roles.length).padEnd(3)} | Concurrent: ${String(project.maxConcurrent).padEnd(2)}                ║
╚══════════════════════════════════════════════════╝
`);

    const engine = new ForgeEngine(project, {
      log: (msg) => console.log(`[forge] ${msg}`),
      onNotify: (n) => {
        console.log(`[NOTIFY] ${n.from}: ${n.title} — ${n.detail}`);
      },
    });

    process.on('SIGINT', () => {
      console.log('\nStopping...');
      engine.stop();
    });
    process.on('SIGTERM', () => engine.stop());

    await engine.run();
    break;
  }

  case 'list': {
    if (values.help) {
      console.log(`
  deepforge list — 列出所有 Forge 项目

  扫描 ~/.forge/projects/ 和 ~/.deepforge/projects/，
  显示每个项目的 ID、阶段、迭代轮次。
`);
      process.exit(0);
    }
    const baseDir = join(process.env.HOME || '/tmp', '.deepforge', 'projects');
    if (!existsSync(baseDir)) {
      console.log('暂无项目。');
      break;
    }
    const { readdirSync } = await import('node:fs');
    const dirs = readdirSync(baseDir);
    for (const d of dirs) {
      const statePath = join(baseDir, d, 'forge-state.json');
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        console.log(`  ${d.padEnd(30)} phase:${state.phase.padEnd(12)} iter:${state.currentIteration} cost:$${state.totalCostUsd.toFixed(2)}`);
      }
    }
    break;
  }

  case 'status': {
    if (values.help) {
      console.log(`
  deepforge status <项目ID> — 查看项目详情

  显示项目的完整状态：阶段、迭代、每轮任务列表、token 用量。
  项目 ID 可通过 deepforge list 查看。
`);
      process.exit(0);
    }
    const id = positionals[1];
    if (!id) { console.error('用法: deepforge status <项目ID>'); process.exit(1); }
    const statePath = join(process.env.HOME || '/tmp', '.deepforge', 'projects', id, 'forge-state.json');
    if (!existsSync(statePath)) { console.error(`Project not found: ${id}`); process.exit(1); }
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    console.log(JSON.stringify(state, null, 2));
    break;
  }

  case 'inject': {
    if (values.help) {
      console.log(`
  deepforge inject <项目ID> "<消息>" — 向运行中的项目注入反馈

  消息会追加到项目的 feedback.md，Leader 下一轮迭代会读到。
  用于中途调整方向、提出新要求、回答团队的问题。

  示例:
    deepforge inject my-project "论文改成中文"
    deepforge inject my-project "重点对比和钉钉的差异"
`);
      process.exit(0);
    }
    const id = positionals[1];
    const message = positionals.slice(2).join(' ');
    if (!id || !message) { console.error('用法: deepforge inject <项目ID> "<消息>"'); process.exit(1); }
    const fbPath = join(process.env.HOME || '/tmp', '.deepforge', 'projects', id, 'feedback.md');
    appendFileSync(fbPath, `\n\n# 用户反馈 — ${new Date().toISOString()}\n${message}\n`);
    console.log(`Feedback injected into project ${id}`);
    break;
  }

  case 'stop': {
    if (values.help) {
      console.log(`
  deepforge stop <项目ID> — 停止项目

  将项目状态标记为 paused。如果进程还在运行，需要手动 kill。
`);
      process.exit(0);
    }
    const id = positionals[1];
    if (!id) { console.error('用法: deepforge stop <项目ID>'); process.exit(1); }
    const statePath = join(process.env.HOME || '/tmp', '.deepforge', 'projects', id, 'forge-state.json');
    if (!existsSync(statePath)) { console.error(`Project not found: ${id}`); process.exit(1); }
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.phase = 'paused';
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`Project ${id} marked as paused. Kill the process manually if running.`);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
