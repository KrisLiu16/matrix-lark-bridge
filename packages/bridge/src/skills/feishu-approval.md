---
name: feishu-approval
description: |
  飞书审批工具。支持查看审批定义、查询审批实例、获取详情、发起审批。

  **当以下情况时使用此 Skill**:
  (1) 用户想查看、查询审批单状态
  (2) 用户想发起审批流程
  (3) 用户提到"审批"、"请假"、"报销"、"approval"
---

# 飞书审批 (feishu-approval)

## 执行前必读

- **需要额外权限配置**：审批功能不包含在默认授权中。使用前需要管理员在飞书开放平台（open.feishu.cn）为应用开启以下权限：
  - `approval:approval:readonly` — 查看审批定义和实例
  - `approval:instance` — 创建审批实例
- **身份**：使用 Bot 身份（TAT），无需用户授权
- **发起审批需确认**：创建前必须通过 AskUserQuestion 让用户确认审批内容
- **form 字段**：是 JSON **字符串**（不是对象），格式取决于审批模板定义
- **创建审批前**：必须先调 `get_definition` 了解表单结构，才能正确构造 form

## 快速索引

| 用户意图 | action | 必填参数 | 常用可选 |
|---------|--------|---------|---------|
| 查看审批模板结构 | get_definition | approval_code | — |
| 查询审批列表 | list_instances | approval_code | start_time, end_time, page_size |
| 查看审批详情 | get_instance | instance_id | — |
| 发起审批 | create | approval_code, open_id, form | department_id, uuid |

## 使用流程

### 1. 查看审批模板（必须先做）

```json
{ "action": "get_definition", "approval_code": "ABCD1234-XXXX" }
```

返回 approval_name、form（表单控件 JSON）、node_list（审批节点）。

### 2. 查询审批实例列表

```json
{
  "action": "list_instances",
  "approval_code": "ABCD1234-XXXX",
  "start_time": "1711900800000",
  "end_time": "1711987200000"
}
```

返回 instance_code 列表，需再调 `get_instance` 获取详情。

### 3. 发起审批

```json
{
  "action": "create",
  "approval_code": "ABCD1234-XXXX",
  "open_id": "ou_xxx",
  "form": "[{\"id\":\"field1\",\"type\":\"input\",\"value\":\"请假一天\"}]"
}
```

注意：form 是字符串化的 JSON 数组，结构由 `get_definition` 返回的 form 字段决定。

## 注意事项

- `approval_code` 需要从飞书管理后台获取，或让用户提供
- `list_instances` 的时间参数是**毫秒时间戳**（字符串）
- 审批状态：PENDING（审批中）/ APPROVED / REJECTED / CANCELED / DELETED
- 发起审批不可撤回（只能取消），务必确认
