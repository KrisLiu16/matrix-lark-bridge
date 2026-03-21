---
name: feishu-contact
description: |
  飞书通讯录与组织架构工具。支持查询部门列表、部门成员、搜索用户。

  **当以下情况时使用此 Skill**:
  (1) 用户想查看组织架构、部门信息
  (2) 用户想查某个部门有哪些人
  (3) 用户提到"部门"、"组织架构"、"通讯录"、"department"
  (4) 需要根据人名查找 open_id（用 lark_search_user）
---

# 飞书通讯录 (feishu-contact)

## 执行前必读

- **部门查询需要额外权限**：`lark_contact_department` 需要管理员在飞书开放平台为应用开启 `contact:department.base:readonly` 权限
- **用户搜索** (`lark_search_user`) 已包含在默认授权中，无需额外配置

## 工具组合

| 用户意图 | 工具 | action | 必填参数 |
|---------|------|--------|---------|
| 按名字找人 | lark_search_user | — | query |
| 查看部门列表 | lark_contact_department | list | — |
| 查子部门 | lark_contact_department | list | department_id |
| 查部门下的人 | lark_contact_department | get_users | department_id |

## lark_contact_department 用法

### 查看顶级部门

```json
{ "action": "list" }
```

默认 `department_id: "0"`（根部门）。返回直属子部门列表。

### 查看子部门

```json
{ "action": "list", "department_id": "od-xxx", "fetch_child": true }
```

`fetch_child: true` 递归获取所有子部门。

### 查看部门成员

```json
{ "action": "get_users", "department_id": "od-xxx" }
```

返回直属用户列表（name、email、phone 等），不递归。

## lark_search_user 用法

```json
{ "query": "张三" }
```

按名字模糊搜索，返回 open_id、name、department 等信息。

## 注意事项

- 部门 ID 推荐用 `open_department_id`（`od-` 前缀）
- 根部门 ID 固定为 `"0"`
- 用 TAT 查根部门需要全组织通讯录权限；用 UAT 按用户可见性过滤
- `get_users` 只返回直属成员，不递归子部门
- 先用 `lark_search_user` 按名字搜人更简单
