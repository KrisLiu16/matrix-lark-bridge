/**
 * Unit tests for WechatGateway (gateway-integration.ts).
 *
 * Tests command routing, message queuing, session lifecycle,
 * event processing, and permission handling.
 *
 * All external dependencies (ClaudeSession, SessionStore, sender) are stubbed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WechatGateway,
  type IClaudeSession,
  type ISessionStore,
  type WechatSendFunctions,
  type ClaudeSessionFactory,
  type WechatGatewayConfig,
  type AgentEvent,
} from '../../src/wechat/gateway-integration.js';
import type { WechatChannelMessage, WeixinMessage } from '../../src/wechat/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal WechatChannelMessage stub. */
function makeMsg(text: string, userId = 'user-1', contextToken = 'ctx-1'): WechatChannelMessage {
  return {
    messageId: Date.now(),
    sender: { userId, nickname: 'Test', chatType: 'direct' },
    text,
    contextToken,
    raw: {} as WeixinMessage,
  };
}

/** Build a mock IClaudeSession. Captures the onEvent callback for later triggering. */
function makeMockSession() {
  let onEvent: ((evt: AgentEvent) => void) | null = null;
  const calls: { method: string; args: unknown[] }[] = [];

  const session: IClaudeSession = {
    async start() { calls.push({ method: 'start', args: [] }); },
    async send(prompt, images) { calls.push({ method: 'send', args: [prompt, images] }); },
    async respondPermission(reqId, result) { calls.push({ method: 'respondPermission', args: [reqId, result] }); },
    setCallbacks(cb) {
      onEvent = cb.onEvent;
      calls.push({ method: 'setCallbacks', args: [cb] });
    },
    currentSessionId() { return 'sess-123'; },
    alive() { return true; },
    async close() { calls.push({ method: 'close', args: [] }); },
  };

  return {
    session,
    calls,
    /** Emit an event as if Claude sent it. */
    emit(evt: AgentEvent) {
      if (!onEvent) throw new Error('setCallbacks not yet called');
      onEvent(evt);
    },
    get hasCallback() { return onEvent !== null; },
  };
}

function makeMockStore(): ISessionStore & { _state: ReturnType<ISessionStore['getState']>; _history: Array<{ role: string; content: string }> } {
  const state = {
    workDir: '/tmp/test',
    stepCount: 0,
    steps: [] as Array<{ tool: string; label: string }>,
  };
  const history: Array<{ role: string; content: string }> = [];
  return {
    _state: state,
    _history: history,
    getState() { return { ...state }; },
    setAgentSessionId(id) { (state as any).agentSessionId = id; },
    resetTurn() { state.stepCount = 0; state.steps = []; },
    addHistory(role, content) { history.push({ role, content }); },
    save() {},
  };
}

function makeMockSender(): WechatSendFunctions & { sent: Array<{ method: string; args: unknown[] }> } {
  const sent: Array<{ method: string; args: unknown[] }> = [];
  return {
    sent,
    async sendTextReply(userId, contextToken, text) {
      sent.push({ method: 'sendTextReply', args: [userId, contextToken, text] });
    },
    async sendTyping(userId, contextToken) {
      sent.push({ method: 'sendTyping', args: [userId, contextToken] });
    },
    async sendImageReply(userId, contextToken, imageData) {
      sent.push({ method: 'sendImageReply', args: [userId, contextToken, imageData] });
    },
    async sendFileReply(userId, contextToken, fileData, fileName) {
      sent.push({ method: 'sendFileReply', args: [userId, contextToken, fileData, fileName] });
    },
  };
}

