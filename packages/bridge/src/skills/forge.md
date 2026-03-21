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

## 什么是 Forge

Forge 是独立的 CLI 工具，启动多个 CC 进程组成团队，自主迭代完成复杂任务。
每个角色是一个真正独立的 CC 进程，不是子 agent。

## 启动流程（必须遵守）

### 第一步：需求对齐（卡片交互）

用户提出任务后，发一张飞书卡片展示你的理解，让用户确认或继续补充：

```
卡片标题：Forge 项目设定

项目：竞品分析报告
描述：对比我们的产品和 Slack、钉钉、企业微信

拟定团队：
  - 市场调研员：搜集各竞品功能、定价、用户量
  - 数据分析师：制作对比矩阵、优劣势分析
  - 报告撰写员：生成分析报告文档

强制角色（自动包含）：
  - Leader：统管规划
  - Critic：每轮找问题
  - Verifier：核查真实性

按钮：[确认启动] [我还要补充]
```

用户点"我还要补充"或者直接说话 → 更新设定，再发一张卡片确认。
用户点"确认启动"或者说"确认"/"启动"/"开始" → 进入第二步。

**循环直到用户确认，不要跳过这一步。**

### 第二步：写配置文件

根据确认的设定，生成 forge-project.json：

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
    },
    {
      "name": "analyst",
      "label": "数据分析师",
      "description": "制作对比矩阵和优劣势分析",
      "systemPrompt": "你是数据分析师，负责..."
    },
    {
      "name": "writer",
      "label": "报告撰写员",
      "description": "生成分析报告文档",
      "systemPrompt": "你是报告撰写员，负责..."
    }
  ],
  "model": "opus[1m]",
  "effort": "max",
  "maxConcurrent": 5,
  "createdAt": "2026-03-21T11:50:00Z",
  "createdBy": "ou_xxx",
  "chatId": "oc_xxx"
}
```

保存到 `~/.deepforge/projects/<id>/forge-project.json`

### 第三步：启动 Forge

用 Bash 执行：

```bash
nohup deepforge start --config ~/.deepforge/projects/<id>/forge-project.json \
  >> ~/.deepforge/projects/<id>/forge.log 2>&1 &
disown
echo $! > ~/.deepforge/projects/<id>/forge.pid
```

告诉用户：已启动，PID 多少，工作区在哪。

### 第四步：设定自动监控

启动后立即用 CronCreate 设定定时巡检任务：

```
每 30 分钟检查 Forge 项目 <id>：
1. 检查进程存活（ps -p PID）
2. 读取 forge-state.json 获取 phase/iteration/cost
3. 读取最近的 reports/*.md
4. 如果进程挂了 → 分析 forge.log → 重启
5. 生成飞书文档报告，发送给用户
```

**重要**：同时在项目配置中记录监控需求，这样即使 CC 重启，
看到配置后也知道要恢复监控任务。

在 `~/.deepforge/registry.json` 中记录：

```json
{
  "projects": {
    "<id>": {
      "configPath": "~/.deepforge/projects/<id>/forge-project.json",
      "status": "running",
      "monitor": {
        "enabled": true,
        "intervalMinutes": 30,
        "chatId": "oc_xxx"
      }
    }
  }
}
```

CC 启动时应检查 registry.json，对所有 status=running 且 monitor.enabled=true 的项目
自动恢复 CronCreate 定时巡检。

## 中途交互

### 用户问进展
读取 `~/.deepforge/projects/<id>/forge-state.json` 和 `reports/`，汇报状态。

### 用户注入反馈
将反馈写入 `~/.deepforge/projects/<id>/feedback.md`：
```bash
deepforge inject <id> "用户的反馈内容"
```
或直接用 Write 工具追加到 feedback.md。

### 用户要看产出
读取 artifacts/ 目录下的文件，或发送 PDF/文档给用户。

## 监控恢复

CC 重启后，检查 `~/.deepforge/registry.json`：
1. 遍历所有 status=running 的项目
2. 检查进程是否存活（读 pid 文件 → ps 检查）
3. 如果进程挂了 → 重启
4. 对 monitor.enabled=true 的项目 → CronCreate 恢复定时巡检
5. 通知用户："已恢复对 X 个 Forge 项目的监控"
