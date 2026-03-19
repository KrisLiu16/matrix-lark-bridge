import type { StepInfo } from './types.js';

// --- Path shortening ---

function shortPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

// --- Tool display ---

type ToolInput = Record<string, unknown>;

const TOOL_ICON: Record<string, string> = {
  Read: 'file-link_outlined',
  Edit: 'edit_outlined',
  Write: 'richtext_outlined',
  Bash: 'code_outlined',
  Grep: 'search_outlined',
  Glob: 'search_outlined',
  Agent: 'chat_outlined',
  WebFetch: 'cloud_outlined',
  WebSearch: 'search_outlined',
  LSP: 'code_outlined',
  Skill: 'app-default_outlined',
  NotebookEdit: 'edit_outlined',
};

export function toolIcon(tool: string): string {
  if (tool.startsWith('mcp__')) return 'cloud_outlined';
  return TOOL_ICON[tool] || 'setting_outlined';
}

const TOOL_COLOR: Record<string, string> = {
  Read: 'blue',
  Edit: 'orange',
  Write: 'orange',
  Bash: 'purple',
  Grep: 'green',
  Glob: 'green',
  Agent: 'blue',
  WebFetch: 'wathet',
  WebSearch: 'green',
  LSP: 'purple',
  Skill: 'indigo',
  NotebookEdit: 'orange',
};

/** Plain text label for a tool step (used in div elements) */
export function toolLabel(tool: string, input: ToolInput): string {
  const str = (key: string) => (input[key] as string) || '';

  switch (tool) {
    case 'Read':
      return `READ  ${shortPath(str('file_path'))}`;
    case 'Edit':
      return `EDIT  ${shortPath(str('file_path'))}`;
    case 'Write':
      return `WRITE ${shortPath(str('file_path'))}`;
    case 'Bash': {
      const cmd = str('command').split('\n')[0];
      const short = cmd.slice(0, 50);
      return `BASH  ${short}${cmd.length > 50 ? '…' : ''}`;
    }
    case 'Grep':
      return `GREP  ${str('pattern')}${str('path') ? ` in ${shortPath(str('path'))}` : ''}`;
    case 'Glob':
      return `GLOB  ${str('pattern')}`;
    case 'Agent':
      return `AGENT ${str('description')}`;
    case 'WebFetch':
      return `FETCH ${str('url').slice(0, 45)}`;
    case 'WebSearch':
      return `SEARCH ${str('query')}`;
    case 'LSP':
      return `LSP   ${str('operation')} ${shortPath(str('filePath'))}`;
    case 'Skill':
      return `SKILL ${str('skill')}`;
    case 'NotebookEdit':
      return `NOTEBOOK edit`;
    default: {
      // MCP tools: mcp__server__tool_name → "LARK  method /path"
      if (tool.startsWith('mcp__')) {
        const parts = tool.split('__');
        const server = parts[1] || '';
        const method = str('method') || str('operation') || parts.slice(2).join('_');
        const path = str('path') || str('url') || '';
        const short = path.length > 40 ? path.slice(0, 40) + '…' : path;
        return `${server.toUpperCase()}  ${method}${short ? ' ' + short : ''}`;
      }
      return tool.toUpperCase();
    }
  }
}

/** Display text for current step */
export function toolDisplay(tool: string, input: ToolInput): string {
  return toolLabel(tool, input);
}

// --- Tool filtering ---

const FILTERED = new Set([
  'TodoWrite',
  'EnterPlanMode',
  'ExitPlanMode',
  'CronCreate',
  'CronDelete',
  'CronList',
]);

export function isFiltered(name: string): boolean {
  if (!name) return true;
  if (FILTERED.has(name)) return true;
  return false;
}

// --- Card JSON 2.0 builders ---

interface CardHeader {
  title: { tag: 'plain_text'; content: string };
  subtitle?: { tag: 'plain_text'; content: string };
  template: string;
  icon?: { tag: 'standard_icon'; token: string; color?: string };
  text_tag_list?: Array<{
    tag: 'text_tag';
    text: { tag: 'plain_text'; content: string };
    color: string;
  }>;
}

type TagItem = { tag: 'text_tag'; text: { tag: 'plain_text'; content: string }; color: string };

function makeHeader(opts: {
  title: string;
  subtitle?: string;
  template: string;
  icon?: string;
  tags: Array<{ text: string; color: string }>;
}): CardHeader {
  const header: CardHeader = {
    title: { tag: 'plain_text', content: opts.title },
    template: opts.template,
    text_tag_list: opts.tags.map((t): TagItem => ({
      tag: 'text_tag',
      text: { tag: 'plain_text', content: t.text },
      color: t.color,
    })),
  };
  if (opts.icon) {
    header.icon = { tag: 'standard_icon', token: opts.icon };
  }
  if (opts.subtitle) {
    header.subtitle = { tag: 'plain_text', content: opts.subtitle };
  }
  return header;
}

