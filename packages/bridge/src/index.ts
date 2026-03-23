#!/usr/bin/env node

/**
 * Bridge worker entry point.
 *
 * Usage:
 *   mlb-bridge --workspace ~/mlb-workspace/my-project   (bridge worker mode)
 *   mlb-bridge mcp                                       (MCP server mode, env vars)
 */

// Patch console to prepend timestamps (DD HH:mm:ss)
const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;
function ts() {
  const d = new Date();
  const DD = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${DD} ${HH}:${mm}:${ss}`;
}
console.log = (...args: unknown[]) => _origLog(`[${ts()}]`, ...args);
console.error = (...args: unknown[]) => _origErr(`[${ts()}]`, ...args);
console.warn = (...args: unknown[]) => _origWarn(`[${ts()}]`, ...args);

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

  // Feishu gateway is optional — only create when credentials are provided
  let gateway: InstanceType<typeof Gateway> | undefined;
  if (config.app_id && config.app_secret) {
    gateway = new Gateway(config, values.workspace);
  }

  // --- WeChat channel (optional, parallel to Feishu) ---
  let wechatChannel: import('./wechat/wechat.js').WechatChannel | null = null;
  let wechatGateway: import('./wechat/gateway-integration.js').WechatGateway | null = null;

  if (config.wechat) {
    console.log('[bridge] wechat config detected, initializing wechat channel...');
    const { ILinkClient, ILinkAuth } = await import('@mlb/wechat-sdk');
    const { WechatChannel } = await import('./wechat/wechat.js');
    const { WechatGateway } = await import('./wechat/gateway-integration.js');
    const { ClaudeSession } = await import('./claude-session.js');
    const { SessionStore } = await import('./session-store.js');

    const client = new ILinkClient({
      token: config.wechat.bot_token || undefined,
    });
    const auth = new ILinkAuth();

    // Session store for WeChat (separate from Feishu, same workspace)
    const wechatStore = new SessionStore(values.workspace, config.work_dir);

    // WechatGateway config
    const wechatGwConfig: import('./wechat/gateway-integration.js').WechatGatewayConfig = {
      workDir: config.work_dir,
      botName: config.bot_name,
      maxQueue: config.max_queue,
    };

    // Create WechatChannel with callbacks wired to WechatGateway
    wechatChannel = new WechatChannel(client, auth, config.wechat, {
      onMessage: (msg) => wechatGateway?.handleMessage(msg),
      onStateChange: (state) => console.log(`[wechat] state: ${state}`),
      onError: (err) => console.error('[wechat] channel error:', err.message),
    });

    // ClaudeSession factory for WechatGateway (duck-typed to IClaudeSession)
    const sessionFactory: import('./wechat/gateway-integration.js').ClaudeSessionFactory = {
      create: (opts) => {
        const cs = new ClaudeSession(
          {
            workDir: opts.workDir,
            mode: config.claude.mode,
            model: config.claude.model,
            effort: config.claude.effort,
            systemPrompt: opts.systemPrompt,
            allowedTools: config.claude.allowed_tools,
            resumeSessionId: opts.resumeSessionId,
            env: config.claude.env
              ? Object.fromEntries(Object.entries(config.claude.env).filter((e): e is [string, string] => e[1] !== undefined))
              : undefined,
          },
          { onEvent: () => {} },
        );
        return cs as import('./wechat/gateway-integration.js').IClaudeSession;
      },
    };

    // WechatGateway — routes WeChat messages to Claude Code sessions
    wechatGateway = new WechatGateway(
      sessionFactory,
      wechatStore as import('./wechat/gateway-integration.js').ISessionStore,
      {
        sendTextReply: (userId, ctx, text) => wechatChannel!.sendTextReply(userId, ctx, text),
        sendTyping: (userId, ctx) => wechatChannel!.sendTyping(userId, ctx),
        sendImageReply: (userId, ctx, data) => wechatChannel!.sendImageReply(userId, ctx, data),
        sendFileReply: (userId, ctx, data, name) => wechatChannel!.sendFileReply(userId, ctx, data, name),
      },
      wechatGwConfig,
    );
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[bridge] shutting down...');
    await Promise.all([
      gateway?.stop(),
      wechatGateway?.stop(),
      wechatChannel?.stop(),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start Feishu gateway (if configured)
  if (gateway) {
    await gateway.start();
    console.log('[bridge] feishu gateway started');
  }
  console.log(`[bridge] worker started for workspace: ${values.workspace}`);

  // Start WeChat channel (if configured)
  if (wechatChannel) {
    try {
      await wechatChannel.start();
      console.log('[bridge] wechat channel started');
    } catch (err) {
      console.error('[bridge] wechat channel start failed:', (err as Error).message);
      // Non-fatal — Feishu gateway continues working
    }
  }

  // Keep process alive
  await new Promise(() => {});
}
