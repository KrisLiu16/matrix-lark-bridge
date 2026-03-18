import type { BridgeConfig } from './config.js';
import type { AgentEvent, ImageAttachment, StepInfo } from './types.js';
import { FeishuClient } from './feishu.js';
import { ClaudeSession, type ClaudeSessionCallbacks } from './claude-session.js';
import { SessionStore } from './session-store.js';
import { StreamPreview } from './streaming.js';
import {
  buildThinkingCard,
  buildWorkingCard,
  buildDoneCard,
  buildPermissionCard,
  buildPermissionResultCard,
  toFeishuMarkdown,
  toolDisplay,
  toolLabel,
  isFiltered,
} from './card.js';
import { isPermissionAllowed, addAllowedPermission, buildPermissionPattern } from './claude-settings.js';
import { scanLocalSessions } from './sessions-scanner.js';

// --- Constants ---

/** Maximum time to wait for processEvents to resolve before timing out (ms) */
const PROCESS_EVENTS_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum retries when session dies immediately */
const MAX_RETRIES = 1;

// --- Helpers ---

function formatTime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '\n...(truncated)';
}

export class Gateway {
  private feishu: FeishuClient;
  private session: ClaudeSession | null = null;
  private store: SessionStore;
  private config: BridgeConfig;
  private workspace: string;
  private pendingPermissions = new Map<string, {
    resolve: (result: { behavior: 'allow' | 'deny' }) => void;
    toolName?: string;
    toolInputRaw?: Record<string, unknown>;
  }>();
  private botName: string;
  private updateQueue: Promise<void> = Promise.resolve();

  /** Enqueue a card update so rapid events are serialized */
  private queueCardUpdate(fn: () => Promise<void>): void {
    this.updateQueue = this.updateQueue.then(fn).catch(err => console.error('[gateway] card update error:', err));
  }

  constructor(config: BridgeConfig, workspace: string) {
    this.config = config;
    this.workspace = workspace;
    this.feishu = new FeishuClient(config.app_id, config.app_secret, config.api_base_url);
    this.store = new SessionStore(workspace, config.work_dir);
    this.botName = config.bot_name || 'MiniMax AI';
  }

  async start(): Promise<void> {
    // Fetch bot name from API
    const name = await this.feishu.getBotName();
    if (name) this.botName = name;
    console.log(`[gateway] bot name: ${this.botName}`);

    // Start WebSocket
    await this.feishu.start(
      (content, images, chatId, messageId) => {
        this.handleMessage(content, images, chatId, messageId).catch(err => {
          console.error('[gateway] handleMessage error:', err);
        });
      },
      (action, chatId, userId) => {
        return this.handleCardAction(action, chatId, userId);
      },
    );

    console.log('[gateway] ready');
  }

  // --- Message handling ---

