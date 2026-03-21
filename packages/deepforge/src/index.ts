#!/usr/bin/env node
/**
 * DeepForge — CLI Entry Point
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Forge } from './forge.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    daemon: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log(`
🔥 DeepForge — Autonomous Multi-Agent Research Framework

Usage:
  deepforge start --config <path>     Start a new research instance
  deepforge list                       List running instances
  deepforge status <id>                Show instance status
  deepforge stop <id>                  Stop an instance
  deepforge --help                     Show this help

Options:
  -c, --config <path>    Path to deepforge.json config file
  --daemon               Run in background (no dashboard)
  -h, --help             Show help
`);
  process.exit(0);
}

const command = positionals[0];

switch (command) {
  case 'start': {
    if (!values.config) {
      console.error('Error: --config <path> is required for start');
      process.exit(1);
    }

    const configPath = resolve(values.config);
    const config = loadConfig(configPath);

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🔥 DeepForge — Autonomous Research Framework               ║
║  Topic: ${config.research.topic.substring(0, 48).padEnd(48)} ║
║  Iterations: ${String(config.research.maxIterations).padEnd(3)} | Budget: $${String(config.limits.maxTotalCostUsd).padEnd(6)} | Agents: ${String(config.limits.maxConcurrentAgents).padEnd(2)}       ║
╚══════════════════════════════════════════════════════════════╝
`);

    const forge = new Forge(config);

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n⏸ Pausing research (finishing current task)...');
      forge.stop();
    });

    process.on('SIGTERM', () => {
      forge.stop();
    });

    await forge.run();
    break;
  }

  case 'list': {
    // TODO: Read registry.json and show running instances
    console.log('(Not yet implemented — will show running instances)');
    break;
  }

  case 'status': {
    // TODO: Show specific instance status
    console.log('(Not yet implemented)');
    break;
  }

  case 'stop': {
    // TODO: Signal a running instance to stop
    console.log('(Not yet implemented)');
    break;
  }

  default: {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}
