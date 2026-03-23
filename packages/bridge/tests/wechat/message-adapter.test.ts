import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  setContextToken,
  getContextToken,
  isStaleMessage,
  isBotMessage,
  detectContentTypes,
  iLinkMessageToBridgeMessage,
  extractImageItems,
  extractFileItems,
  buildTextReply,
  buildImageReply,
  bridgeReplyToSendRequests,
  truncateForWechat,
  contentTypeLabel,
} from "../../src/wechat/message-adapter.js";
import {
  MessageType,
  MessageState,
  MessageItemType,
} from "@mlb/wechat-sdk";
import type {
  WeixinMessage,
  MessageItem,
  SendMessageReq,
} from "@mlb/wechat-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal USER text message. */
function makeTextMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: 1001,
    from_user_id: "user-abc",
    message_type: MessageType.USER,
    context_token: "ctx-tok-1",
    create_time_ms: Date.now(),
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text: "hello world" },
      },
    ],
    ...overrides,
  };
}

/** Build a USER image message with CDN metadata. */
function makeImageMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: 1002,
    from_user_id: "user-abc",
    message_type: MessageType.USER,
    context_token: "ctx-tok-2",
    create_time_ms: Date.now(),
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: "enc_q=xyz",
            aes_key: "base64key==",
            encrypt_type: 1,
          },
          aeskey: "0123456789abcdef",
          mid_size: 2048,
        },
      },
    ],
    ...overrides,
  };
}

