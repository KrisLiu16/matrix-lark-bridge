#!/usr/bin/env node

/**
 * Bridge worker entry point.
 *
 * Usage:
 *   mlb-bridge --workspace ~/mlb-workspace/my-project   (bridge worker mode)
 *   mlb-bridge mcp                                       (MCP server mode, env vars)
 */

import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    workspace: { type: 'string', short: 'w' },
  },
  allowPositionals: true,
});

if (positionals[0] === 'mcp') {
  // MCP Server mode — reads credentials from env vars
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('LARK_APP_ID and LARK_APP_SECRET env vars required');
    process.exit(1);
  }
  const apiBaseUrl = process.env.LARK_API_BASE_URL || 'https://open.feishu.cn';
  const { LarkMcpServer } = await import('./mcp-server.js');
  const server = new LarkMcpServer(appId, appSecret, apiBaseUrl);
  await server.run();
} else {
  // Bridge worker mode — requires --workspace
  if (!values.workspace) {
    console.error('Usage: mlb-bridge --workspace <path>');
    console.error('       mlb-bridge mcp');
    process.exit(1);
  }

  const { loadConfig } = await import('./config.js');
  const { Gateway } = await import('./gateway.js');

  const config = loadConfig(values.workspace);
  const gateway = new Gateway(config, values.workspace);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[bridge] shutting down...');
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await gateway.start();
  console.log(`[bridge] worker started for workspace: ${values.workspace}`);

  // Keep process alive
  await new Promise(() => {});
}
