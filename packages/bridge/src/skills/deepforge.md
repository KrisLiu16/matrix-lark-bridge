---
name: deepforge
description: |
  多 Agent 编排框架。启动一个自主迭代的 AI 团队，持续执行复杂任务。

  **当以下情况时使用此 Skill**:
  (1) 用户说"帮我启动一个团队"、"用 deepforge"、"/forge"
  (2) 用户描述了一个需要多步骤、多角色协作的复杂任务
  (3) 用户想要一个持续迭代、自主改进的工作流
---

# DeepForge — 多 Agent 编排框架

## 什么是 DeepForge

DeepForge 是独立的 CLI 工具，启动多个 CC 进程组成团队，自主迭代完成复杂任务。
每个角色是一个真正独立的 CC 进程，不是子 agent。
每轮迭代结束后，Leader 会自动通过飞书 Bot 发送进展摘要到发起者的聊天（无需 CC 监控）。

## 启动流程（必须遵守）

### 第一步：需求对齐

用户提出任务后，用 AskUserQuestion 工具展示你的理解，让用户确认或补充：

```
问题：我为你设计了以下 DeepForge 团队，确认启动？

选项：
  - "确认启动"：开始执行
  - "我要调整"：继续修改

在问题描述中列出：
  项目标题、项目描述、拟定角色列表
  （强制角色 Leader/Critic/Verifier 自动包含，不需要列出）
```

用户选"我要调整"或直接说话补充需求 → 更新设定，再用 AskUserQuestion 确认。
用户选"确认启动"或说"确认"/"启动"/"开始" → 进入第二步。

**循环直到用户确认，不要跳过这一步。**

### 第二步：写配置文件

根据确认的设定，生成 deepforge.json。如果当前是 Bot 发起的（有 `LARK_APP_ID`/`LARK_APP_SECRET` 环境变量），则带上飞书凭据，Leader 每轮结束后会自动发飞书消息汇报；否则可省略飞书字段：

```json
{
  "id": "competitive-analysis-2026",
  "title": "竞品分析报告",
  "description": "对比我们的产品和 Slack、钉钉、企业微信...",
  "roles": [
    {
      "name": "researcher",
      "label": "市场调研员",
      "description": "搜集各竞品的功能、定价、用户量数据",
      "systemPrompt": "你是市场调研员，负责..."
    }
  ],
  "model": "opus[1m]",
  "effort": "max",
  "maxConcurrent": 5,
  "createdAt": "2026-03-21T11:50:00Z",
  "createdBy": "ou_xxx",
  "chatId": "oc_xxx",
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "xxx"
}
```

- `chatId`: 当前对话 ID（从 System Context 获取）
- `feishuAppId` / `feishuAppSecret`（可选）: Bot 发起时填写，从环境变量 `LARK_APP_ID`/`LARK_APP_SECRET` 获取。不填则不自动发飞书汇报

保存到 `~/.deepforge/projects/<id>/deepforge.json`

### 第三步：启动 Forge

用 Bash 执行：

```bash
nohup node "$DEEPFORGE_ENTRY" start --config ~/.deepforge/projects/<id>/deepforge.json \
  >> ~/.deepforge/projects/<id>/forge.log 2>&1 &
disown
echo $! > ~/.deepforge/projects/<id>/forge.pid
```

告诉用户：已启动，PID 多少，工作区在哪。每轮迭代结束后 Leader 会自动发飞书消息汇报。

## CLI 命令

```bash
# 启动项目
node "$DEEPFORGE_ENTRY" start --config <配置文件>

# 查看项目列表
node "$DEEPFORGE_ENTRY" list

# 查看项目状态
node "$DEEPFORGE_ENTRY" status <项目ID>

# 注入反馈（Leader 下一轮会读到）
node "$DEEPFORGE_ENTRY" inject <项目ID> "反馈内容"

# 恢复已暂停的项目（可选附带新指令）
node "$DEEPFORGE_ENTRY" resume <项目ID> "改用方案 B"

# 停止项目
node "$DEEPFORGE_ENTRY" stop <项目ID>
```

## 中途交互

### 用户问进展
读取 `~/.deepforge/projects/<id>/forge-state.json` 和 `reports/`，汇报状态。

### 用户注入反馈
```bash
node "$DEEPFORGE_ENTRY" inject <id> "用户的反馈内容"
```
或直接用 Write 工具追加到 feedback.md。

### 用户要改方向并重启
```bash
node "$DEEPFORGE_ENTRY" resume <id> "新的方向说明"
```
resume 会自动杀掉正在运行的旧进程（如果有），将消息写入 feedback.md，重置为 planning 阶段重新开始。无论项目是运行中、已暂停还是已完成，都可以用 resume。

### 用户要看产出
读取 artifacts/ 目录下的文件，或发送 PDF/文档给用户。