function makeGateway(overrides?: {
  session?: ReturnType<typeof makeMockSession>;
  store?: ReturnType<typeof makeMockStore>;
  sender?: ReturnType<typeof makeMockSender>;
  config?: Partial<WechatGatewayConfig>;
}) {
  const mockSess = overrides?.session ?? makeMockSession();
  const store = overrides?.store ?? makeMockStore();
  const sender = overrides?.sender ?? makeMockSender();
  const config: WechatGatewayConfig = {
    workDir: '/tmp/test',
    botName: 'TestBot',
    maxQueue: 3,
    ...overrides?.config,
  };

  const factory: ClaudeSessionFactory = {
    create: () => mockSess.session,
  };

  const gw = new WechatGateway(factory, store, sender, config);
  return { gw, mockSess, store, sender, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WechatGateway', () => {

  // -----------------------------------------------------------------------
  // Slash commands
  // -----------------------------------------------------------------------

  describe('/stop command', () => {
    it('should reply with stop message and close session', async () => {
      const { gw, sender, mockSess } = makeGateway();
      // Pre-warm: send a message that starts session, then /stop
      // But /stop should work even without a running session
      await gw.handleMessage(makeMsg('/stop'));

      assert.equal(sender.sent.length, 1);
      assert.ok((sender.sent[0].args[2] as string).includes('已停止'));
    });
  });

  describe('/reset command', () => {
    it('should reply with reset message and clear session id', async () => {
      const store = makeMockStore();
      store.setAgentSessionId('old-session');
      const { gw, sender } = makeGateway({ store });

      await gw.handleMessage(makeMsg('/reset'));

      assert.equal(sender.sent.length, 1);
      assert.ok((sender.sent[0].args[2] as string).includes('已重置'));
      assert.equal(store._state.agentSessionId, undefined);
    });
  });

  describe('/status command', () => {
    it('should reply with status info', async () => {
      const { gw, sender } = makeGateway();

      await gw.handleMessage(makeMsg('/status'));

      assert.equal(sender.sent.length, 1);
      const text = sender.sent[0].args[2] as string;
      assert.ok(text.includes('状态'));
      assert.ok(text.includes('会话'));
    });
  });

  describe('/auth command (K5 — fixed behavior)', () => {
    it('should route /auth to handleAuthFlow (not fall through to processMessage)', async () => {
      // K5 fixed: /auth is intercepted by isAuthCommand() before reaching processMessage.
      // Without authConfig, handleAuthFlow sends an error reply — but does NOT forward to Claude.
      const mockSess = makeMockSession();
      const { gw, sender } = makeGateway({ session: mockSess });

      await gw.handleMessage(makeMsg('/auth'));

      // Session should NOT have been started (no send call)
      const sendCall = mockSess.calls.find(c => c.method === 'send');
      assert.ok(!sendCall, '/auth should NOT be forwarded to Claude session');

      // Should have received an error reply about unconfigured auth
      const reply = sender.sent.find(s =>
        s.method === 'sendTextReply' && (s.args[2] as string).includes('未配置'));
      assert.ok(reply, 'should reply with auth-not-configured error');
    });

    it('should treat "hello /auth" as normal text (not a command)', async () => {
      const mockSess = makeMockSession();
      const { gw } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('hello /auth'));

      await new Promise(r => setTimeout(r, 20));

      const sendCall = mockSess.calls.find(c => c.method === 'send');
      assert.ok(sendCall);
      assert.ok((sendCall!.args[0] as string).includes('hello /auth'));

      mockSess.emit({ type: 'result', content: 'ok' });
      await promise;
    });
  });

  // -----------------------------------------------------------------------
  // Message routing & queuing
  // -----------------------------------------------------------------------

  describe('normal message routing', () => {
    it('should route text to Claude session and reply with result', async () => {
      const mockSess = makeMockSession();
      const { gw, sender, store } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('你好'));

      // Wait for ensureSession + send
      await new Promise(r => setTimeout(r, 20));

      // Verify session was started and message sent
      assert.ok(mockSess.calls.some(c => c.method === 'start'));
      const sendCall = mockSess.calls.find(c => c.method === 'send');
      assert.ok(sendCall);
      assert.ok((sendCall!.args[0] as string).includes('你好'));

      // Verify typing indicator was sent
      assert.ok(sender.sent.some(s => s.method === 'sendTyping'));

      // Emit result
      mockSess.emit({ type: 'result', content: '你好！有什么可以帮你的？', sessionId: 'sess-new' });
      await promise;

      // Verify reply sent to user
      const reply = sender.sent.find(s => s.method === 'sendTextReply');
      assert.ok(reply);
      assert.ok((reply!.args[2] as string).includes('你好'));

      // Verify history recorded
      assert.ok(store._history.some(h => h.role === 'user'));
      assert.ok(store._history.some(h => h.role === 'assistant'));
    });
  });

  describe('message queuing', () => {
    it('should queue messages when busy processing', async () => {
      const mockSess = makeMockSession();
      const { gw, sender } = makeGateway({ session: mockSess });

      // Start first message (gateway becomes busy)
      const p1 = gw.handleMessage(makeMsg('first'));
      await new Promise(r => setTimeout(r, 20));

      // Second message should be queued
      await gw.handleMessage(makeMsg('second'));

      // No extra sendTextReply for queue full — just silently queued
      // Complete first message
      mockSess.emit({ type: 'result', content: 'first result' });
      await p1;

      // Give drainQueue a tick to fire
      await new Promise(r => setTimeout(r, 50));

      // The queued message should now be processing
      const sendCalls = mockSess.calls.filter(c => c.method === 'send');
      assert.ok(sendCalls.length >= 2, `expected >=2 send calls, got ${sendCalls.length}`);

      // Cleanup: emit result for queued message and stop gateway to clear timers
      mockSess.emit({ type: 'result', content: 'second result' });
      await new Promise(r => setTimeout(r, 20));
      await gw.stop();
    });

    it('should reject when queue is full', async () => {
      const mockSess = makeMockSession();
      const { gw, sender } = makeGateway({ session: mockSess, config: { workDir: '/tmp/test', maxQueue: 2 } });

      // Start processing
      const p1 = gw.handleMessage(makeMsg('first'));
      await new Promise(r => setTimeout(r, 20));

      // Fill queue
      await gw.handleMessage(makeMsg('q1'));
      await gw.handleMessage(makeMsg('q2'));

      // This should be rejected
      await gw.handleMessage(makeMsg('overflow'));

      const overflow = sender.sent.find(s =>
        s.method === 'sendTextReply' && (s.args[2] as string).includes('队列已满'));
      assert.ok(overflow, 'should have sent queue-full message');

      // Cleanup: emit result for first message, then stop to clear queued message timers
      mockSess.emit({ type: 'result', content: 'done' });
      await p1;

      // drainQueue fires for q1/q2 — emit results and stop gateway
      await new Promise(r => setTimeout(r, 50));
      mockSess.emit({ type: 'result', content: 'q1 done' });
      await new Promise(r => setTimeout(r, 50));
      mockSess.emit({ type: 'result', content: 'q2 done' });
      await new Promise(r => setTimeout(r, 50));
      await gw.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Permission handling (K7 — current behavior)
  // -----------------------------------------------------------------------

  describe('permission handling (K7 — fixed behavior)', () => {
    it('should DENY dangerous Bash commands like rm -rf', async () => {
      const mockSess = makeMockSession();
      const { gw, sender } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('delete everything'));
      await new Promise(r => setTimeout(r, 20));

      // Emit a dangerous permission request (Bash rm -rf)
      mockSess.emit({
        type: 'permission_request',
        requestId: 'perm-1',
        toolName: 'Bash',
        toolInput: 'rm -rf /',
        toolInputRaw: { command: 'rm -rf /' },
      });

      await new Promise(r => setTimeout(r, 20));

      // K7 fixed: dangerous commands are denied
      const permCall = mockSess.calls.find(c =>
        c.method === 'respondPermission' && (c.args[0] as string) === 'perm-1');
      assert.ok(permCall, 'should have responded to permission request');
      assert.deepEqual((permCall!.args[1] as any).behavior, 'deny',
        'K7: dangerous Bash commands must be denied');

      // User should receive a denial notification
      const denyMsg = sender.sent.find(s =>
        s.method === 'sendTextReply' && (s.args[2] as string).includes('权限拒绝'));
      assert.ok(denyMsg, 'should notify user of denied permission');

      mockSess.emit({ type: 'result', content: 'done' });
      await promise;
    });

    it('should auto-allow Read tool permission_request', async () => {
      const mockSess = makeMockSession();
      const { gw } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('read file'));
      await new Promise(r => setTimeout(r, 20));

      mockSess.emit({
        type: 'permission_request',
        requestId: 'perm-read',
        toolName: 'Read',
      });

      await new Promise(r => setTimeout(r, 20));

      const permCall = mockSess.calls.find(c =>
        c.method === 'respondPermission' && (c.args[0] as string) === 'perm-read');
      assert.ok(permCall);
      assert.deepEqual((permCall!.args[1] as any).behavior, 'allow');

      mockSess.emit({ type: 'result', content: 'file contents' });
      await promise;
    });

    it('should auto-allow AskUserQuestion permission', async () => {
      const mockSess = makeMockSession();
      const { gw } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('help'));
      await new Promise(r => setTimeout(r, 20));

      mockSess.emit({
        type: 'permission_request',
        requestId: 'perm-ask',
        toolName: 'AskUserQuestion',
      });

      await new Promise(r => setTimeout(r, 20));

      const permCall = mockSess.calls.find(c =>
        c.method === 'respondPermission' && (c.args[0] as string) === 'perm-ask');
      assert.ok(permCall);
      assert.deepEqual((permCall!.args[1] as any).behavior, 'allow');

      mockSess.emit({ type: 'result', content: 'ok' });
      await promise;
    });

    it('should handle permission_cancel by resolving pending', async () => {
      const mockSess = makeMockSession();
      const { gw } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('test'));
      await new Promise(r => setTimeout(r, 20));

      mockSess.emit({
        type: 'permission_cancel',
        requestId: 'perm-cancelled',
      });

      // Should not throw
      await new Promise(r => setTimeout(r, 10));

      mockSess.emit({ type: 'result', content: 'done' });
      await promise;
    });
  });

  // -----------------------------------------------------------------------
  // AskUserQuestion event handling (K8 — current behavior)
  // -----------------------------------------------------------------------

  describe('AskUserQuestion (K8 — fixed behavior)', () => {
    it('should send question text to WeChat user and collect answer', async () => {
      const mockSess = makeMockSession();
      const { gw, sender } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('what should I do', 'user-1', 'ctx-ask'));
      await new Promise(r => setTimeout(r, 30));

      // Emit AskUserQuestion tool_use event
      mockSess.emit({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolInputRaw: {
          questions: [{ question: '你想用哪种方案？' }],
        },
      });

      // Wait for the question to be sent and waitForUserAnswer to register
      await new Promise(r => setTimeout(r, 50));

      // Should have sent the question to the user
      const questionMsg = sender.sent.find(s =>
        s.method === 'sendTextReply' && (s.args[2] as string).includes('你想用哪种方案'));
      assert.ok(questionMsg, 'should send question to WeChat user');

      // Simulate user answering (next message from same user resolves pending question)
      await gw.handleMessage(makeMsg('方案A', 'user-1', 'ctx-answer'));

      await new Promise(r => setTimeout(r, 50));

      // Complete the turn
      mockSess.emit({ type: 'result', content: 'final answer' });
      await promise;
    });

    it('should timeout and notify user when no answer arrives within 5 minutes', async () => {
      // Patch setTimeout to intercept the 5-minute timeout and fire it immediately
      const originalSetTimeout = globalThis.setTimeout;
      let timeoutFn: (() => void) | null = null;

      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        // Intercept the 5-minute (300000ms) timeout from waitForUserAnswer
        if (ms === 5 * 60 * 1000) {
          timeoutFn = () => fn(...args);
          return 99999 as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(fn, ms!, ...args);
      }) as typeof setTimeout;

      try {
        const mockSess = makeMockSession();
        const { gw, sender } = makeGateway({ session: mockSess });

        const promise = gw.handleMessage(makeMsg('do something', 'user-1', 'ctx-timeout'));
        await new Promise(r => originalSetTimeout(r, 30));

        // Emit AskUserQuestion with empty question (fallback text)
        mockSess.emit({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolInputRaw: { questions: [{}] },
        });

        await new Promise(r => originalSetTimeout(r, 50));

        // Verify fallback question text
        const questionMsg = sender.sent.find(s =>
          s.method === 'sendTextReply' && (s.args[2] as string).includes('请回答'));
        assert.ok(questionMsg, 'should use fallback text');

        // Fire the captured 5-minute timeout immediately
        assert.ok(timeoutFn, 'should have captured the 5-minute timeout');
        (timeoutFn as () => void)();

        await new Promise(r => originalSetTimeout(r, 50));

        // Should have sent timeout notification
        const timeoutMsg = sender.sent.find(s =>
          s.method === 'sendTextReply' && (s.args[2] as string).includes('超时'));
        assert.ok(timeoutMsg, 'should send timeout notification');

        // Complete the turn
        mockSess.emit({ type: 'result', content: 'done' });
        await promise;
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Event processing
  // -----------------------------------------------------------------------

  describe('event processing', () => {
    it('should retry with fresh session on immediate error (no meaningful events)', async () => {
      let createCount = 0;
      const sessions: ReturnType<typeof makeMockSession>[] = [];

      const factory: ClaudeSessionFactory = {
        create: () => {
          const s = makeMockSession();
          sessions.push(s);
          createCount++;
          return s.session;
        },
      };
      const store = makeMockStore();
      const sender = makeMockSender();
      const gw = new WechatGateway(factory, store, sender, { workDir: '/tmp/test' });

      const promise = gw.handleMessage(makeMsg('hello'));
      await new Promise(r => setTimeout(r, 20));

      // First session immediately errors (no hadMeaningfulEvent)
      sessions[0].emit({ type: 'error', content: 'crash' });
      await new Promise(r => setTimeout(r, 50));

      // Should have created a second session for retry
      if (sessions.length >= 2) {
        sessions[1].emit({ type: 'result', content: 'ok after retry' });
      }
      await promise;

      assert.ok(createCount >= 2, `expected >=2 session creates (retry), got ${createCount}`);
    });

    it('should NOT retry on error after meaningful events', async () => {
      const mockSess = makeMockSession();
      const { gw, sender } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('hello'));
      await new Promise(r => setTimeout(r, 20));

      // Send a meaningful text event first
      mockSess.emit({ type: 'text', content: 'thinking...' });
      await new Promise(r => setTimeout(r, 10));

      // Then error
      mockSess.emit({ type: 'error', content: 'unexpected failure' });
      await promise;

      // Should have sent error message to user (not retried)
      const errMsg = sender.sent.find(s =>
        s.method === 'sendTextReply' && (s.args[2] as string).includes('错误'));
      assert.ok(errMsg, 'should send error to user after meaningful events');
    });

    it('should save agent session ID from result event', async () => {
      const mockSess = makeMockSession();
      const store = makeMockStore();
      const { gw } = makeGateway({ session: mockSess, store });

      const promise = gw.handleMessage(makeMsg('hello'));
      await new Promise(r => setTimeout(r, 20));

      mockSess.emit({ type: 'result', content: 'hi', sessionId: 'new-sess-42' });
      await promise;

      assert.equal(store._state.agentSessionId, 'new-sess-42');
    });

    it('should discard events after /stop (generation mismatch)', async () => {
      const mockSess = makeMockSession();
      const { gw, sender } = makeGateway({ session: mockSess });

      const promise = gw.handleMessage(makeMsg('long task'));
      await new Promise(r => setTimeout(r, 20));

      // /stop increments generation
      await gw.stop();

      // Late event from old generation should be ignored
      mockSess.emit({ type: 'result', content: 'stale result' });

      // The promise should resolve (processEvents detects generation mismatch)
      await promise;

      // No stale result should have been sent
      const staleReply = sender.sent.find(s =>
        s.method === 'sendTextReply' && (s.args[2] as string).includes('stale'));
      assert.ok(!staleReply, 'should not send stale result after /stop');
    });
  });

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------

  describe('session management', () => {
    it('should resume session using stored agentSessionId', async () => {
      const mockSess = makeMockSession();
      const store = makeMockStore();
      store.setAgentSessionId('resume-sess-99');

      let createOpts: any = null;
      const factory: ClaudeSessionFactory = {
        create: (opts) => { createOpts = opts; return mockSess.session; },
      };

      const sender = makeMockSender();
      const gw = new WechatGateway(factory, store, sender, { workDir: '/tmp/test' });

      const promise = gw.handleMessage(makeMsg('hi'));
      await new Promise(r => setTimeout(r, 20));

      assert.ok(createOpts, 'factory.create should have been called');
      assert.equal(createOpts.resumeSessionId, 'resume-sess-99');

      mockSess.emit({ type: 'result', content: 'resumed' });
      await promise;
    });
  });

  // -----------------------------------------------------------------------
  // stop()
  // -----------------------------------------------------------------------

  describe('stop()', () => {
    it('should close session and clear queue', async () => {
      const mockSess = makeMockSession();
      const { gw } = makeGateway({ session: mockSess });

      // Start a message so session exists
      const promise = gw.handleMessage(makeMsg('test'));
      await new Promise(r => setTimeout(r, 20));

      await gw.stop();

      // Session should have been closed
      assert.ok(mockSess.calls.some(c => c.method === 'close'));

      // Emit result to unblock promise (already resolved via generation check)
      mockSess.emit({ type: 'result', content: 'ignored' });
      await promise;
    });
  });
});