function stepToDiv(step: StepInfo) {
  return {
    tag: 'div',
    icon: {
      tag: 'standard_icon',
      token: toolIcon(step.tool),
      color: TOOL_COLOR[step.tool] || (step.tool.startsWith('mcp__') ? 'turquoise' : 'grey'),
    },
    text: {
      tag: 'plain_text',
      content: step.label,
    },
  };
}

function makeCollapsiblePanel(content: string, label: string, iconToken = 'down-small-ccm_outlined') {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: label },
      vertical_align: 'center',
      padding: '4px 0px 4px 8px',
      icon: {
        tag: 'standard_icon',
        token: iconToken,
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: 180,
    },
    vertical_spacing: '2px',
    background_color: 'default',
    border: { color: 'grey', corner_radius: '5px' },
    elements: [{ tag: 'markdown', content }],
  };
}

function makeCollapsibleHistory(steps: StepInfo[], label: string) {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: label },
      vertical_align: 'center',
      padding: '4px 0px 4px 8px',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: 180,
    },
    vertical_spacing: '2px',
    background_color: 'default',
    border: { color: 'grey', corner_radius: '5px' },
    elements: steps.map(stepToDiv),
  };
}

// --- Public card builders ---

/** Thinking card — shown immediately when user submits prompt */
export function buildThinkingCard(prompt: string, botName = 'MiniMax AI') {
  const short = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: botName,
      subtitle: 'thinking…',
      template: 'blue',
      icon: 'loading_outlined',
      tags: [{ text: '思考中', color: 'blue' }],
    }),
    body: {
      elements: [
        {
          tag: 'div',
          icon: { tag: 'standard_icon', token: 'chat_outlined', color: 'blue' },
          text: { tag: 'plain_text', content: short },
        },
      ],
    },
  };
}

/** Working card — updated on each tool call */
export function buildWorkingCard(
  current: string,
  pastSteps: StepInfo[],
  stepCount: number,
  elapsed: string,
  botName = 'MiniMax AI',
  currentTool = '',
) {
  const currentStep: StepInfo = { tool: currentTool, label: current };
  const elements: unknown[] = [
    currentTool
      ? stepToDiv(currentStep)
      : { tag: 'markdown', content: `▸ ${current}` },
  ];

  if (pastSteps.length > 0) {
    const maxShow = 50;
    const displaySteps = pastSteps.length > maxShow ? pastSteps.slice(-maxShow) : pastSteps;
    const label = pastSteps.length > maxShow
      ? `${pastSteps.length} steps (showing recent ${maxShow})`
      : `${pastSteps.length} steps`;
    elements.push(makeCollapsibleHistory(displaySteps, label));
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: botName,
      subtitle: `${stepCount} steps · ${elapsed}`,
      template: 'indigo',
      icon: 'loading_outlined',
      tags: [{ text: '执行中', color: 'blue' }],
    }),
    body: { elements },
  };
}

/** Convert standard markdown to Feishu card-compatible markdown */
export function toFeishuMarkdown(md: string): string {
  return md
    // Headers -> bold (Feishu cards don't support # headers)
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    // Blockquotes -> just remove the > prefix
    .replace(/^>\s?/gm, '');
}

/** Done card — with reply content and collapsible execution history */
export function buildDoneCard(
  reply: string,
  allSteps: StepInfo[],
  stepCount: number,
  elapsed: string,
  botName = 'MiniMax AI',
  thinking = '',
) {
  const maxLen = 2500;
  const truncated =
    reply.length > maxLen ? reply.slice(0, maxLen) + '\n\n…(truncated)' : reply;

  const tags: Array<{ text: string; color: string }> = [
    { text: '已完成', color: 'green' },
  ];

  const elements: unknown[] = [];

  if (truncated) {
    elements.push({ tag: 'markdown', content: truncated });
  }

  if (thinking) {
    const thinkTrunc = thinking.length > 1500
      ? thinking.slice(0, 1500) + '\n\n…(truncated)'
      : thinking;
    if (truncated) elements.push({ tag: 'hr' });
    elements.push(makeCollapsiblePanel(thinkTrunc, 'Thinking'));
  }

  if (allSteps.length > 0) {
    if (!thinking && truncated) elements.push({ tag: 'hr' });
    const maxShow = 50;
    const displaySteps = allSteps.length > maxShow ? allSteps.slice(-maxShow) : allSteps;
    const label = allSteps.length > maxShow
      ? `执行记录 · ${stepCount} steps (showing recent ${maxShow})`
      : `执行记录 · ${stepCount} steps`;
    elements.push(makeCollapsibleHistory(displaySteps, label));
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: `<font color='grey'>done · ${elapsed}</font>` });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, streaming_mode: false },
    header: makeHeader({
      title: botName,
      template: 'green',
      tags,
    }),
    body: { elements },
  };
}

