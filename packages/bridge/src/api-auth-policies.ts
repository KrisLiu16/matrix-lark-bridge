/**
 * API Auth Policy Table — data-driven token routing for lark_api generic tool.
 *
 * Replaces hardcoded regex rules in mcp-server.ts with a policy table that maps
 * (API path pattern, HTTP method) → (preferred token, fallback, required scopes).
 *
 * Policies are evaluated in order — more specific patterns should come first.
 * When no policy matches, lark_api falls back to 'auto' mode (same as before).
 */

export interface ApiAuthPolicy {
  /** URL path regex pattern (tested against the full API path) */
  pattern: RegExp;
  /** HTTP methods this policy applies to. Empty = all methods */
  methods?: string[];
  /** Preferred token type */
  preferred: 'tenant' | 'user';
  /** Allow fallback to the other token type? */
  fallback: boolean;
  /** Required OAuth scopes (for user token). Empty = no scope check */
  scopes: string[];
  /** Human-readable description for debugging */
  description: string;
}

export const API_AUTH_POLICIES: ApiAuthPolicy[] = [
  // ── IM: Bot identity (tenant) ──
  // Bot 发消息/回复/更新 — 必须 TAT，不允许冒充用户
  {
    pattern: /\/im\/v1\/messages/,
    methods: ['POST', 'PUT', 'PATCH'],
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'IM message send/reply/update — bot identity',
  },
  // 消息撤回 — 只能撤回 bot 自己的消息
  {
    pattern: /\/im\/v1\/messages\/[^/]+\/delete/,
    methods: ['DELETE'],
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'IM message recall — bot only',
  },
  // 图片上传 — bot 上传用于发消息
  {
    pattern: /\/im\/v1\/images/,
    methods: ['POST'],
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'IM image upload — bot identity',
  },
  // 消息反应 — bot 身份
  {
    pattern: /\/im\/v1\/messages\/[^/]+\/reactions/,
    methods: ['POST', 'DELETE'],
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'IM reactions — bot identity',
  },
  // Bot info
  {
    pattern: /\/bot\/v3\/info/,
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'Bot info — tenant only',
  },

  // ── IM: User identity (read) ──
  // 获取消息历史 — 用户身份
  {
    pattern: /\/im\/v1\/messages/,
    methods: ['GET'],
    preferred: 'user',
    fallback: true,
    scopes: ['im:message:readonly', 'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user'],
    description: 'IM message list/get — user identity preferred',
  },
  // 搜索消息 — 用户身份
  {
    pattern: /\/search\/v1\/message/,
    preferred: 'user',
    fallback: false,
    scopes: ['search:message', 'im:message:readonly'],
    description: 'IM message search — user only',
  },
  // IM 资源下载 — auto
  {
    pattern: /\/im\/v1\/messages\/[^/]+\/resources/,
    methods: ['GET'],
    preferred: 'user',
    fallback: true,
    scopes: ['im:message:readonly'],
    description: 'IM resource download — user preferred, bot fallback',
  },
  // 群聊管理 — 用户身份
  {
    pattern: /\/im\/v1\/chats/,
    methods: ['GET'],
    preferred: 'user',
    fallback: true,
    scopes: ['im:chat:read'],
    description: 'Chat list/get — user preferred',
  },
  // P2P 聊天查询
  {
    pattern: /\/im\/v1\/chat_p2p/,
    preferred: 'user',
    fallback: false,
    scopes: ['im:chat:read'],
    description: 'P2P chat query — user only',
  },

  // ── Calendar: User identity ──
  {
    pattern: /\/calendar\/v4\//,
    preferred: 'user',
    fallback: false,
    scopes: ['calendar:calendar:read', 'calendar:calendar.event:read'],
    description: 'Calendar APIs — user identity',
  },

  // ── Task: User identity ──
  {
    pattern: /\/task\/v2\//,
    preferred: 'user',
    fallback: false,
    scopes: ['task:task:read', 'task:task:write'],
    description: 'Task APIs — user identity',
  },

  // ── Bitable: User identity ──
  {
    pattern: /\/bitable\/v1\//,
    preferred: 'user',
    fallback: true,
    scopes: ['base:record:retrieve', 'base:app:read'],
    description: 'Bitable APIs — user preferred',
  },

  // ── Docs/Docx: User identity ──
  {
    pattern: /\/docx\/v1\//,
    preferred: 'user',
    fallback: false,
    scopes: ['docx:document:readonly'],
    description: 'Docx APIs — user identity',
  },

  // ── Drive: User identity ──
  {
    pattern: /\/drive\/v1\//,
    preferred: 'user',
    fallback: false,
    scopes: ['space:document:retrieve', 'drive:drive.metadata:readonly'],
    description: 'Drive APIs — user identity',
  },

  // ── Search: User identity ──
  {
    pattern: /\/search\/v2\//,
    preferred: 'user',
    fallback: false,
    scopes: ['search:docs:read'],
    description: 'Search APIs — user identity',
  },

  // ── Sheets: User identity ──
  {
    pattern: /\/sheets\/v[23]\//,
    preferred: 'user',
    fallback: true,
    scopes: ['sheets:spreadsheet:read', 'sheets:spreadsheet.meta:read'],
    description: 'Sheets APIs — user preferred',
  },

  // ── Wiki: User identity ──
  {
    pattern: /\/wiki\/v2\//,
    preferred: 'user',
    fallback: true,
    scopes: ['wiki:node:read', 'wiki:space:read'],
    description: 'Wiki APIs — user preferred',
  },

  // ── Contact departments: Tenant preferred ──
  // 部门查询 — tenant 有全局视角，user 只能看自己所在部门
  {
    pattern: /\/contact\/v3\/departments/,
    preferred: 'tenant',
    fallback: true,
    scopes: ['contact:department.base:readonly'],
    description: 'Contact departments — tenant preferred, user fallback',
  },

  // ── Contact: User identity ──
  {
    pattern: /\/contact\/v3\//,
    preferred: 'user',
    fallback: true,
    scopes: ['contact:contact.base:readonly', 'contact:user.base:readonly'],
    description: 'Contact APIs — user preferred',
  },

  // ── Mail: User identity ──
  // 发送邮件 — 只能以用户身份发送
  {
    pattern: /\/mail\/v1\/mailboxes\/[^/]+\/messages\/send/,
    methods: ['POST'],
    preferred: 'user',
    fallback: false,
    scopes: ['mail:user_mailbox:send_as_user'],
    description: 'Mail send — user only',
  },
  // 读取/管理邮件 — 用户优先，租户可读取（需额外权限）
  {
    pattern: /\/mail\/v1\//,
    preferred: 'user',
    fallback: true,
    scopes: ['mail:user_mailbox:read'],
    description: 'Mail APIs — user preferred, tenant fallback',
  },

  // ── Approval: Tenant only ──
  // 审批 API 全部使用 tenant token（管理视角）
  {
    pattern: /\/approval\/v4\//,
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'Approval APIs — tenant only',
  },

  // ── Attendance: Tenant only ──
  // 考勤 API 只支持 tenant token
  {
    pattern: /\/attendance\/v1\//,
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'Attendance APIs — tenant only',
  },

  // ── VC: User preferred ──
  // 视频会议 — 用户身份优先（查看自己的会议），tenant 可降级
  {
    pattern: /\/vc\/v1\//,
    preferred: 'user',
    fallback: true,
    scopes: [],
    description: 'VC APIs — user preferred, tenant fallback',
  },

  // ── Auth: Tenant only ──
  {
    pattern: /\/auth\/v3\//,
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'Auth APIs — tenant only',
  },

  // ── ASR: Tenant only ──
  {
    pattern: /\/speech_to_text\//,
    preferred: 'tenant',
    fallback: false,
    scopes: [],
    description: 'Speech recognition — tenant only',
  },
];

/**
 * Find the auth policy for a given API path and HTTP method.
 * Returns the first matching policy, or null if no match.
 * Policies are evaluated in order — more specific patterns should come first.
 */
export function findApiAuthPolicy(path: string, method: string): ApiAuthPolicy | null {
  for (const policy of API_AUTH_POLICIES) {
    if (!policy.pattern.test(path)) continue;
    if (policy.methods && !policy.methods.includes(method.toUpperCase())) continue;
    return policy;
  }
  return null;
}
