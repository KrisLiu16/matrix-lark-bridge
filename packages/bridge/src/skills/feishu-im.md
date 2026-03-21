---
name: feishu-im
description: |
  飞书 IM 消息工具集。支持发送/回复文本、图片消息，读取聊天记录，搜索消息，语音识别。

  **当以下情况时使用此 Skill**:
  (1) 用户想发送消息给某人或群聊
  (2) 用户想发送图片
  (3) 用户想查看聊天记录
  (4) 用户想搜索历史消息
  (5) 用户想识别语音消息
---

# 飞书 IM 消息 (feishu-im)

## 执行前必读

- **发送消息需确认**：发消息前必须通过 AskUserQuestion 确认发送对象和内容
- **Bot 身份发送**：消息以 Bot 名义发出，对方看到的发送者是 Bot

## 快速索引

| 用户意图 | 工具 | 必填参数 |
|---------|------|---------|
| 发文本消息 | lark_im_message | action=send, receive_id, msg_type=text, content |
| 回复消息 | lark_im_message | action=reply, message_id, msg_type, content |
| 发图片消息 | 先 lark_im_upload_image → 再 lark_im_message | 见下方流程 |
| 发文件消息 | 先 lark_im_file(upload) → 再 lark_im_message | 见下方流程 |
| 下载 Bot 文件 | lark_im_file | action=download, file_key |
| 查聊天记录 | lark_im_get_messages | chat_id 或 open_id |
| 搜索消息 | lark_im_search_messages | query |
| 下载图片/文件 | lark_im_fetch_resource | message_id, file_key, type |
| 识别语音 | lark_speech_recognize | message_id + file_key 或 file_path |

## 发送图片流程（两步）

### Step 1: 上传图片获取 image_key

```json
// lark_im_upload_image
{ "file_path": "/path/to/image.png" }
```

返回 `{ image_key: "img_v3_xxx" }`。

### Step 2: 用 image_key 发送图片消息

```json
// lark_im_message
{
  "action": "send",
  "receive_id_type": "chat_id",
  "receive_id": "oc_xxx",
  "msg_type": "image",
  "content": "{\"image_key\":\"img_v3_xxx\"}"
}
```

## 发送文件流程（两步）

### Step 1: 上传文件获取 file_key

```json
// lark_im_file
{ "action": "upload", "file_path": "/path/to/report.pdf" }
```

返回 `{ file_key: "file_xxx", file_type: "pdf" }`。支持所有格式，未知扩展名自动归为 stream。

### Step 2: 用 file_key 发送文件消息

```json
// lark_im_message
{
  "action": "send",
  "receive_id_type": "chat_id",
  "receive_id": "oc_xxx",
  "msg_type": "file",
  "content": "{\"file_key\":\"file_xxx\"}"
}
```

### 下载 Bot 上传的文件

```json
// lark_im_file
{ "action": "download", "file_key": "file_xxx", "output_path": "/path/to/save.pdf" }
```

不提供 output_path 时自动保存到工作目录 `downloads/` 下。

## 消息类型 content 格式

| msg_type | content 示例 |
|----------|-------------|
| text | `{"text":"你好"}` |
| image | `{"image_key":"img_xxx"}` |
| post | `{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文"}]]}}` |
| interactive | 卡片 JSON |

## 语音识别

从消息历史获取语音文件后识别：

```json
// lark_speech_recognize
{ "message_id": "om_xxx", "file_key": "file_xxx" }
```

或识别本地音频文件：

```json
{ "file_path": "/path/to/audio.ogg" }
```

返回 `{ recognition_text: "识别的文字" }`。

## 注意事项

- content 必须是 JSON **字符串**，不是对象
- `receive_id_type`: `chat_id`（群聊）或 `open_id`（私聊）
- 图片上传限制 10MB，支持 JPG/PNG/WEBP/GIF/BMP
- 语音识别限制 60 秒，需要飞书应用开启 `speech_to_text:speech` 权限
- 语音识别需要飞书付费版
