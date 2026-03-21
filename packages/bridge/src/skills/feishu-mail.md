---
name: feishu-mail
description: |
  飞书邮件收发工具。支持查看邮件列表、获取邮件详情、发送邮件。

  **当以下情况时使用此 Skill**:
  (1) 用户想查看、搜索、阅读邮件
  (2) 用户想发送或回复邮件
  (3) 用户提到"邮件"、"收件箱"、"mail"、"email"
---

# 飞书邮件 (feishu-mail)

## 执行前必读

- **需要额外权限配置**：邮件功能不包含在默认授权中。使用前需要管理员在飞书开放平台（open.feishu.cn）为应用开启以下权限，然后用户重新执行 `/auth`：
  - `mail:user_mailbox.message:readonly` — 查询邮件
  - `mail:user_mailbox.message:send` — 发送邮件
  - `mail:user_mailbox.message.body:read` — 读取邮件正文
  - `mail:user_mailbox.message.address:read` — 读取收发件人
  - `mail:user_mailbox.message.subject:read` — 读取邮件主题
- **身份**：使用用户身份（UAT）。用户必须已执行 `/auth` 授权
- **发送邮件需确认**：发送前必须通过 AskUserQuestion 让用户确认收件人和内容
- **mailbox_id**：默认 `me`（当前授权用户），也可传邮箱地址
- **邮件正文**：body_html（HTML）或 body_plain_text（纯文本），至少填一个

## 快速索引

| 用户意图 | action | 必填参数 | 常用可选 |
|---------|--------|---------|---------|
| 查看收件箱 | list | — | page_size, only_unread, folder_id |
| 读邮件详情 | get | message_id | — |
| 发送邮件 | send | subject, to, body_html 或 body_plain_text | cc |

## 使用流程

### 1. 查看收件箱

```json
{ "action": "list", "page_size": 10 }
```

返回邮件 ID 列表。需再调 `get` 获取详情。

### 2. 读取邮件内容

```json
{ "action": "get", "message_id": "xxx" }
```

返回 subject、from、to、body_html/body_plain_text 等。

### 3. 发送邮件

```json
{
  "action": "send",
  "subject": "会议纪要",
  "to": [{"mail_address": "user@example.com", "name": "张三"}],
  "body_html": "<p>附件是今天的会议纪要。</p>"
}
```

## 注意事项

- `list` 只返回 ID，不返回正文，需逐条 `get`
- 发送邮件不可撤回，务必确认后再发
- 附件需 base64url 编码，最大 37MB