  private async handleMessage(content: string, images: ImageAttachment[], chatId: string, messageId: string): Promise<void> {
    console.log(`[gateway] handleMessage: content="${content.substring(0, 50)}" chatId=${chatId}`);

    // Check for slash commands
    if (content.startsWith('/')) {
      const parts = content.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const handled = await this.handleCommand(cmd, parts.slice(1), chatId);
      if (handled) return;
    }

    // Handle pending permission text responses
    const lowerContent = content.toLowerCase().trim();
    if (lowerContent === 'allow' || lowerContent === 'deny' || lowerContent === 'y' || lowerContent === 'n') {
      const pending = this.findPendingPermission();
      if (pending) {
        const behavior = (lowerContent === 'allow' || lowerContent === 'y') ? 'allow' as const : 'deny' as const;
        pending.entry.resolve({ behavior });
        this.pendingPermissions.delete(pending.requestId);
        await this.feishu.sendText(chatId, behavior === 'allow' ? '✅ Allowed, continuing...' : '❌ Denied');
        return;
      }
    }

    // Try lock (prevent concurrent messages)
    if (!this.store.tryLock()) {
      await this.feishu.sendText(chatId, '⏳ Processing previous message, please wait...');
      return;
    }

    // Start typing indicator
    const stopTyping = this.feishu.startTyping(messageId);

    try {
      // Reset turn state and send ThinkingCard
      this.store.resetTurn();
      const thinkingCard = buildThinkingCard(content, this.botName);
      const cardMsgId = await this.feishu.sendCard(chatId, thinkingCard);
      if (cardMsgId) {
        this.store.setMessageId(cardMsgId);
      }

      // Start or resume Claude session and send message
      await this.ensureSession();
      await this.requireSession().send(content, images.length > 0 ? images : undefined);

      // Process events (with retry on immediate session death)
      let retries = 0;
      let needsRetry = await this.processEvents(chatId);
      while (needsRetry && retries < MAX_RETRIES) {
        retries++;
        console.log(`[gateway] retrying with fresh session (attempt ${retries}/${MAX_RETRIES})`);
        this.store.setAgentSessionId(undefined);
        await this.session?.close();
        this.session = null;
        await this.ensureSession();
        await this.requireSession().send(content, images.length > 0 ? images : undefined);
        needsRetry = await this.processEvents(chatId);
      }
      if (needsRetry) {
        // All retries exhausted — update card to error state
        const msgId = this.store.getState().currentMessageId;
        if (msgId) {
          const errorCard = buildDoneCard('Session failed after retries. Please try again.', [], 0, '0s', this.botName, '');
          await this.feishu.updateCard(msgId, errorCard);
        }
      }
    } catch (err) {
      console.error('[gateway] error:', err);
      await this.feishu.sendText(chatId, `❌ Error: ${(err as Error).message}`).catch(() => {});
    } finally {
      stopTyping();
      this.store.unlock();
    }
  }

  /** Returns this.session or throws if null. Use after ensureSession(). */
  private requireSession(): ClaudeSession {
    if (!this.session) {
      throw new Error('Failed to create Claude session');
    }
    return this.session;
  }

  /**
   * Ensures a live session exists. After this call, this.session is guaranteed non-null and alive.
   * Events are buffered internally until setCallbacks() is called (see C-1 fix).
   */
  private async ensureSession(): Promise<void> {
    if (this.session && this.session.alive()) return;

    const state = this.store.getState();
    const resumeId = state.agentSessionId;
    console.log(`[gateway] starting session, resumeId=${resumeId || 'none'}, workDir=${state.workDir}`);

    // Build MCP config for lark server — use the bridge binary in this workspace
    const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
      lark: {
        command: process.execPath,
        args: [process.argv[1], 'mcp'],
        env: {
          LARK_APP_ID: this.config.app_id,
          LARK_APP_SECRET: this.config.app_secret,
          LARK_API_BASE_URL: this.config.api_base_url,
        },
      },
    };

    // Use a buffering no-op callback; real handler is attached via setCallbacks() in processEvents
    const callbacks: ClaudeSessionCallbacks = {
      onEvent: () => {},
    };