/** Format current time as MM-DD HH:mm */
export function nowTimestamp(): string {
  const d = new Date();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MM}-${DD} ${HH}:${mm}`;
}

/** Permission request card with Allow/Always Allow/Deny buttons */
export function buildPermissionCard(toolName: string, toolInput?: string) {
  const elements: unknown[] = [
    { tag: 'markdown', content: `**⚠️ Permission Request**\n\nAgent wants to use: **${toolName}**` },
  ];

  if (toolInput) {
    const truncated = toolInput.length > 500 ? toolInput.substring(0, 500) + '...' : toolInput;
    elements.push({ tag: 'markdown', content: '```\n' + truncated + '\n```' });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Allow' },
          type: 'primary',
          value: { action: 'permission_allow' },
        }],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Always Allow' },
          type: 'default',
          value: { action: 'permission_always_allow' },
        }],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Deny' },
          type: 'danger',
          value: { action: 'permission_deny' },
        }],
      },
    ],
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: '🔐 Permission Request',
      template: 'orange',
      icon: 'safe_outlined',
      tags: [{ text: '待审批', color: 'orange' }],
    }),
    body: { elements },
  };
}

/** Permission result card — replaces the permission card after action (V2 format). */
export function buildPermissionResultCard(allowed: boolean, alwaysAllow = false) {
  const label = alwaysAllow
    ? '✅ **Always Allowed**'
    : allowed ? '✅ **Allowed**, continuing...' : '❌ **Denied**';
  const color = allowed ? 'green' : 'red';

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: allowed ? 'Allowed' : 'Denied' },
      template: color,
    },
    body: {
      elements: [{ tag: 'markdown', content: label }],
    },
  };
}

/** Auth card — OAuth authorization with button */
export function buildAuthCard(authUrl: string) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: '飞书授权',
      template: 'blue',
      icon: 'safe_outlined',
      tags: [{ text: '待授权', color: 'blue' }],
    }),
    body: {
      elements: [
        { tag: 'markdown', content: '点击下方按钮完成飞书账号授权，授权后 AI 可使用个人身份访问飞书文档、日程等。' },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [{
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '前往授权' },
              type: 'primary',
              multi_url: { url: authUrl },
            }],
          }],
        },
        { tag: 'markdown', content: `<font color='grey'>点击授权后自动完成，无需复制任何内容。链接 5 分钟内有效。</font>` },
      ],
    },
  };
}

/** Build a simple markdown card (for stream preview) */
export function buildMarkdownCard(content: string) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'markdown', content }],
    },
  };
}

/**
 * Build a compact notice card with colored header.
 * @param title - Header title text
 * @param content - Markdown body (optional)
 * @param color - Header color: 'blue' | 'green' | 'red' | 'orange' | 'grey' | 'indigo'
 */
export function buildNoticeCard(
  title: string,
  content?: string,
  color: 'blue' | 'green' | 'red' | 'orange' | 'grey' | 'indigo' = 'blue',
) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: color,
    },
    body: {
      elements: [{ tag: 'markdown', content: content || ' ' }],
    },
  };
}

/**
 * Build an interactive question card for AskUserQuestion tool.
 * If options are provided, render as clickable buttons.
 * Otherwise render a prompt asking user to type their answer.
 */
export function buildAskUserCard(
  question: string,
  options?: string[],
) {
  const elements: unknown[] = [
    { tag: 'markdown', content: question },
  ];

  if (options && options.length > 0) {
    elements.push({ tag: 'hr' });
    for (const [i, opt] of options.entries()) {
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        columns: [{
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: opt },
            type: i === 0 ? 'primary' : 'default',
            value: { action: 'ask_user_answer', answer: opt },
          }],
        }],
      });
    }
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>或直接回复消息输入自定义内容</font>`,
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>请直接回复消息来回答</font>`,
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: '需要你的输入',
      template: 'blue',
      icon: 'chat_outlined',
      tags: [{ text: '待回答', color: 'blue' }],
    }),
    body: { elements },
  };
}

/**
 * Build a compact usage card showing token consumption.
 * NOTE: costUsd intentionally not displayed — do not add it back.
 */
export function buildUsageCard(
  usage: { input: number; output: number; cacheRead: number; cacheCreate: number },
  _costUsd?: number,
) {
  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  const md = `<text_tag color='blue'>Input ${formatK(usage.input)}</text_tag>  <text_tag color='turquoise'>Cache ${formatK(usage.cacheRead)}</text_tag>  <text_tag color='violet'>Output ${formatK(usage.output)}</text_tag>`;

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      padding: '12px 20px 12px 20px',
      elements: [
        {
          tag: 'div',
          icon: { tag: 'standard_icon', token: 'sheet-iconsets-stable_filled', color: 'grey' },
          text: { tag: 'lark_md', content: md },
        },
      ],
    },
  };
}
