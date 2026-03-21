#!/usr/bin/env node
/**
 * Forge CLI — Standalone multi-agent orchestration tool.
 *
 * Usage:
 *   forge start --config <path>     Start a new project
 *   forge list                       List running projects
 *   forge status <id>                Show project status
 *   forge stop <id>                  Stop a project
 *   forge inject <id> <message>      Inject feedback into a running project
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

if (values.help || positionals.length === 0) {
  console.log(`
  Forge — Multi-Agent Orchestration CLI

  Usage:
    forge start --config <path>      Start a project from config file
    forge list                        List all projects
    forge status <id>                 Show project status
    forge stop <id>                   Stop a running project
    forge inject <id> "<message>"     Inject user feedback
    forge --help                      Show this help

  Config file format (JSON):
    {
      "id": "my-project",
      "title": "Project Title",
      "description": "What to accomplish",
      "roles": [
        {"name": "researcher", "label": "研究员", "description": "...", "systemPrompt": "..."}
      ],
      "model": "opus[1m]",
      "effort": "max",
      "maxConcurrent": 5
    }
`);
  process.exit(0);
}

const command = positionals[0];

switch (command) {
  case 'start': {
    if (!values.config) {
      console.error('Error: --config <path> required');
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
    const baseDir = join(process.env.HOME || '/tmp', '.forge', 'projects');
    if (!existsSync(baseDir)) {
      console.log('No projects found.');
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
    const id = positionals[1];
    if (!id) { console.error('Usage: forge status <id>'); process.exit(1); }
    const statePath = join(process.env.HOME || '/tmp', '.forge', 'projects', id, 'forge-state.json');
    if (!existsSync(statePath)) { console.error(`Project not found: ${id}`); process.exit(1); }
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    console.log(JSON.stringify(state, null, 2));
    break;
  }

  case 'inject': {
    const id = positionals[1];
    const message = positionals.slice(2).join(' ');
    if (!id || !message) { console.error('Usage: forge inject <id> "<message>"'); process.exit(1); }
    const fbPath = join(process.env.HOME || '/tmp', '.forge', 'projects', id, 'feedback.md');
    appendFileSync(fbPath, `\n\n# 用户反馈 — ${new Date().toISOString()}\n${message}\n`);
    console.log(`Feedback injected into project ${id}`);
    break;
  }

  case 'stop': {
    const id = positionals[1];
    if (!id) { console.error('Usage: forge stop <id>'); process.exit(1); }
    const statePath = join(process.env.HOME || '/tmp', '.forge', 'projects', id, 'forge-state.json');
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
