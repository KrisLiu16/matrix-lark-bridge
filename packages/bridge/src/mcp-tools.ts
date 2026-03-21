/**
 * MCP Tool Definitions — aligned with feishu-openclaw official plugin.
 *
 * Pure data file: exports tool name, description, inputSchema for each tool.
 * Execution logic lives in mcp-tool-handlers.ts.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── OAPI Tools (SDK-driven) ────────────────────────────────────────────────

export const OAPI_TOOLS: McpToolDefinition[] = [
  // ── Calendar ──
  {
    name: 'lark_calendar_event',
    description: '【以用户身份】飞书日程管理工具。Actions: create（创建日历事件）, list（查询时间范围内的日程，自动展开重复日程）, get（获取日程详情）, patch（更新日程）, delete（删除日程）, search（搜索日程）, reply（回复日程邀请）, instances（获取重复日程的实例列表）, instance_view（查看展开后的日程列表）。【重要】create 时必须传 user_open_id 参数（ou_xxx），否则日程只在应用日历上，用户看不到。时间参数使用ISO 8601格式（包含时区），例如 \'2024-01-01T00:00:00+08:00\'。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'get', 'patch', 'delete', 'search', 'reply', 'instances', 'instance_view'], description: 'Action to perform' },
        calendar_id: { type: 'string', description: 'Calendar ID (optional; primary calendar used if omitted)' },
        event_id: { type: 'string', description: 'Event ID (required for get/patch/delete/reply/instances)' },
        summary: { type: 'string', description: '日程标题' },
        description: { type: 'string', description: '日程描述' },
        start_time: { type: 'string', description: '开始时间（ISO 8601格式，如 2024-01-01T00:00:00+08:00）' },
        end_time: { type: 'string', description: '结束时间（ISO 8601格式）' },
        user_open_id: { type: 'string', description: '当前用户的 open_id（ou_xxx）。create 时强烈建议提供，确保用户能看到日程。' },
        attendees: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['user', 'chat', 'resource', 'third_party'] }, id: { type: 'string' } }, required: ['type', 'id'] }, description: '参会人列表' },
        location: { type: 'object', properties: { name: { type: 'string' }, address: { type: 'string' } }, description: '地点信息' },
        need_notification: { type: 'boolean', description: '是否通知参会人（delete时使用）' },
        query: { type: 'string', description: '搜索关键词（search action）' },
        rsvp_status: { type: 'string', enum: ['accept', 'decline', 'tentative'], description: '回复状态（reply action）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lark_calendar_freebusy',
    description: '【以用户身份】飞书日历忙闲查询工具。查询某时间段内某人是否空闲。支持批量查询 1-10 个用户。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list'], description: 'Action (only "list")' },
        time_min: { type: 'string', description: '查询起始时间（ISO 8601格式）' },
        time_max: { type: 'string', description: '查询结束时间（ISO 8601格式）' },
        user_ids: { type: 'array', items: { type: 'string' }, description: '用户 open_id 列表（1-10 个）' },
      },
      required: ['action', 'time_min', 'time_max', 'user_ids'],
    },
  },
  // ── Task ──
  {
    name: 'lark_task',
    description: '【以用户身份】飞书任务管理工具。Actions: create（创建任务）, get（获取任务详情）, list（查询任务列表）, patch（更新任务/完成任务）。完成任务：patch + completed_at="2026-01-01 15:00:00"；反完成：completed_at="0"。时间使用ISO 8601格式。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'list', 'patch'], description: 'Action' },
        task_guid: { type: 'string', description: '任务 GUID（get/patch 必填）' },
        summary: { type: 'string', description: '任务标题（create 必填）' },
        description: { type: 'string', description: '任务描述' },
        current_user_id: { type: 'string', description: '当前用户 open_id（ou_xxx），强烈建议提供' },
        due: { type: 'object', properties: { timestamp: { type: 'string' }, is_all_day: { type: 'boolean' } }, description: '截止时间' },
        start: { type: 'object', properties: { timestamp: { type: 'string' }, is_all_day: { type: 'boolean' } }, description: '开始时间' },
        members: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string', enum: ['assignee', 'follower'] } }, required: ['id'] }, description: '任务成员' },
        completed_at: { type: 'string', description: '完成时间（ISO 8601格式），设为 "0" 表示反完成' },
        completed: { type: 'boolean', description: '是否完成（list 过滤）' },
        tasklists: { type: 'array', items: { type: 'object', properties: { tasklist_guid: { type: 'string' }, section_guid: { type: 'string' } } }, description: '归属任务清单' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lark_tasklist',
    description: '【以用户身份】飞书任务清单管理工具。Actions: create（创建清单）, list（查询清单列表）, get（获取清单详情）, tasks（查看清单内的任务）, add_members（添加清单成员）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'get', 'tasks', 'add_members'], description: 'Action' },
        tasklist_guid: { type: 'string', description: '清单 GUID（get/tasks/add_members 必填）' },
        name: { type: 'string', description: '清单名称（create 必填）' },
        members: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string', enum: ['editor', 'viewer'] }, type: { type: 'string', enum: ['user', 'chat'] } }, required: ['id'] }, description: '清单成员' },
        completed: { type: 'boolean', description: '是否完成（tasks 过滤）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  // ── Bitable ──
  {
    name: 'lark_bitable_record',
    description: '飞书多维表格记录管理工具。Actions: create（创建单条记录）, list（查询记录，支持高级筛选）, update（更新记录）, delete（删除记录）, batch_create（批量创建≤500条）, batch_update（批量更新≤500条）, batch_delete（批量删除≤500条）。【重要】写入前先用 lark_bitable_field.list 获取字段类型。人员字段：[{id:"ou_xxx"}]；日期字段：毫秒时间戳；单选：字符串；多选：字符串数组。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'batch_create', 'batch_update', 'batch_delete'], description: 'Action' },
        app_token: { type: 'string', description: '多维表格 token' },
        table_id: { type: 'string', description: '数据表 ID' },
        record_id: { type: 'string', description: '记录 ID（update/delete）' },
        fields: { type: 'object', additionalProperties: true, description: '记录字段' },
        records: { type: 'array', items: { type: 'object', properties: { fields: { type: 'object', additionalProperties: true }, record_id: { type: 'string' } } }, description: '批量操作的记录列表（≤500条）' },
        record_ids: { type: 'array', items: { type: 'string' }, description: '批量删除的记录 ID 列表' },
        filter: { type: 'object', properties: { conjunction: { type: 'string', enum: ['and', 'or'] }, conditions: { type: 'array', items: { type: 'object' } } }, description: '筛选条件（list）' },
        sort: { type: 'array', items: { type: 'object', properties: { field_name: { type: 'string' }, desc: { type: 'boolean' } } }, description: '排序（list）' },
        field_names: { type: 'array', items: { type: 'string' }, description: '返回字段名列表（list）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'app_token', 'table_id'],
    },
  },
  {
    name: 'lark_bitable_field',
    description: '飞书多维表格字段管理工具。Actions: list（查询字段列表）, create（创建字段）。写入记录前必须先 list 字段获取 type 和 ui_type。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], description: 'Action' },
        app_token: { type: 'string', description: '多维表格 token' },
        table_id: { type: 'string', description: '数据表 ID' },
        field_name: { type: 'string', description: '字段名称（create）' },
        type: { type: 'number', description: '字段类型（create）' },
        property: { type: 'object', additionalProperties: true, description: '字段属性配置（create）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'app_token', 'table_id'],
    },
  },
  {
    name: 'lark_bitable_table',
    description: '飞书多维表格数据表管理工具。Actions: list（查询数据表列表）, create（创建数据表）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], description: 'Action' },
        app_token: { type: 'string', description: '多维表格 token' },
        name: { type: 'string', description: '数据表名称（create）' },
        fields: { type: 'array', items: { type: 'object', properties: { field_name: { type: 'string' }, type: { type: 'number' }, property: { type: 'object', additionalProperties: true } }, required: ['field_name', 'type'] }, description: '字段列表（create，可选）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'app_token'],
    },
  },
  {
    name: 'lark_bitable_app',
    description: '飞书多维表格 App 管理工具。Actions: create（创建多维表格应用）, get（获取应用信息）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get'], description: 'Action' },
        app_token: { type: 'string', description: '多维表格 token（get 必填）' },
        name: { type: 'string', description: '多维表格名称（create 必填）' },
        folder_token: { type: 'string', description: '文件夹 token（create，可选）' },
      },
      required: ['action'],
    },
  },
  // ── Search ──
  {
    name: 'lark_search',
    description: '【以用户身份】飞书文档搜索工具。搜索云文档和知识库。支持按文档类型、时间范围、空间等条件过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search'], description: 'Action (only "search")' },
        query: { type: 'string', description: '搜索关键词（可选，不传表示空搜）' },
        filter: {
          type: 'object',
          properties: {
            doc_types: { type: 'array', items: { type: 'string', enum: ['DOC', 'SHEET', 'BITABLE', 'MINDNOTE', 'FILE', 'WIKI', 'DOCX', 'FOLDER', 'SLIDES'] }, description: '文档类型过滤' },
            create_time: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, description: '创建时间范围（ISO 8601）' },
            update_time: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, description: '更新时间范围（ISO 8601）' },
          },
          description: '过滤条件',
        },
        sort_type: { type: 'string', enum: ['DEFAULT_TYPE', 'EDIT_TIME', 'CREATE_TIME'], description: '排序方式' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  // ── Sheets ──
  {
    name: 'lark_sheet',
    description: '飞书电子表格工具。Actions: info（获取表格信息+工作表列表）, read（读取工作表数据）, write（写入数据）, append（追加行数据）, find（查找内容）, create（创建电子表格）。支持 URL 或 spreadsheet_token。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'read', 'write', 'append', 'find', 'create'], description: 'Action' },
        spreadsheet_token: { type: 'string', description: '电子表格 token 或 URL' },
        sheet_id: { type: 'string', description: '工作表 ID' },
        range: { type: 'string', description: '范围（如 A1:D10）' },
        values: { type: 'array', items: { type: 'array' }, description: '写入/追加的数据（二维数组）' },
        find: { type: 'string', description: '查找内容（find action）' },
        title: { type: 'string', description: '表格标题（create action）' },
        folder_token: { type: 'string', description: '文件夹 token（create action）' },
        headers: { type: 'array', items: { type: 'string' }, description: '表头（create action）' },
      },
      required: ['action'],
    },
  },
  // ── Wiki ──
  {
    name: 'lark_wiki_node',
    description: '飞书知识库节点管理工具。Actions: list（列出子节点）, get（获取节点信息，含 obj_type/obj_token）。get 用于解析 wiki URL 的实际文档类型。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: 'Action' },
        space_id: { type: 'string', description: '空间 ID（list 必填）' },
        token: { type: 'string', description: '节点 token（get 必填）' },
        parent_node_token: { type: 'string', description: '父节点 token（list，可选）' },
        obj_type: { type: 'string', enum: ['doc', 'sheet', 'mindnote', 'bitable', 'file', 'docx', 'slides', 'wiki'], description: '对象类型（get，可选）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  // ── Common ──
  {
    name: 'lark_get_user',
    description: '获取用户信息。不传 user_id 时获取当前用户自己的信息；传 user_id 时获取指定用户的信息。返回用户姓名、头像、邮箱、手机号、部门等。',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '用户 ID（ou_xxx）。不传则获取当前用户信息。' },
        user_id_type: { type: 'string', enum: ['open_id', 'union_id', 'user_id'], description: '用户 ID 类型（默认 open_id）' },
      },
    },
  },
  {
    name: 'lark_search_user',
    description: '搜索/查找用户。通过邮箱或手机号查找用户的 open_id。',
    inputSchema: {
      type: 'object',
      properties: {
        emails: { type: 'array', items: { type: 'string' }, description: '邮箱列表' },
        mobiles: { type: 'array', items: { type: 'string' }, description: '手机号列表' },
      },
    },
  },
  // ── IM Messages ──
  {
    name: 'lark_im_message',
    description: '【以 Bot 身份】飞书 IM 消息发送/回复工具。Actions: send（发送消息到私聊或群聊）, reply（回复指定消息）。【安全说明】此工具以 Bot 身份发送消息，对方看到的发送者是 Bot。调用前必须先向用户确认：1) 发送对象 2) 消息内容。禁止在用户未明确同意的情况下自行发送消息。【确认方式】必须通过发送 interactive 类型的确认卡片给用户（而非纯文本确认），卡片应包含：发送对象、消息类型、消息内容预览、Bot 身份提示，以及「✅ 确认发送」和「❌ 取消」按钮（按钮仅做展示，用户回复文字确认即可）。用户明确确认后再调用本工具发送。content 必须是合法 JSON 字符串，格式取决于 msg_type。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'reply'], description: 'Action' },
        receive_id_type: { type: 'string', enum: ['open_id', 'chat_id'], description: '接收者 ID 类型（send 必填）：open_id（私聊）或 chat_id（群聊）' },
        receive_id: { type: 'string', description: '接收者 ID（send 必填），与 receive_id_type 对应' },
        message_id: { type: 'string', description: '被回复消息的 ID（reply 必填，om_xxx 格式）' },
        msg_type: { type: 'string', enum: ['text', 'post', 'image', 'file', 'interactive', 'share_chat', 'share_user'], description: '消息类型' },
        content: { type: 'string', description: '消息内容（JSON 字符串）。text → \'{"text":"你好"}\', image → \'{"image_key":"img_xxx"}\', post → \'{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文"}]]}}\'' },
        reply_in_thread: { type: 'boolean', description: '是否以话题形式回复（reply action）' },
        uuid: { type: 'string', description: '幂等唯一标识，1小时内同 uuid 只发一条' },
      },
      required: ['action', 'msg_type', 'content'],
    },
  },
  {
    name: 'lark_im_upload_image',
    description: '【以 Bot 身份】上传图片到飞书，获取 image_key。用于发送图片消息前的准备步骤：先用本工具上传图片获取 image_key，再用 lark_im_message 发送 msg_type=image 的消息。支持本地文件路径。限制：不超过 10MB，支持 PNG/JPEG/GIF/BMP/TIFF/WEBP。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '本地图片文件的绝对路径' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'lark_im_file',
    description: '【以 Bot 身份】飞书 IM 文件上传/下载工具。Actions: upload（上传本地文件到飞书获取 file_key，用于发送文件消息）, download（通过 file_key 下载 Bot 上传的文件到本地）。支持所有文件格式：opus/mp4/pdf/doc/xls/ppt 以及其他任意格式（自动归为 stream 类型）。上传限制 30MB，下载限制 100MB。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['upload', 'download'], description: 'Action' },
        file_path: { type: 'string', description: '本地文件路径（upload 必填）' },
        file_key: { type: 'string', description: '文件 Key（download 必填，file_xxx 格式）' },
        output_path: { type: 'string', description: '下载保存路径（download，不提供则自动保存到工作目录）' },
        duration: { type: 'number', description: '音视频时长（毫秒，upload 可选，仅 opus/mp4）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lark_im_get_messages',
    description: '【以用户身份】获取群聊或单聊的历史消息。通过 chat_id 获取群聊/单聊消息，或通过 open_id 获取与指定用户的单聊消息。支持时间范围过滤和分页。',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '会话 ID（oc_xxx），与 open_id 互斥' },
        open_id: { type: 'string', description: '用户 open_id（ou_xxx），获取与该用户的单聊消息，与 chat_id 互斥' },
        start_time: { type: 'string', description: '起始时间（ISO 8601 格式）' },
        end_time: { type: 'string', description: '结束时间（ISO 8601 格式）' },
        sort_rule: { type: 'string', enum: ['create_time_asc', 'create_time_desc'], description: '排序方式（默认 create_time_desc）' },
        page_size: { type: 'number', description: '每页消息数（1-50，默认 50）' },
        page_token: { type: 'string', description: '分页标记' },
      },
    },
  },
  {
    name: 'lark_im_search_messages',
    description: '【以用户身份】跨会话搜索飞书消息。按关键词、发送者、被@用户、消息类型、时间范围等条件搜索。所有参数均可选，但至少应提供一个过滤条件。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        sender_ids: { type: 'array', items: { type: 'string' }, description: '发送者 open_id 列表' },
        chat_id: { type: 'string', description: '限定搜索范围的会话 ID（oc_xxx）' },
        message_type: { type: 'string', enum: ['file', 'image', 'media'], description: '消息类型过滤' },
        start_time: { type: 'string', description: '起始时间（ISO 8601）' },
        end_time: { type: 'string', description: '结束时间（ISO 8601）' },
        page_size: { type: 'number', description: '每页数（1-50）' },
        page_token: { type: 'string', description: '分页标记' },
      },
    },
  },
  {
    name: 'lark_im_fetch_resource',
    description: '【以用户身份】下载飞书 IM 消息中的文件或图片资源到本地。从消息列表/搜索获取到 message_id 和 file_key 后使用。文件保存到 /tmp，返回 saved_path。限制：不超过 100MB。',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '消息 ID（om_xxx 格式）' },
        file_key: { type: 'string', description: '资源 Key。图片用 image_key（img_xxx），文件用 file_key（file_xxx）' },
        type: { type: 'string', enum: ['image', 'file'], description: '资源类型：image（图片消息中的图片）或 file（文件/音频/视频）' },
      },
      required: ['message_id', 'file_key', 'type'],
    },
  },
  // ── Chat ──
  {
    name: 'lark_chat',
    description: '【以用户身份】飞书群聊管理工具。Actions: search（搜索群列表，支持关键词匹配群名称、群成员）, get（获取指定群的详细信息，包括群名称、描述、群主、权限配置等）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'get'], description: 'Action' },
        query: { type: 'string', description: '搜索关键词（search 必填）' },
        chat_id: { type: 'string', description: '群 ID（get 必填，oc_xxx 格式）' },
        page_size: { type: 'number', description: '分页大小（默认 20）' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lark_chat_members',
    description: '【以用户身份】获取指定群组的成员列表。返回成员 ID、姓名等。注意：不返回群组内的机器人成员。',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '群 ID（oc_xxx 格式）' },
        member_id_type: { type: 'string', enum: ['open_id', 'union_id', 'user_id'], description: '成员 ID 类型（默认 open_id）' },
        page_size: { type: 'number', description: '分页大小（默认 20）' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['chat_id'],
    },
  },
  // ── Drive ──
  {
    name: 'lark_drive_file',
    description: '【以用户身份】飞书云空间文件管理工具。Actions: list（列出文件夹文件）, get_meta（批量获取元数据）, copy（复制）, move（移动）, delete（删除）, upload（上传本地文件到云空间，≤15MB 一次上传，>15MB 分片上传）, download（下载文件到本地或返回 base64）。消息中的文件读写禁止使用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get_meta', 'copy', 'move', 'delete', 'upload', 'download'], description: 'Action' },
        folder_token: { type: 'string', description: '文件夹 token（list/copy 目标/create）' },
        file_token: { type: 'string', description: '文件 token（get_meta/copy/move/delete/download 必填）' },
        type: { type: 'string', enum: ['doc', 'sheet', 'file', 'bitable', 'docx', 'folder', 'mindnote', 'slides'], description: '文档类型（copy/move/delete 必填）' },
        name: { type: 'string', description: '目标文件名（copy 必填）' },
        request_docs: { type: 'array', items: { type: 'object', properties: { doc_token: { type: 'string' }, doc_type: { type: 'string' } }, required: ['doc_token', 'doc_type'] }, description: '批量查询文档列表（get_meta，≤50 个）' },
        file_path: { type: 'string', description: '本地文件路径（upload 优先使用）' },
        file_name: { type: 'string', description: '文件名（upload，file_path 自动提取）' },
        output_path: { type: 'string', description: '下载保存路径（download，不提供则返回 base64）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lark_doc_media',
    description: '【以用户身份】文档媒体管理工具。Actions: insert（在飞书文档末尾插入本地图片或文件，3步流程：创建Block→上传素材→更新Block）, download（下载文档素材或画板缩略图到本地）。insert 仅支持本地文件路径，最大 20MB。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['insert', 'download'], description: 'Action' },
        doc_id: { type: 'string', description: '文档 ID 或 URL（insert 必填）' },
        file_path: { type: 'string', description: '本地文件的绝对路径（insert 必填）' },
        type: { type: 'string', enum: ['image', 'file'], description: '媒体类型（insert，默认 image）' },
        align: { type: 'string', enum: ['left', 'center', 'right'], description: '对齐方式（insert，仅图片，默认 center）' },
        caption: { type: 'string', description: '图片描述（insert，仅图片）' },
        resource_token: { type: 'string', description: '资源标识（download 必填）' },
        resource_type: { type: 'string', enum: ['media', 'whiteboard'], description: '资源类型（download 必填）' },
        output_path: { type: 'string', description: '保存路径（download 必填）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lark_doc_comments',
    description: '【以用户身份】管理云文档评论。Actions: list（获取评论列表含完整回复）, create（添加全文评论，支持文本、@用户、超链接）, patch（解决/恢复评论）。支持 wiki token 自动转换。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'patch'], description: 'Action' },
        file_token: { type: 'string', description: '云文档 token 或 wiki 节点 token' },
        file_type: { type: 'string', enum: ['doc', 'docx', 'sheet', 'file', 'slides', 'wiki'], description: '文档类型' },
        is_whole: { type: 'boolean', description: '是否只获取全文评论（list）' },
        is_solved: { type: 'boolean', description: '是否只获取已解决评论（list）' },
        elements: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['text', 'mention', 'link'] }, text: { type: 'string' }, open_id: { type: 'string' }, url: { type: 'string' } }, required: ['type'] }, description: '评论内容元素（create 必填）' },
        comment_id: { type: 'string', description: '评论 ID（patch 必填）' },
        is_solved_value: { type: 'boolean', description: '解决状态：true=解决 false=恢复（patch 必填）' },
        page_size: { type: 'number', description: '分页大小' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'file_token', 'file_type'],
    },
  },
  // ── Calendar Attendee ──
  {
    name: 'lark_calendar_attendee',
    description: '【以用户身份】飞书日程参会人管理工具。Actions: list（查看参会人列表）, add（添加参会人）, remove（移除参会人）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Action' },
        calendar_id: { type: 'string', description: '日历 ID（默认 primary）' },
        event_id: { type: 'string', description: '日程 ID（必填）' },
        attendees: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['user', 'chat', 'resource', 'third_party'] }, id: { type: 'string' } }, required: ['type', 'id'] }, description: '参会人列表（add/remove 必填）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'event_id'],
    },
  },
  // ── Task extensions ──
  {
    name: 'lark_task_comment',
    description: '【以用户身份】飞书任务评论工具。Actions: list（获取任务评论列表）, create（添加评论）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], description: 'Action' },
        task_guid: { type: 'string', description: '任务 GUID（必填）' },
        content: { type: 'string', description: '评论内容（create 必填）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'task_guid'],
    },
  },
  {
    name: 'lark_task_subtask',
    description: '【以用户身份】飞书任务子任务工具。Actions: list（获取子任务列表）, create（创建子任务）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], description: 'Action' },
        task_guid: { type: 'string', description: '父任务 GUID（必填）' },
        summary: { type: 'string', description: '子任务标题（create 必填）' },
        description: { type: 'string', description: '子任务描述（create）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'task_guid'],
    },
  },
  // ── Bitable View ──
  {
    name: 'lark_bitable_view',
    description: '飞书多维表格视图管理工具。Actions: list（获取视图列表）, create（创建视图）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], description: 'Action' },
        app_token: { type: 'string', description: '多维表格 token' },
        table_id: { type: 'string', description: '数据表 ID' },
        view_name: { type: 'string', description: '视图名称（create 必填）' },
        view_type: { type: 'string', enum: ['grid', 'kanban', 'calendar', 'gallery', 'gantt', 'form'], description: '视图类型（create 必填）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action', 'app_token', 'table_id'],
    },
  },
  // ── Wiki Space ──
  {
    name: 'lark_wiki_space',
    description: '飞书知识空间管理工具。Actions: list（获取知识空间列表）, get（获取知识空间详情）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: 'Action' },
        space_id: { type: 'string', description: '空间 ID（get 必填）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  // ── Sheet Export ──
  {
    name: 'lark_sheet_export',
    description: '飞书电子表格导出工具。将电子表格导出为 xlsx/csv 文件并下载到本地。异步操作：先创建导出任务，再轮询状态，最后下载文件。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'query', 'download'], description: 'Action: create（创建导出任务）, query（查询任务状态）, download（下载导出文件）' },
        spreadsheet_token: { type: 'string', description: '电子表格 token（create 必填）' },
        file_extension: { type: 'string', enum: ['xlsx', 'csv'], description: '导出格式（create，默认 xlsx）' },
        ticket: { type: 'string', description: '导出任务 ticket（query/download 必填）' },
        file_token: { type: 'string', description: '导出文件 token（download 必填，从 query 返回获取）' },
        output_path: { type: 'string', description: '本地保存路径（download，不提供返回 base64）' },
      },
      required: ['action'],
    },
  },
  // ── Mail ──
  {
    name: 'lark_mail',
    description: '【以用户身份】飞书邮件工具。Actions: list（获取邮件列表）, get（获取邮件详情，含正文和附件信息）, send（发送邮件，支持 HTML 正文和附件）。发送邮件前必须向用户确认收件人和邮件内容。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'send'], description: 'Action' },
        mailbox_id: { type: 'string', description: '邮箱 ID（通常为 me，表示当前用户邮箱）' },
        message_id: { type: 'string', description: '邮件 ID（get 必填）' },
        subject: { type: 'string', description: '邮件主题（send 必填）' },
        to: { type: 'array', items: { type: 'object', properties: { mail_address: { type: 'string' }, name: { type: 'string' } }, required: ['mail_address'] }, description: '收件人列表（send 必填）' },
        cc: { type: 'array', items: { type: 'object', properties: { mail_address: { type: 'string' }, name: { type: 'string' } }, required: ['mail_address'] }, description: '抄送人列表（send，可选）' },
        body_html: { type: 'string', description: '邮件正文 HTML（send 必填）' },
        body_plain_text: { type: 'string', description: '邮件纯文本正文（send，可选降级）' },
        _user_confirmed: { type: 'boolean', description: '用户已通过 AskUserQuestion 确认操作（send 必须先确认）' },
        page_size: { type: 'number', description: '每页数量（list）' },
        page_token: { type: 'string', description: '分页标记（list）' },
      },
      required: ['action'],
    },
  },
  // ── Approval ──
  {
    name: 'lark_approval',
    description: '【以 Bot/租户身份】飞书审批管理工具。Actions: get_definition（获取审批定义/表单结构）, list_instances（查询审批实例列表）, get_instance（获取审批实例详情，含审批历史和表单值）, create（发起审批实例）。所有操作均使用租户身份。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get_definition', 'list_instances', 'get_instance', 'create'], description: 'Action' },
        approval_code: { type: 'string', description: '审批定义 code（get_definition/list_instances/create 必填）' },
        instance_id: { type: 'string', description: '审批实例 ID（get_instance 必填）' },
        start_time: { type: 'string', description: '起始时间（list_instances，Unix 毫秒时间戳）' },
        end_time: { type: 'string', description: '结束时间（list_instances，Unix 毫秒时间戳）' },
        open_id: { type: 'string', description: '发起人 open_id（create 必填）' },
        form: { type: 'string', description: '表单内容 JSON 字符串（create 必填），格式参见审批定义的 form 字段' },
        node_approver_open_id_list: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'array', items: { type: 'string' } } }, required: ['key', 'value'] }, description: '审批节点审批人（create，可选）' },
        _user_confirmed: { type: 'boolean', description: '用户已通过 AskUserQuestion 确认操作（create 必须先确认）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  // ── Contact Department ──
  {
    name: 'lark_contact_department',
    description: '飞书组织架构部门管理工具。Actions: list（获取子部门列表）, get_users（获取部门直属成员列表）。默认使用租户身份（全局视角），可降级为用户身份。根部门 ID 为 "0"。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get_users'], description: 'Action' },
        department_id: { type: 'string', description: '部门 ID（默认 "0" 表示根部门）' },
        department_id_type: { type: 'string', enum: ['department_id', 'open_department_id'], description: '部门 ID 类型（默认 open_department_id）' },
        fetch_child: { type: 'boolean', description: '是否递归获取子部门（list，默认 false）' },
        page_size: { type: 'number', description: '每页数量' },
        page_token: { type: 'string', description: '分页标记' },
      },
      required: ['action'],
    },
  },
  // ── Speech Recognition (ASR) ──
  {
    name: 'lark_speech_recognize',
    description: '飞书语音识别 (ASR) 工具。将语音文件转为文字。支持两种输入方式：(1) message_id + file_key 从消息下载语音文件；(2) file_path 从本地文件读取。限制：60 秒以内音频。需要 ffmpeg 已安装。',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '消息 ID（om_xxx），与 file_key 配合使用' },
        file_key: { type: 'string', description: '语音文件 key（file_xxx），与 message_id 配合使用' },
        file_path: { type: 'string', description: '本地语音文件路径（替代 message_id + file_key）' },
      },
    },
  },
];

// ─── MCP Doc Tools (HTTP relay to mcp.feishu.cn) ────────────────────────────

export const MCP_DOC_TOOLS: McpToolDefinition[] = [
  {
    name: 'lark_fetch_doc',
    description: '获取飞书云文档内容。返回 Markdown 格式的文档内容。doc_id 支持直接传 URL 或 token。知识库 URL（/wiki/TOKEN）需先用 lark_wiki_node.get 解析实际文档类型。',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '文档 ID 或 URL（必填）' },
        offset: { type: 'number', description: '字符偏移量（可选）' },
        limit: { type: 'number', description: '返回的最大字符数（可选）' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'lark_create_doc',
    description: '创建飞书云文档。从 Lark-flavored Markdown 内容创建新文档。支持指定文件夹(folder_token)、知识库节点(wiki_node)或知识空间(wiki_space)。',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: '文档 Markdown 内容（Lark-flavored格式，必填）' },
        title: { type: 'string', description: '文档标题（可选）' },
        folder_token: { type: 'string', description: '父文件夹 token（可选）' },
        wiki_node: { type: 'string', description: '知识库节点 token（可选，与 folder_token/wiki_space 互斥）' },
        wiki_space: { type: 'string', description: '知识空间 ID（可选，特殊值 my_library 表示个人知识库）' },
      },
      required: ['markdown'],
    },
  },
  {
    name: 'lark_update_doc',
    description: '更新飞书云文档。支持 7 种模式：append（追加到末尾）, overwrite（全文覆盖）, replace_range（定位替换）, replace_all（全文替换）, insert_before（前插入）, insert_after（后插入）, delete_range（删除内容）。定位方式支持 selection_with_ellipsis（内容定位）和 selection_by_title（标题定位）。',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '文档 ID 或 URL（必填）' },
        mode: { type: 'string', enum: ['append', 'overwrite', 'replace_range', 'replace_all', 'insert_before', 'insert_after', 'delete_range'], description: '更新模式（必填）' },
        markdown: { type: 'string', description: '新内容（Markdown）' },
        selection_with_ellipsis: { type: 'string', description: '内容定位（如 "开头内容...结尾内容"）' },
        selection_by_title: { type: 'string', description: '标题定位（如 "## 章节标题"）' },
        new_title: { type: 'string', description: '新文档标题（可选）' },
        task_id: { type: 'string', description: '异步任务 ID（查询异步任务状态）' },
      },
      required: ['doc_id', 'mode'],
    },
  },
];

// ─── Per-tool Token Mode ─────────────────────────────────────────────────────

/**
 * Token mode for each tool/action combination.
 *
 * - 'user':   Always use UAT (user identity). Throws if no UAT available.
 * - 'tenant': Always use TAT (bot identity). Never use UAT.
 * - 'auto':   Use UAT if available, fall back to TAT.
 */