    try {
      this.session = new ClaudeSession({
        workDir: state.workDir,
        mode: this.config.claude.mode,
        model: this.config.claude.model,
        allowedTools: this.config.claude.allowed_tools,
        systemPrompt: this.config.claude.system_prompt,
        resumeSessionId: resumeId,
        mcpServers,
      }, callbacks);
      await this.session.start();
    } catch (err) {
      // Resume failed, try fresh
      if (resumeId) {
        console.warn(`[gateway] resume failed: ${(err as Error).message}, starting fresh`);
        this.store.setAgentSessionId(undefined);
        this.session = new ClaudeSession({
          workDir: state.workDir,
          mode: this.config.claude.mode,
          model: this.config.claude.model,
          allowedTools: this.config.claude.allowed_tools,
          systemPrompt: this.config.claude.system_prompt,
          mcpServers,
        }, callbacks);
        await this.session.start();
      } else {
        this.session = null;
        throw err;
      }
    }
  }

  /** Returns true if session died immediately and should be retried with fresh session */
  private async processEvents(chatId: string): Promise<boolean> {
    const streamConfig = this.config.stream_preview;
    let streamPreview: StreamPreview | null = null;

    if (streamConfig.enabled) {
      streamPreview = new StreamPreview(streamConfig, this.feishu, chatId);
    }

    // Capture session reference to detect replacement during permission waits
    const session = this.session;
    if (!session) {
      return true; // No session, signal retry
    }

    return new Promise<boolean>((resolve) => {
      let done = false;
      let hadMeaningfulEvent = false;
      let thinkingText = '';
      let resolved = false;

      const safeResolve = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(value);
      };

      // C-2 fix: timeout to prevent permanently stuck Promise
      const timeoutTimer = setTimeout(() => {
        if (!done) {
          done = true;
          console.error(`[gateway] processEvents timed out after ${PROCESS_EVENTS_TIMEOUT_MS / 1000}s`);
          streamPreview?.cancel();
          safeResolve(false);
        }
      }, PROCESS_EVENTS_TIMEOUT_MS);

      // W2-1 fix: serialize the entire onEvent handler so rapid events
      // (e.g., multiple tool_use) don't race on store mutations or card updates
      let eventQueue = Promise.resolve();
      const onEvent = (evt: AgentEvent) => {
        eventQueue = eventQueue.then(() => handleEvent(evt)).catch(err => {
          console.error('[gateway] onEvent error:', err);
        });
      };

      const handleEvent = async (evt: AgentEvent) => {
        if (done) return;

        switch (evt.type) {
          case 'thinking': {
            if (evt.content) {
              thinkingText = evt.content;
            }
            break;
          }

          case 'text': {
            hadMeaningfulEvent = true;
            if (evt.content && streamPreview) {
              streamPreview.appendText(evt.content);
            }
            break;
          }

          case 'tool_use': {
            hadMeaningfulEvent = true;
            const toolName = evt.toolName || '';
            console.log(`[gateway] tool: ${toolName}`);

            if (!isFiltered(toolName) && evt.toolInputRaw) {
              const stepCount = this.store.incrementStepCount();
              const display = toolDisplay(toolName, evt.toolInputRaw);
              const label = toolLabel(toolName, evt.toolInputRaw);
              const now = Math.floor(Date.now() / 1000);
              const elapsed = formatTime(now - (this.store.getState().startTime || now));
              const card = buildWorkingCard(display, this.store.getState().steps, stepCount, elapsed, this.botName, toolName);

              const msgId = this.store.getState().currentMessageId;
              if (msgId) {
                this.queueCardUpdate(() => this.feishu.updateCard(msgId, card));
              }

              this.store.addStep({ tool: toolName, label });
            }
            break;
          }

          case 'permission_request': {
            if (!evt.requestId) break;

            const toolName = evt.toolName || 'Unknown tool';

            // Auto-approve if tool is allowed in settings
            if (isPermissionAllowed(toolName, evt.toolInputRaw)) {
              console.log(`[gateway] auto-allow (settings): ${toolName}`);
              try {
                if (session.alive()) {
                  await session.respondPermission(evt.requestId, { behavior: 'allow' });
                }
              } catch (err) {
                console.warn(`[gateway] respondPermission (auto-allow) failed:`, (err as Error).message);
              }
              break;
            }

            // Pause streaming during permission request
            streamPreview?.cancel();

            // Send permission card
            const permCard = buildPermissionCard(toolName, evt.toolInput);
            await this.feishu.sendCard(chatId, permCard);

            // Wait for card action callback
            const result = await this.waitForPermission(evt.requestId, toolName, evt.toolInputRaw);
            try {
              if (session.alive()) {
                await session.respondPermission(evt.requestId, result);
              }
            } catch (err) {
              console.warn(`[gateway] respondPermission failed:`, (err as Error).message);
            }

            // Resume streaming after permission
            if (streamConfig.enabled) {
              streamPreview = new StreamPreview(streamConfig, this.feishu, chatId);
            }
            break;
          }

          case 'result': {
            done = true;

            // If no meaningful event and result is error, signal retry
            if (!hadMeaningfulEvent && evt.isError) {
              console.log('[gateway] session error, will retry fresh');
              safeResolve(true);
              break;
            }

            // Build DoneCard
            const reply = evt.content ? toFeishuMarkdown(evt.content.trim()) : '';
            const now = Math.floor(Date.now() / 1000);
            const elapsed = formatTime(now - (this.store.getState().startTime || now));
            const stepCount = this.store.getState().stepCount;
            const steps = this.store.getState().steps;
            const doneCard = buildDoneCard(reply, steps, stepCount, elapsed, this.botName, thinkingText);

            streamPreview?.cancel();

            const msgId = this.store.getState().currentMessageId;
            if (msgId) {
              this.queueCardUpdate(() => this.feishu.updateCard(msgId, doneCard));
            } else {
              this.queueCardUpdate(() => this.feishu.sendCard(chatId, doneCard).then(() => {}));
            }

            // Save agentSessionId
            if (evt.sessionId) {
              this.store.setAgentSessionId(evt.sessionId);
            }

            safeResolve(false);
            break;
          }

          case 'error': {
            done = true;
            streamPreview?.cancel();

            // If no meaningful event, signal retry
            if (!hadMeaningfulEvent) {
              safeResolve(true);
              break;
            }

            this.store.setAgentSessionId(undefined);
            this.session = null;
            await this.feishu.sendText(chatId, `\u274C ${evt.content || 'Unknown error'}`);
            safeResolve(false);
            break;
          }
        }
      };

      // C-1 fix: attach real callback via public API, which also flushes buffered events
      session.setCallbacks({ onEvent });
    });
  }

  // --- Permission handling ---

  private waitForPermission(
    requestId: string,
    toolName?: string,
    toolInputRaw?: Record<string, unknown>,
  ): Promise<{ behavior: 'allow' | 'deny' }> {
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, toolName, toolInputRaw });
    });
  }

  private findPendingPermission(): { requestId: string; entry: { resolve: (r: { behavior: 'allow' | 'deny' }) => void; toolName?: string; toolInputRaw?: Record<string, unknown> } } | null {
    for (const [requestId, entry] of this.pendingPermissions) {
      return { requestId, entry };
    }
    return null;
  }

  // --- Card action handling ---

  private handleCardAction(action: string, _chatId: string, _userId: string): any {
    if (action === 'permission_allow' || action === 'permission_always_allow' || action === 'permission_deny') {
      const pending = this.findPendingPermission();
      if (!pending) {
        // Permission request expired or session was reset — show expired card
        console.warn('[gateway] card action but no pending permission found (expired/reset)');
        return {
          card: {
            type: 'raw',
            data: {
              config: { update_multi: true },
              elements: [{ tag: 'markdown', content: '⚠️ **Permission request expired**' }],
            },
          },
        };
      }

      const behavior = action === 'permission_deny' ? 'deny' as const : 'allow' as const;
      pending.entry.resolve({ behavior });

      // Persist always-allowed tools to ~/.claude/settings.local.json
      if (action === 'permission_always_allow' && pending.entry.toolName) {
        const pattern = buildPermissionPattern(pending.entry.toolName, pending.entry.toolInputRaw);
        addAllowedPermission(pattern);
        console.log(`[gateway] always allow: ${pattern}`);
      }

      this.pendingPermissions.delete(pending.requestId);

      // Return updated card to replace the permission card
      const allowed = action !== 'permission_deny';
      const alwaysAllow = action === 'permission_always_allow';
      const resultCard = buildPermissionResultCard(allowed, alwaysAllow);
      return { card: { type: 'raw', data: resultCard } };
    }

    return {};
  }

  // --- Command handling ---

  private async handleCommand(cmd: string, args: string[], chatId: string): Promise<boolean> {
    switch (cmd) {
      case '/new': {
        try {
          // Reject all pending permission promises so processEvents can exit cleanly
          for (const [reqId, entry] of this.pendingPermissions) {
            entry.resolve({ behavior: 'deny' });
          }
          this.pendingPermissions.clear();

          this.store.setAgentSessionId(undefined);
          if (this.session) {
            await this.session.close();
            this.session = null;
          }
          await this.feishu.sendText(chatId, '🔄 Session reset. Send a new message to start.');
        } catch (err) {
          console.error('[gateway] /new failed:', err);
          await this.feishu.sendText(chatId, '⚠️ Session reset failed. Please try again.');
        }
        return true;
      }

      case '/sessions': {
        const count = args[0] ? parseInt(args[0], 10) : 15;
        const localSessions = await scanLocalSessions(count);
        if (localSessions.length === 0) {
          await this.feishu.sendText(chatId, 'No local Claude Code sessions found.');
        } else {
          const lines = localSessions.map(s => {
            const date = s.timestamp.substring(0, 16).replace('T', ' ');
            const dir = s.cwd.replace(/^\/Users\/[^/]+\//, '~/');
            const msg = s.firstMessage || '(empty)';
            return `• \`${s.id.substring(0, 8)}\` ${date} [${dir}]\n  ${msg}`;
          });
          await this.feishu.sendText(chatId, `📋 Local Claude Code Sessions:\n\n${lines.join('\n\n')}`);
        }
        return true;
      }

      case '/resume': {
        const targetId = args[0];
        if (!targetId) {
          await this.feishu.sendText(chatId, 'Usage: /resume <session_id>\nUse /sessions to list available sessions.');
          return true;
        }
        // Find full session ID if user provided partial
        const localSessions = await scanLocalSessions(100);
        const match = localSessions.find(s => s.id.startsWith(targetId));
        if (!match) {
          await this.feishu.sendText(chatId, `❌ Session "${targetId}" not found locally.`);
          return true;
        }
        // Reset current session and set the agent session ID to resume
        if (this.session) {
          await this.session.close();
          this.session = null;
        }
        this.store.setAgentSessionId(match.id);
        const dir = match.cwd.replace(/^\/Users\/[^/]+\//, '~/');
        await this.feishu.sendText(chatId, `✅ Will resume session \`${match.id.substring(0, 8)}\` [${dir}]\nSend a message to continue.`);
        return true;
      }

      case '/workspace': {
        const targetDir = args.join(' ').trim();
        if (!targetDir) {
          const currentDir = this.store.getState().workDir;
          await this.feishu.sendText(chatId, `📂 Current workspace: \`${currentDir}\``);
          return true;
        }
        // Resolve ~ to home directory
        const { homedir } = await import('node:os');
        const resolved = targetDir.replace(/^~/, homedir());
        // Verify directory exists
        const { existsSync, statSync } = await import('node:fs');
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          await this.feishu.sendText(chatId, `❌ Directory not found: \`${resolved}\``);
          return true;
        }
        // Set workDir and reset session
        this.store.setWorkDir(resolved);
        if (this.session) {
          await this.session.close();
          this.session = null;
        }
        this.store.setAgentSessionId(undefined);
        await this.feishu.sendText(chatId, `📂 Workspace changed to: \`${resolved}\`\nSession reset. Next message will start in the new workspace.`);
        return true;
      }

      case '/status': {
        const state = this.store.getState();
        const sessionAlive = this.session?.alive() ? 'alive' : 'dead';
        const lines = [
          `📊 Bridge Status`,
          `Bot: ${this.botName}`,
          `Workspace: \`${state.workDir}\``,
          `Session ID: ${state.agentSessionId?.substring(0, 8) || '(none)'}`,
          `Session state: ${sessionAlive}`,
          `Last activity: ${state.lastActivity}`,
        ];
        await this.feishu.sendText(chatId, lines.join('\n'));
        return true;
      }

      case '/help': {
        await this.feishu.sendText(chatId, [
          '📖 Available commands:',
          '/new — Reset current session',
          '/workspace [path] — Show or change workspace directory',
          '/sessions [n] — List local Claude Code sessions',
          '/resume <id> — Resume a local Claude Code session',
          '/status — Show bridge status',
          '/help — Show this help',
        ].join('\n'));
        return true;
      }

      default:
        return false;
    }
  }

  async stop(): Promise<void> {
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
    }
    await this.feishu.stop();
    this.store.save();
    console.log('[gateway] stopped');
  }
}