/** Build a USER file message. */
function makeFileMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: 1003,
    from_user_id: "user-abc",
    message_type: MessageType.USER,
    context_token: "ctx-tok-3",
    create_time_ms: Date.now(),
    item_list: [
      {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: "enc_f=abc",
            aes_key: "filekey==",
            encrypt_type: 1,
          },
          file_name: "report.pdf",
          len: "4096",
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Context token store
// ---------------------------------------------------------------------------

describe("contextToken store", () => {
  it("set and get round-trips", () => {
    setContextToken("u1", "tok-1");
    assert.strictEqual(getContextToken("u1"), "tok-1");
  });

  it("returns undefined for unknown user", () => {
    assert.strictEqual(getContextToken("never-seen"), undefined);
  });

  it("overwrites previous value", () => {
    setContextToken("u2", "old");
    setContextToken("u2", "new");
    assert.strictEqual(getContextToken("u2"), "new");
  });
});

// ---------------------------------------------------------------------------
// isStaleMessage
// ---------------------------------------------------------------------------

describe("isStaleMessage", () => {
  it("returns false for a fresh message", () => {
    const msg = makeTextMsg({ create_time_ms: Date.now() });
    assert.strictEqual(isStaleMessage(msg), false);
  });

  it("returns true for a message older than 10 minutes", () => {
    const msg = makeTextMsg({ create_time_ms: Date.now() - 11 * 60 * 1000 });
    assert.strictEqual(isStaleMessage(msg), true);
  });

  it("returns false when create_time_ms is missing", () => {
    const msg = makeTextMsg({ create_time_ms: undefined });
    assert.strictEqual(isStaleMessage(msg), false);
  });
});

// ---------------------------------------------------------------------------
// isBotMessage
// ---------------------------------------------------------------------------

describe("isBotMessage", () => {
  it("returns true for BOT message_type", () => {
    assert.strictEqual(isBotMessage(makeTextMsg({ message_type: MessageType.BOT })), true);
  });

  it("returns false for USER message_type", () => {
    assert.strictEqual(isBotMessage(makeTextMsg({ message_type: MessageType.USER })), false);
  });
});

// ---------------------------------------------------------------------------
// detectContentTypes
// ---------------------------------------------------------------------------

describe("detectContentTypes", () => {
  it("returns empty set for no items", () => {
    assert.strictEqual(detectContentTypes(undefined).size, 0);
    assert.strictEqual(detectContentTypes([]).size, 0);
  });

  it("detects TEXT type", () => {
    const types = detectContentTypes([{ type: MessageItemType.TEXT }]);
    assert.ok(types.has(MessageItemType.TEXT));
    assert.strictEqual(types.size, 1);
  });

  it("detects multiple types", () => {
    const types = detectContentTypes([
      { type: MessageItemType.TEXT },
      { type: MessageItemType.IMAGE },
      { type: MessageItemType.FILE },
    ]);
    assert.strictEqual(types.size, 3);
    assert.ok(types.has(MessageItemType.TEXT));
    assert.ok(types.has(MessageItemType.IMAGE));
    assert.ok(types.has(MessageItemType.FILE));
  });
});

// ---------------------------------------------------------------------------
// Inbound: iLinkMessageToBridgeMessage
// ---------------------------------------------------------------------------

describe("iLinkMessageToBridgeMessage", () => {
  it("converts text message with correct fields", () => {
    const msg = makeTextMsg();
    const result = iLinkMessageToBridgeMessage(msg);
    assert.ok(result);
    assert.strictEqual(result.messageId, 1001);
    assert.strictEqual(result.sender.userId, "user-abc");
    assert.strictEqual(result.sender.chatType, "direct");
    assert.strictEqual(result.contextToken, "ctx-tok-1");
    assert.strictEqual(result.text, "hello world");
    assert.strictEqual(result.raw, msg);
  });

  it("caches context_token on conversion", () => {
    const msg = makeTextMsg({
      from_user_id: "cache-test-user",
      context_token: "cached-tok",
    });
    iLinkMessageToBridgeMessage(msg);
    assert.strictEqual(getContextToken("cache-test-user"), "cached-tok");
  });

  it("returns null for bot messages", () => {
    const msg = makeTextMsg({ message_type: MessageType.BOT });
    assert.strictEqual(iLinkMessageToBridgeMessage(msg), null);
  });

  it("returns null for stale messages", () => {
    const msg = makeTextMsg({ create_time_ms: Date.now() - 15 * 60 * 1000 });
    assert.strictEqual(iLinkMessageToBridgeMessage(msg), null);
  });

  it("returns null for empty/no-content messages", () => {
    const msg = makeTextMsg({ item_list: [] });
    assert.strictEqual(iLinkMessageToBridgeMessage(msg), null);
  });

  it("returns null for whitespace-only text with no images", () => {
    const msg = makeTextMsg({
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "   " } }],
    });
    assert.strictEqual(iLinkMessageToBridgeMessage(msg), null);
  });

  it("converts image message (metadata only, no data buffer)", () => {
    const msg = makeImageMsg();
    const result = iLinkMessageToBridgeMessage(msg);
    assert.ok(result);
    // images array is left undefined — caller must download from CDN
    assert.strictEqual(result.images, undefined);
    // text should be empty since no TEXT item
    assert.strictEqual(result.text, undefined);
    assert.strictEqual(result.messageId, 1002);
  });

  it("handles voice-to-text fallback", () => {
    const msg = makeTextMsg({
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "语音内容" },
        },
      ],
    });
    const result = iLinkMessageToBridgeMessage(msg);
    assert.ok(result);
    assert.ok(result.text!.includes("语音转文字"));
    assert.ok(result.text!.includes("语音内容"));
  });

  it("handles quoted/ref message with text", () => {
    const msg = makeTextMsg({
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "my reply" },
          ref_msg: {
            title: "引用者",
            message_item: {
              type: MessageItemType.TEXT,
              text_item: { text: "原始消息" },
            },
          },
        },
      ],
    });
    const result = iLinkMessageToBridgeMessage(msg);
    assert.ok(result);
    assert.ok(result.text!.includes("引用"));
    assert.ok(result.text!.includes("原始消息"));
    assert.ok(result.text!.includes("my reply"));
  });

  it("handles quoted media ref — uses current text only", () => {
    const msg = makeTextMsg({
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "看这个图" },
          ref_msg: {
            message_item: {
              type: MessageItemType.IMAGE,
              image_item: { media: {} },
            },
          },
        },
      ],
    });
    const result = iLinkMessageToBridgeMessage(msg);
    assert.ok(result);
    assert.strictEqual(result.text, "看这个图");
  });

  it("preserves sessionId and createTimeMs", () => {
    const now = Date.now();
    const msg = makeTextMsg({ session_id: "sess-123", create_time_ms: now });
    const result = iLinkMessageToBridgeMessage(msg);
    assert.ok(result);
    assert.strictEqual(result.sessionId, "sess-123");
    assert.strictEqual(result.createTimeMs, now);
  });
});

// ---------------------------------------------------------------------------
// extractImageItems / extractFileItems
// ---------------------------------------------------------------------------