export type TokenMode = 'user' | 'tenant' | 'auto';

/**
 * Per-tool, per-action token mode mapping.
 *
 * Format: { toolName: TokenMode } for simple tools, or
 *         { toolName: { actionName: TokenMode, _default: TokenMode } } for multi-action tools.
 *
 * Rules derived from feishu-openclaw official plugin analysis:
 * - IM send/reply -> ALWAYS tenant (bot identity, never impersonate user)
 * - Read user's docs/calendar/tasks -> UAT when available
 * - Search -> UAT (only finds what user has access to)
 * - Create calendar events -> UAT (need user's open_id)
 */
export const TOOL_TOKEN_MODES: Record<string, TokenMode | Record<string, TokenMode>> = {
  // -- IM tools: send/reply MUST be tenant (bot identity) --
  lark_im_message: {
    send: 'tenant',    // Bot sends messages, never impersonate user
    reply: 'tenant',   // Bot replies, never impersonate user
    _default: 'tenant',
  },
  lark_im_get_messages: 'user',       // Reading message history requires user permission
  lark_im_search_messages: 'user',    // Searching messages requires user permission
  lark_im_upload_image: 'tenant',      // Bot uploads images for sending
  lark_im_file: 'tenant',              // Bot uploads/downloads files
  lark_im_fetch_resource: 'auto',     // Bot-received resources use TAT, user message resources use UAT

  // -- Calendar: all UAT --
  lark_calendar_event: 'user',
  lark_calendar_freebusy: 'user',
  lark_calendar_attendee: 'user',

  // -- Task: all UAT --
  lark_task: 'user',
  lark_tasklist: 'user',
  lark_task_comment: 'user',
  lark_task_subtask: 'user',

  // -- Bitable: all UAT --
  lark_bitable_record: 'user',
  lark_bitable_field: 'user',
  lark_bitable_table: 'user',
  lark_bitable_app: 'user',
  lark_bitable_view: 'user',

  // -- Search/Docs: all UAT --
  lark_search: 'user',
  lark_drive_file: 'user',
  lark_doc_media: 'user',
  lark_doc_comments: 'user',

  // -- Wiki/Sheet: all UAT --
  lark_wiki_node: 'user',
  lark_wiki_space: 'user',
  lark_sheet: 'user',
  lark_sheet_export: 'user',

  // -- Chat: read with user --
  lark_chat: 'user',
  lark_chat_members: 'user',

  // -- Mail --
  lark_mail: {
    list: 'user',
    get: 'user',
    send: 'user',
    _default: 'user',
  },

  // -- Approval --
  lark_approval: 'tenant',  // Approval APIs use tenant token (admin-level access)

  // -- Contact Department --
  lark_contact_department: 'auto',  // Tenant preferred (global view), user fallback

  // -- Speech Recognition --
  lark_speech_recognize: 'tenant',  // ASR API uses tenant token

  // -- Common --
  lark_get_user: 'auto',
  lark_search_user: 'user',

  // -- MCP Doc relay: always UAT (MCP endpoint needs user identity) --
  lark_fetch_doc: 'user',
  lark_create_doc: 'user',
  lark_update_doc: 'user',

  // -- Generic lark_api: path-based auto detection --
  lark_api: 'auto',
};

/**
 * Resolve the token mode for a specific tool call.
 *
 * @param toolName - MCP tool name
 * @param action - Optional action string (from args.action)
 * @returns TokenMode
 */
export function resolveTokenMode(toolName: string, action?: string): TokenMode {
  const mode = TOOL_TOKEN_MODES[toolName];
  if (!mode) return 'auto'; // unknown tool -> auto

  if (typeof mode === 'string') return mode;

  // Multi-action tool: look up action-specific mode
  if (action && mode[action]) return mode[action];
  return mode._default ?? 'auto';
}

// ─── Aggregated exports ─────────────────────────────────────────────────────

export const ALL_TOOLS = [...OAPI_TOOLS, ...MCP_DOC_TOOLS];

export const OAPI_TOOL_NAMES = new Set(OAPI_TOOLS.map(t => t.name));
export const MCP_DOC_TOOL_NAMES = new Set(MCP_DOC_TOOLS.map(t => t.name));