describe("extractImageItems", () => {
  it("extracts IMAGE items with encrypt_query_param", () => {
    const msg = makeImageMsg();
    const items = extractImageItems(msg);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, MessageItemType.IMAGE);
    assert.strictEqual(items[0].image_item!.media!.encrypt_query_param, "enc_q=xyz");
  });

  it("extracts IMAGE items with aeskey field", () => {
    const msg: WeixinMessage = {
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: { aeskey: "abcdef1234567890" },
        },
      ],
    };
    const items = extractImageItems(msg);
    assert.strictEqual(items.length, 1);
  });

  it("skips IMAGE items without CDN metadata", () => {
    const msg: WeixinMessage = {
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: { url: "http://example.com/img.jpg" },
        },
      ],
    };
    const items = extractImageItems(msg);
    assert.strictEqual(items.length, 0);
  });

  it("returns empty for no items", () => {
    assert.strictEqual(extractImageItems({}).length, 0);
  });
});

describe("extractFileItems", () => {
  it("extracts FILE items with media", () => {
    const msg = makeFileMsg();
    const items = extractFileItems(msg);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].file_item!.file_name, "report.pdf");
    assert.strictEqual(items[0].file_item!.len, "4096");
  });

  it("skips FILE items without media", () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: MessageItemType.FILE, file_item: { file_name: "no-media.txt" } },
      ],
    };
    assert.strictEqual(extractFileItems(msg).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Outbound: buildTextReply
// ---------------------------------------------------------------------------

describe("buildTextReply", () => {
  it("builds correct structure with protocol invariants", () => {
    const req = buildTextReply("user-dest", "Hello!", "ctx-out-1");
    const m = req.msg!;
    assert.strictEqual(m.from_user_id, "");
    assert.strictEqual(m.to_user_id, "user-dest");
    assert.strictEqual(m.message_type, MessageType.BOT);
    assert.strictEqual(m.message_state, MessageState.FINISH);
    assert.strictEqual(m.context_token, "ctx-out-1");
    assert.ok(m.client_id);
    assert.ok(m.client_id!.startsWith("bridge-wx-"));
  });

  it("item_list has exactly one TEXT item", () => {
    const req = buildTextReply("u1", "test text", "ctx-1");
    const items = req.msg!.item_list!;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, MessageItemType.TEXT);
    assert.strictEqual(items[0].text_item!.text, "test text");
  });

  it("msg_type matches item type (both TEXT-related)", () => {
    const req = buildTextReply("u1", "text", "ctx-1");
    // message_type = BOT (outbound), item type = TEXT
    assert.strictEqual(req.msg!.item_list![0].type, MessageItemType.TEXT);
  });

  it("throws when contextToken is empty", () => {
    assert.throws(
      () => buildTextReply("u1", "text", ""),
      /contextToken is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// Outbound: buildImageReply
// ---------------------------------------------------------------------------

describe("buildImageReply", () => {
  const CDN_PARAMS = {
    encryptQueryParam: "enc_param=test",
    aesKeyBase64: "dGVzdGtleQ==",
    fileSizeCiphertext: 2048,
  };

  it("returns array with one IMAGE request (no caption)", () => {
    const reqs = buildImageReply("u1", CDN_PARAMS, "ctx-img-1");
    assert.strictEqual(reqs.length, 1);
    const item = reqs[0].msg!.item_list![0];
    assert.strictEqual(item.type, MessageItemType.IMAGE);
    assert.strictEqual(item.image_item!.media!.encrypt_query_param, "enc_param=test");
    assert.strictEqual(item.image_item!.media!.aes_key, "dGVzdGtleQ==");
    assert.strictEqual(item.image_item!.media!.encrypt_type, 1);
    assert.strictEqual(item.image_item!.mid_size, 2048);
  });

  it("returns [TEXT, IMAGE] when caption provided", () => {
    const reqs = buildImageReply("u1", CDN_PARAMS, "ctx-img-2", "看这张图");
    assert.strictEqual(reqs.length, 2);
    assert.strictEqual(reqs[0].msg!.item_list![0].type, MessageItemType.TEXT);
    assert.strictEqual(reqs[0].msg!.item_list![0].text_item!.text, "看这张图");
    assert.strictEqual(reqs[1].msg!.item_list![0].type, MessageItemType.IMAGE);
  });

  it("each request has exactly one item (protocol invariant)", () => {
    const reqs = buildImageReply("u1", CDN_PARAMS, "ctx-img-3", "caption");
    for (const req of reqs) {
      assert.strictEqual(req.msg!.item_list!.length, 1);
    }
  });

  it("all requests carry the same context_token", () => {
    const reqs = buildImageReply("u1", CDN_PARAMS, "ctx-shared", "cap");
    for (const req of reqs) {
      assert.strictEqual(req.msg!.context_token, "ctx-shared");
    }
  });

  it("throws when contextToken is empty", () => {
    assert.throws(
      () => buildImageReply("u1", CDN_PARAMS, ""),
      /contextToken is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// Outbound: bridgeReplyToSendRequests
// ---------------------------------------------------------------------------

describe("bridgeReplyToSendRequests", () => {
  it("text-only reply returns single TEXT request", () => {
    const reqs = bridgeReplyToSendRequests("u1", "ctx-br-1", { text: "reply text" });
    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0].msg!.item_list![0].type, MessageItemType.TEXT);
    assert.strictEqual(reqs[0].msg!.item_list![0].text_item!.text, "reply text");
  });

  it("image-only reply returns one request per image", () => {
    const reqs = bridgeReplyToSendRequests("u1", "ctx-br-2", {
      imageItems: [
        { encryptQueryParam: "e1", aesKeyBase64: "k1" },
        { encryptQueryParam: "e2", aesKeyBase64: "k2" },
      ],
    });
    assert.strictEqual(reqs.length, 2);
    assert.strictEqual(reqs[0].msg!.item_list![0].type, MessageItemType.IMAGE);
    assert.strictEqual(reqs[1].msg!.item_list![0].type, MessageItemType.IMAGE);
  });

  it("text + images: text first, then images", () => {
    const reqs = bridgeReplyToSendRequests("u1", "ctx-br-3", {
      text: "看图",
      imageItems: [{ encryptQueryParam: "e1", aesKeyBase64: "k1" }],
    });
    assert.strictEqual(reqs.length, 2);
    assert.strictEqual(reqs[0].msg!.item_list![0].type, MessageItemType.TEXT);
    assert.strictEqual(reqs[1].msg!.item_list![0].type, MessageItemType.IMAGE);
  });

  it("empty reply returns empty array", () => {
    const reqs = bridgeReplyToSendRequests("u1", "ctx-br-4", {});
    assert.strictEqual(reqs.length, 0);
  });

  it("each request has exactly one item", () => {
    const reqs = bridgeReplyToSendRequests("u1", "ctx-br-5", {
      text: "hi",
      imageItems: [
        { encryptQueryParam: "e1", aesKeyBase64: "k1" },
        { encryptQueryParam: "e2", aesKeyBase64: "k2" },
      ],
    });
    for (const req of reqs) {
      assert.strictEqual(req.msg!.item_list!.length, 1);
    }
  });

  it("throws when contextToken is empty", () => {
    assert.throws(
      () => bridgeReplyToSendRequests("u1", "", { text: "hi" }),
      /contextToken is required/,
    );
  });

  it("all requests have BOT message_type and FINISH state", () => {
    const reqs = bridgeReplyToSendRequests("u1", "ctx-br-6", {
      text: "hi",
      imageItems: [{ encryptQueryParam: "e1", aesKeyBase64: "k1" }],
    });
    for (const req of reqs) {
      assert.strictEqual(req.msg!.message_type, MessageType.BOT);
      assert.strictEqual(req.msg!.message_state, MessageState.FINISH);
      assert.strictEqual(req.msg!.from_user_id, "");
      assert.strictEqual(req.msg!.context_token, "ctx-br-6");
    }
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe("truncateForWechat", () => {
  it("returns text unchanged if under limit", () => {
    assert.strictEqual(truncateForWechat("short"), "short");
  });

  it("truncates and appends marker if over limit", () => {
    const long = "a".repeat(5000);
    const result = truncateForWechat(long, 100);
    assert.ok(result.length < long.length);
    assert.ok(result.endsWith("...(已截断)"));
    assert.ok(result.startsWith("a".repeat(100)));
  });

  it("uses default 4000 limit", () => {
    const exact = "x".repeat(4000);
    assert.strictEqual(truncateForWechat(exact), exact);
    const over = "x".repeat(4001);
    assert.ok(truncateForWechat(over).endsWith("...(已截断)"));
  });
});

describe("contentTypeLabel", () => {
  it("maps known types to Chinese labels", () => {
    assert.strictEqual(contentTypeLabel(MessageItemType.TEXT), "文本");
    assert.strictEqual(contentTypeLabel(MessageItemType.IMAGE), "图片");
    assert.strictEqual(contentTypeLabel(MessageItemType.VOICE), "语音");
    assert.strictEqual(contentTypeLabel(MessageItemType.FILE), "文件");
    assert.strictEqual(contentTypeLabel(MessageItemType.VIDEO), "视频");
  });

  it("returns '未知' for unknown type", () => {
    assert.strictEqual(contentTypeLabel(99), "未知");
  });
});
