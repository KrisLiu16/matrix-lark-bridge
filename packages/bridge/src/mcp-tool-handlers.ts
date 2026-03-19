/**
 * MCP Tool Handlers — SDK execution logic for OAPI tools.
 *
 * Each tool dispatches by action, calling @larksuiteoapi/node-sdk typed methods.
 * For APIs without typed wrappers, falls back to sdk.request().
 *
 * Aligned with feishu-openclaw official plugin's tool implementations.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';

type RequestOptions = ReturnType<typeof lark.withUserAccessToken> | undefined;

// ─── Constants ──────────────────────────────────────────────────────────────

/** UTC+8 (Asia/Shanghai); extract to config if needed for other regions */
const TZ_OFFSET_HOURS = 8;
const TZ_OFFSET_STRING = '+08:00';

// ─── Time helpers (ported from feishu-openclaw helpers.js) ──────────────────

export function parseTimeToTimestamp(input: string): string | null {
  try {
    const trimmed = input.trim();
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);
    if (hasTimezone) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1000).toString();
    }
    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1000).toString();
    }
    const [, year, month, day, hour, minute, second] = match;
    const utcDate = new Date(Date.UTC(
      parseInt(year), parseInt(month) - 1, parseInt(day),
      parseInt(hour) - TZ_OFFSET_HOURS, parseInt(minute), parseInt(second ?? '0'),
    ));
    return Math.floor(utcDate.getTime() / 1000).toString();
  } catch {
    return null;
  }
}

export function parseTimeToTimestampMs(input: string): string | null {
  const ts = parseTimeToTimestamp(input);
  if (!ts) return null;
  return (parseInt(ts, 10) * 1000).toString();
}

export function parseTimeToRFC3339(input: string): string | null {
  try {
    const trimmed = input.trim();
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);
    if (hasTimezone) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return trimmed;
    }
    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return trimmed.includes('T') ? `${trimmed}${TZ_OFFSET_STRING}` : trimmed;
    }
    const [, year, month, day, hour, minute, second] = match;
    const sec = second ?? '00';
    return `${year}-${month}-${day}T${hour}:${minute}:${sec}${TZ_OFFSET_STRING}`;
  } catch {
    return null;
  }
}

// ─── Path Parameter Validation ──────────────────────────────────────────────

/** Validate that a user-provided ID matches expected format (alphanumeric + underscore + hyphen) */
function validatePathParam(value: unknown, name: string): string {
  const s = String(value ?? '');
  if (!s || !/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`Invalid ${name}: "${s}". Expected alphanumeric characters, underscores, or hyphens.`);
  }
  return s;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function executeOapiTool(
  sdk: lark.Client,
  toolName: string,
  args: Record<string, unknown>,
  opts: RequestOptions,
): Promise<unknown> {
  switch (toolName) {
    case 'lark_calendar_event': return executeCalendarEvent(sdk, args, opts);
    case 'lark_calendar_freebusy': return executeCalendarFreebusy(sdk, args, opts);
    case 'lark_task': return executeTask(sdk, args, opts);
    case 'lark_tasklist': return executeTasklist(sdk, args, opts);
    case 'lark_bitable_record': return executeBitableRecord(sdk, args, opts);
    case 'lark_bitable_field': return executeBitableField(sdk, args, opts);
    case 'lark_bitable_table': return executeBitableTable(sdk, args, opts);
    case 'lark_bitable_app': return executeBitableApp(sdk, args, opts);
    case 'lark_search': return executeSearch(sdk, args, opts);
    case 'lark_sheet': return executeSheet(sdk, args, opts);
    case 'lark_wiki_node': return executeWikiNode(sdk, args, opts);
    case 'lark_get_user': return executeGetUser(sdk, args, opts);
    case 'lark_search_user': return executeSearchUser(sdk, args, opts);
    case 'lark_im_message': return executeImMessage(sdk, args, opts);
    case 'lark_im_get_messages': return executeImGetMessages(sdk, args, opts);
    case 'lark_im_search_messages': return executeImSearchMessages(sdk, args, opts);
    case 'lark_im_fetch_resource': return executeImFetchResource(sdk, args, opts);
    case 'lark_chat': return executeChat(sdk, args, opts);
    case 'lark_chat_members': return executeChatMembers(sdk, args, opts);
    case 'lark_drive_file': return executeDriveFile(sdk, args, opts);
    case 'lark_doc_media': return executeDocMedia(sdk, args, opts);
    case 'lark_doc_comments': return executeDocComments(sdk, args, opts);
    case 'lark_calendar_attendee': return executeCalendarAttendee(sdk, args, opts);
    case 'lark_task_comment': return executeTaskComment(sdk, args, opts);
    case 'lark_task_subtask': return executeTaskSubtask(sdk, args, opts);
    case 'lark_bitable_view': return executeBitableView(sdk, args, opts);
    case 'lark_wiki_space': return executeWikiSpace(sdk, args, opts);
    case 'lark_sheet_export': return executeSheetExport(sdk, args, opts);
    default: throw new Error(`Unknown OAPI tool: ${toolName}`);
  }
}

// ─── Calendar Event ─────────────────────────────────────────────────────────

async function executeCalendarEvent(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const calendarId = (args.calendar_id as string) || 'primary';

  switch (args.action) {
    case 'create': {
      const startTs = parseTimeToTimestamp(args.start_time as string);
      const endTs = parseTimeToTimestamp(args.end_time as string);
      if (!startTs || !endTs) throw new Error('时间格式错误！必须使用ISO 8601格式，例如 2024-01-01T00:00:00+08:00');

      const eventData: any = {
        summary: args.summary as string,
        start_time: { timestamp: startTs },
        end_time: { timestamp: endTs },
        need_notification: true,
        attendee_ability: 'can_modify_event',
      };
      if (args.description) eventData.description = args.description;
      if (args.location) eventData.location = args.location;

      const res = await sdk.calendar.calendarEvent.create({
        path: { calendar_id: calendarId },
        data: eventData,
      }, opts);

      // Add attendees (including user_open_id)
      const attendees = [...((args.attendees as any[]) || [])];
      if (args.user_open_id) {
        const already = attendees.some((a: any) => a.type === 'user' && a.id === args.user_open_id);
        if (!already) attendees.push({ type: 'user', id: args.user_open_id });
      }

      let attendeeWarning: string | undefined;
      if (attendees.length > 0 && (res as any)?.data?.event?.event_id) {
        const operateId = (args.user_open_id as string) ?? attendees.find((a: any) => a.type === 'user')?.id;
        const attendeeData = attendees.map((a: any) => ({
          type: a.type,
          user_id: a.type === 'user' ? a.id : undefined,
          chat_id: a.type === 'chat' ? a.id : undefined,
          room_id: a.type === 'resource' ? a.id : undefined,
          third_party_email: a.type === 'third_party' ? a.id : undefined,
          operate_id: operateId,
        }));
        try {
          await sdk.calendar.calendarEventAttendee.create({
            path: { calendar_id: calendarId, event_id: (res as any).data.event.event_id },
            params: { user_id_type: 'open_id' },
            data: { attendees: attendeeData, need_notification: true },
          }, opts);
        } catch (err) {
          attendeeWarning = `日程已创建，但添加参会人失败：${(err as Error).message}`;
        }
      }

      const result: any = { event: (res as any)?.data?.event, attendees };
      if (attendeeWarning) result.warning = attendeeWarning;
      else if (attendees.length === 0) result.note = '未添加参会人，用户可能看不到日程。建议传入 user_open_id 参数。';
      return result;
    }

    case 'list': {
      if (!args.start_time || !args.end_time) throw new Error('start_time and end_time are required for list action');
      const startTs = parseTimeToTimestamp(args.start_time as string);
      const endTs = parseTimeToTimestamp(args.end_time as string);
      if (!startTs || !endTs) throw new Error('时间格式错误！必须使用ISO 8601格式。');
      const res = await sdk.calendar.calendarEvent.instanceView({
        path: { calendar_id: calendarId },
        params: { start_time: startTs, end_time: endTs, user_id_type: 'open_id' } as any,
      }, opts);
      return { events: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'get': {
      if (!args.event_id) throw new Error('event_id is required');
      const res = await sdk.calendar.calendarEvent.get({
        path: { calendar_id: calendarId, event_id: args.event_id as string },
      }, opts);
      return { event: (res as any)?.data?.event };
    }

    case 'patch': {
      if (!args.event_id) throw new Error('event_id is required');
      const updateData: any = {};
      if (args.summary) updateData.summary = args.summary;
      if (args.description) updateData.description = args.description;
      if (args.start_time) {
        const ts = parseTimeToTimestamp(args.start_time as string);
        if (!ts) throw new Error('start_time 格式错误');
        updateData.start_time = { timestamp: ts };
      }
      if (args.end_time) {
        const ts = parseTimeToTimestamp(args.end_time as string);
        if (!ts) throw new Error('end_time 格式错误');
        updateData.end_time = { timestamp: ts };
      }
      if (args.location) updateData.location = typeof args.location === 'string' ? { name: args.location } : args.location;
      const res = await sdk.calendar.calendarEvent.patch({
        path: { calendar_id: calendarId, event_id: args.event_id as string },
        data: updateData,
      }, opts);
      return { event: (res as any)?.data?.event };
    }

    case 'delete': {
      if (!args.event_id) throw new Error('event_id is required');
      await sdk.calendar.calendarEvent.delete({
        path: { calendar_id: calendarId, event_id: args.event_id as string },
        params: { need_notification: (args.need_notification ?? true) as any },
      }, opts);
      return { success: true, event_id: args.event_id };
    }

    case 'search': {
      if (!args.query) throw new Error('query is required');
      const res = await sdk.calendar.calendarEvent.search({
        path: { calendar_id: calendarId },
        params: { page_size: args.page_size as any, page_token: args.page_token as any },
        data: { query: args.query as string },
      }, opts);
      return { events: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'reply': {
      if (!args.event_id) throw new Error('event_id is required');
      if (!args.rsvp_status) throw new Error('rsvp_status is required');
      await sdk.calendar.calendarEvent.reply({
        path: { calendar_id: calendarId, event_id: args.event_id as string },
        data: { rsvp_status: args.rsvp_status as any },
      }, opts);
      return { success: true, event_id: args.event_id, rsvp_status: args.rsvp_status };
    }

    case 'instances': {
      if (!args.event_id) throw new Error('event_id is required');
      if (!args.start_time || !args.end_time) throw new Error('start_time and end_time are required for instances action');
      const startTs = parseTimeToTimestamp(args.start_time as string);
      const endTs = parseTimeToTimestamp(args.end_time as string);
      if (!startTs || !endTs) throw new Error('start_time and end_time format error (ISO 8601)');
      const res = await sdk.calendar.calendarEvent.instances({
        path: { calendar_id: calendarId, event_id: args.event_id as string },
        params: { start_time: startTs, end_time: endTs, page_size: args.page_size as any, page_token: args.page_token as any },
      }, opts);
      return { instances: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'instance_view': {
      const startTs = parseTimeToTimestamp(args.start_time as string);
      const endTs = parseTimeToTimestamp(args.end_time as string);
      if (!startTs || !endTs) throw new Error('start_time and end_time are required (ISO 8601)');
      const res = await sdk.calendar.calendarEvent.instanceView({
        path: { calendar_id: calendarId },
        params: { start_time: startTs, end_time: endTs, user_id_type: 'open_id', page_size: args.page_size as any, page_token: args.page_token as any } as any,
      }, opts);
      return { events: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    default:
      throw new Error(`Unknown calendar event action: ${args.action}`);
  }
}

// ─── Calendar Freebusy ──────────────────────────────────────────────────────

async function executeCalendarFreebusy(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const timeMin = parseTimeToRFC3339(args.time_min as string);
  const timeMax = parseTimeToRFC3339(args.time_max as string);
  if (!timeMin || !timeMax) throw new Error('时间格式错误！必须使用ISO 8601格式。');
  const userIds = args.user_ids as string[];
  if (!userIds || userIds.length === 0) throw new Error('user_ids is required (1-10 users)');

  const res = await (sdk.calendar.freebusy as any).batch({
    data: { time_min: timeMin, time_max: timeMax, user_ids: userIds, include_external_calendar: true, only_busy: true },
  }, opts);
  return { freebusy_lists: (res as any)?.data?.freebusy_lists ?? [] };
}

// ─── Task ───────────────────────────────────────────────────────────────────

async function executeTask(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'create': {
      if (!args.summary) throw new Error('summary is required');
      const taskData: any = { summary: args.summary };
      if (args.description) taskData.description = args.description;
      if (args.due) {
        const due = args.due as any;
        const ts = parseTimeToTimestampMs(due.timestamp);
        if (!ts) throw new Error('due.timestamp 格式错误');
        taskData.due = { timestamp: ts, is_all_day: due.is_all_day ?? false };
      }
      if (args.start) {
        const start = args.start as any;
        const ts = parseTimeToTimestampMs(start.timestamp);
        if (!ts) throw new Error('start.timestamp 格式错误');
        taskData.start = { timestamp: ts, is_all_day: start.is_all_day ?? false };
      }
      if (args.members) {
        taskData.members = (args.members as any[]).map(m => ({
          id: m.id,
          type: 'user',
          role: m.role || 'assignee',
        }));
      }
      if (args.tasklists) taskData.tasklists = args.tasklists;

      const res = await sdk.request({
        method: 'POST',
        url: '/open-apis/task/v2/tasks',
        data: taskData,
        params: { user_id_type: 'open_id' },
      }, opts);

      // Auto-add current_user_id as follower if not in members
      const task = (res as any)?.data?.task;
      if (args.current_user_id && task?.guid) {
        const memberIds = (args.members as any[] || []).map((m: any) => m.id);
        if (!memberIds.includes(args.current_user_id)) {
          try {
            await sdk.request({
              method: 'POST',
              url: `/open-apis/task/v2/tasks/${task.guid}/add_members`,
              data: { members: [{ id: args.current_user_id, type: 'user', role: 'follower' }] },
              params: { user_id_type: 'open_id' },
            }, opts);
          } catch { /* best effort */ }
        }
      }
      return { task };
    }

    case 'get': {
      if (!args.task_guid) throw new Error('task_guid is required');
      const guid = validatePathParam(args.task_guid, 'task_guid');
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/task/v2/tasks/${guid}`,
        params: { user_id_type: 'open_id' },
      }, opts);
      return { task: (res as any)?.data?.task };
    }

    case 'list': {
      const params: any = { user_id_type: 'open_id' };
      if (args.page_size) params.page_size = args.page_size;
      if (args.page_token) params.page_token = args.page_token;
      if (args.completed !== undefined) params.completed = String(args.completed);
      const res = await sdk.request({
        method: 'GET',
        url: '/open-apis/task/v2/tasks',
        params,
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'patch': {
      if (!args.task_guid) throw new Error('task_guid is required');
      const patchGuid = validatePathParam(args.task_guid, 'task_guid');
      const updateData: any = {};
      if (args.summary) updateData.summary = args.summary;
      if (args.description !== undefined) updateData.description = args.description;
      if (args.completed_at !== undefined) {
        const cat = args.completed_at as string;
        if (cat === '0') {
          updateData.completed_at = '0';
        } else {
          const ts = parseTimeToTimestampMs(cat);
          updateData.completed_at = ts || cat;
        }
      }
      if (args.due) {
        const due = args.due as any;
        const ts = parseTimeToTimestampMs(due.timestamp);
        if (!ts) throw new Error('due.timestamp 格式错误');
        updateData.due = { timestamp: ts, is_all_day: due.is_all_day ?? false };
      }
      const res = await sdk.request({
        method: 'PATCH',
        url: `/open-apis/task/v2/tasks/${patchGuid}`,
        data: { task: updateData },
        params: { user_id_type: 'open_id' },
      }, opts);
      return { task: (res as any)?.data?.task };
    }

    default:
      throw new Error(`Unknown task action: ${args.action}`);
  }
}

// ─── Tasklist ───────────────────────────────────────────────────────────────

async function executeTasklist(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'create': {
      if (!args.name) throw new Error('name is required');
      const data: any = { name: args.name };
      if (args.members) data.members = args.members;
      const res = await sdk.request({
        method: 'POST',
        url: '/open-apis/task/v2/tasklists',
        data,
        params: { user_id_type: 'open_id' },
      }, opts);
      return { tasklist: (res as any)?.data?.tasklist };
    }

    case 'list': {
      const res = await sdk.request({
        method: 'GET',
        url: '/open-apis/task/v2/tasklists',
        params: { user_id_type: 'open_id', page_size: args.page_size as any, page_token: args.page_token as any },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'get': {
      if (!args.tasklist_guid) throw new Error('tasklist_guid is required');
      const tlGuid = validatePathParam(args.tasklist_guid, 'tasklist_guid');
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/task/v2/tasklists/${tlGuid}`,
        params: { user_id_type: 'open_id' },
      }, opts);
      return { tasklist: (res as any)?.data?.tasklist };
    }

    case 'tasks': {
      if (!args.tasklist_guid) throw new Error('tasklist_guid is required');
      const tasksGuid = validatePathParam(args.tasklist_guid, 'tasklist_guid');
      const params: any = { user_id_type: 'open_id' };
      if (args.page_size) params.page_size = args.page_size;
      if (args.page_token) params.page_token = args.page_token;
      if (args.completed !== undefined) params.completed = String(args.completed);
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/task/v2/tasklists/${tasksGuid}/tasks`,
        params,
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'add_members': {
      if (!args.tasklist_guid) throw new Error('tasklist_guid is required');
      if (!args.members) throw new Error('members is required');
      const addGuid = validatePathParam(args.tasklist_guid, 'tasklist_guid');
      const res = await sdk.request({
        method: 'POST',
        url: `/open-apis/task/v2/tasklists/${addGuid}/add_members`,
        data: { members: args.members },
        params: { user_id_type: 'open_id' },
      }, opts);
      return { tasklist: (res as any)?.data?.tasklist };
    }

    default:
      throw new Error(`Unknown tasklist action: ${args.action}`);
  }
}

// ─── Bitable Record ─────────────────────────────────────────────────────────

async function executeBitableRecord(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const appToken = args.app_token as string;
  const tableId = args.table_id as string;

  switch (args.action) {
    case 'create': {
      if (!args.fields) throw new Error('fields is required');
      const res = await sdk.bitable.appTableRecord.create({
        path: { app_token: appToken, table_id: tableId },
        data: { fields: args.fields as any },
      }, opts);
      return { record: (res as any)?.data?.record };
    }

    case 'list': {
      // Use search API (POST) for advanced filtering
      const data: any = {};
      if (args.filter) data.filter = args.filter;
      if (args.sort) data.sort = args.sort;
      if (args.field_names) data.field_names = args.field_names;
      if (args.page_size) data.page_size = args.page_size;
      if (args.page_token) data.page_token = args.page_token;
      const res = await sdk.bitable.appTableRecord.search({
        path: { app_token: appToken, table_id: tableId },
        data,
      }, opts);
      return { items: (res as any)?.data?.items, total: (res as any)?.data?.total, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'update': {
      if (!args.record_id) throw new Error('record_id is required');
      if (!args.fields) throw new Error('fields is required');
      const res = await sdk.bitable.appTableRecord.update({
        path: { app_token: appToken, table_id: tableId, record_id: args.record_id as string },
        data: { fields: args.fields as any },
      }, opts);
      return { record: (res as any)?.data?.record };
    }

    case 'delete': {
      if (!args.record_id) throw new Error('record_id is required');
      await sdk.bitable.appTableRecord.delete({
        path: { app_token: appToken, table_id: tableId, record_id: args.record_id as string },
      }, opts);
      return { success: true, record_id: args.record_id };
    }

    case 'batch_create': {
      if (!args.records) throw new Error('records is required');
      const res = await sdk.bitable.appTableRecord.batchCreate({
        path: { app_token: appToken, table_id: tableId },
        data: { records: args.records as any },
      }, opts);
      return { records: (res as any)?.data?.records };
    }

    case 'batch_update': {
      if (!args.records) throw new Error('records is required');
      const res = await sdk.bitable.appTableRecord.batchUpdate({
        path: { app_token: appToken, table_id: tableId },
        data: { records: args.records as any },
      }, opts);
      return { records: (res as any)?.data?.records };
    }

    case 'batch_delete': {
      if (!args.record_ids) throw new Error('record_ids is required');
      await sdk.bitable.appTableRecord.batchDelete({
        path: { app_token: appToken, table_id: tableId },
        data: { records: args.record_ids as any },
      }, opts);
      return { success: true };
    }

    default:
      throw new Error(`Unknown bitable record action: ${args.action}`);
  }
}

// ─── Bitable Field ──────────────────────────────────────────────────────────

async function executeBitableField(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const appToken = args.app_token as string;
  const tableId = args.table_id as string;

  switch (args.action) {
    case 'list': {
      const res = await sdk.bitable.appTableField.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: args.page_size as any, page_token: args.page_token as any },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'create': {
      if (!args.field_name) throw new Error('field_name is required');
      if (args.type === undefined) throw new Error('type is required');
      const data: any = { field_name: args.field_name, type: args.type };
      if (args.property) data.property = args.property;
      const res = await sdk.bitable.appTableField.create({
        path: { app_token: appToken, table_id: tableId },
        data,
      }, opts);
      return { field: (res as any)?.data?.field };
    }

    default:
      throw new Error(`Unknown bitable field action: ${args.action}`);
  }
}

// ─── Bitable Table ──────────────────────────────────────────────────────────

async function executeBitableTable(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const appToken = args.app_token as string;

  switch (args.action) {
    case 'list': {
      const res = await sdk.bitable.appTable.list({
        path: { app_token: appToken },
        params: { page_size: args.page_size as any, page_token: args.page_token as any },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'create': {
      if (!args.name) throw new Error('name is required');
      const table: any = { name: args.name };
      if (args.fields) table.fields = args.fields;
      const res = await sdk.bitable.appTable.create({
        path: { app_token: appToken },
        data: { table },
      }, opts);
      return { table: (res as any)?.data };
    }

    default:
      throw new Error(`Unknown bitable table action: ${args.action}`);
  }
}

// ─── Bitable App ────────────────────────────────────────────────────────────

async function executeBitableApp(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'create': {
      if (!args.name) throw new Error('name is required');
      const data: any = { name: args.name };
      if (args.folder_token) data.folder_token = args.folder_token;
      const res = await sdk.bitable.app.create({ data }, opts);
      return { app: (res as any)?.data?.app };
    }

    case 'get': {
      if (!args.app_token) throw new Error('app_token is required');
      const res = await sdk.bitable.app.get({
        path: { app_token: args.app_token as string },
      }, opts);
      return { app: (res as any)?.data?.app };
    }

    default:
      throw new Error(`Unknown bitable app action: ${args.action}`);
  }
}

// ─── Search ─────────────────────────────────────────────────────────────────

async function executeSearch(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const data: any = {};
  if (args.query) data.query = args.query;
  if (args.filter) {
    const filter = args.filter as any;
    if (filter.doc_types) data.docs_types = filter.doc_types;
    if (filter.create_time) {
      const cr = filter.create_time;
      data.create_time_range = {};
      if (cr.start) { const ts = parseTimeToTimestamp(cr.start); if (ts) data.create_time_range.start = parseInt(ts, 10); }
      if (cr.end) { const ts = parseTimeToTimestamp(cr.end); if (ts) data.create_time_range.end = parseInt(ts, 10); }
    }
    if (filter.update_time) {
      const ur = filter.update_time;
      data.update_time_range = {};
      if (ur.start) { const ts = parseTimeToTimestamp(ur.start); if (ts) data.update_time_range.start = parseInt(ts, 10); }
      if (ur.end) { const ts = parseTimeToTimestamp(ur.end); if (ts) data.update_time_range.end = parseInt(ts, 10); }
    }
  }
  if (args.sort_type) data.sort_type = args.sort_type;

  const res = await sdk.request({
    method: 'POST',
    url: '/open-apis/search/v2/doc_wiki/search',
    data,
    params: { page_size: args.page_size as any, page_token: args.page_token as any, user_id_type: 'open_id' },
  }, opts);
  return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
}

// ─── Sheet ──────────────────────────────────────────────────────────────────

async function executeSheet(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  // Parse URL to extract token if needed
  let spreadsheetToken = args.spreadsheet_token as string;
  if (spreadsheetToken?.startsWith('http')) {
    try {
      const u = new URL(spreadsheetToken);
      const match = u.pathname.match(/\/(?:sheets|wiki)\/([^/?#]+)/);
      if (match) spreadsheetToken = match[1];
    } catch { /* use as-is */ }
  }
  // Validate after URL extraction (used in path interpolation)
  if (spreadsheetToken) spreadsheetToken = validatePathParam(spreadsheetToken, 'spreadsheet_token');

  switch (args.action) {
    case 'info': {
      if (!spreadsheetToken) throw new Error('spreadsheet_token is required');
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}`,
      }, opts);
      const sheetsRes = await sdk.request({
        method: 'GET',
        url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
      }, opts);
      return { spreadsheet: (res as any)?.data?.spreadsheet, sheets: (sheetsRes as any)?.data?.sheets };
    }

    case 'read': {
      if (!spreadsheetToken) throw new Error('spreadsheet_token is required');
      const sheetId = args.sheet_id as string;
      const range = args.range as string;
      let fullRange: string;
      if (sheetId && range) fullRange = `${sheetId}!${range}`;
      else if (sheetId) fullRange = sheetId;
      else if (range) fullRange = range;
      else {
        // Read first sheet
        const sheetsRes = await sdk.request({
          method: 'GET',
          url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
        }, opts);
        const firstSheet = ((sheetsRes as any)?.data?.sheets as any[])?.[0];
        fullRange = firstSheet?.sheet_id || 'Sheet1';
      }
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${fullRange}`,
      }, opts);
      return { data: (res as any)?.data };
    }

    case 'write': {
      if (!spreadsheetToken) throw new Error('spreadsheet_token is required');
      if (!args.range) throw new Error('range is required (e.g. sheet_id!A1:D10)');
      if (!args.values) throw new Error('values is required');
      const res = await sdk.request({
        method: 'PUT',
        url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`,
        data: {
          valueRange: {
            range: args.range,
            values: args.values,
          },
        },
      }, opts);
      return { data: (res as any)?.data };
    }

    case 'append': {
      if (!spreadsheetToken) throw new Error('spreadsheet_token is required');
      if (!args.range) throw new Error('range is required');
      if (!args.values) throw new Error('values is required');
      const res = await sdk.request({
        method: 'POST',
        url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_append`,
        data: {
          valueRange: {
            range: args.range,
            values: args.values,
          },
        },
      }, opts);
      return { data: (res as any)?.data };
    }

    case 'find': {
      if (!spreadsheetToken) throw new Error('spreadsheet_token is required');
      if (!args.find) throw new Error('find is required');
      const findSheetId = validatePathParam(args.sheet_id as string || (await getFirstSheetId(sdk, spreadsheetToken, opts)), 'sheet_id');
      const res = await sdk.request({
        method: 'POST',
        url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/${findSheetId}/find`,
        data: { find_condition: { range: args.range || findSheetId, match_case: false, match_entire_cell: false, search_by_regex: false, include_formulas: false }, find: args.find },
      }, opts);
      return { data: (res as any)?.data };
    }

    case 'create': {
      if (!args.title) throw new Error('title is required');
      const data: any = { title: args.title };
      if (args.folder_token) data.folder_token = args.folder_token;
      const res = await sdk.request({
        method: 'POST',
        url: '/open-apis/sheets/v3/spreadsheets',
        data: { spreadsheet: data },
      }, opts);
      const newToken = (res as any)?.data?.spreadsheet?.spreadsheet_token;

      // Write headers if provided
      if (args.headers && newToken) {
        const headerRow = (args.headers as string[]);
        const sheetId = await getFirstSheetId(sdk, newToken, opts);
        await sdk.request({
          method: 'PUT',
          url: `/open-apis/sheets/v2/spreadsheets/${newToken}/values`,
          data: { valueRange: { range: `${sheetId}!A1:${String.fromCharCode(64 + headerRow.length)}1`, values: [headerRow] } },
        }, opts);
      }
      return { spreadsheet: (res as any)?.data?.spreadsheet };
    }

    default:
      throw new Error(`Unknown sheet action: ${args.action}`);
  }
}

async function getFirstSheetId(sdk: lark.Client, token: string, opts: RequestOptions): Promise<string> {
  const res = await sdk.request({
    method: 'GET',
    url: `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`,
  }, opts);
  return ((res as any)?.data?.sheets as any[])?.[0]?.sheet_id || 'Sheet1';
}

// ─── Wiki Node ──────────────────────────────────────────────────────────────

async function executeWikiNode(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'list': {
      if (!args.space_id) throw new Error('space_id is required');
      const spaceId = validatePathParam(args.space_id, 'space_id');
      const params: any = { page_size: args.page_size, page_token: args.page_token };
      if (args.parent_node_token) params.parent_node_token = args.parent_node_token;
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
        params,
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'get': {
      if (!args.token) throw new Error('token is required');
      const params: any = { token: args.token };
      if (args.obj_type) params.obj_type = args.obj_type;
      const res = await sdk.request({
        method: 'GET',
        url: '/open-apis/wiki/v2/spaces/get_node',
        params,
      }, opts);
      return { node: (res as any)?.data?.node };
    }

    default:
      throw new Error(`Unknown wiki node action: ${args.action}`);
  }
}

// ─── Get User ───────────────────────────────────────────────────────────────

async function executeGetUser(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  if (!args.user_id) {
    // Get current user info
    const res = await sdk.request({
      method: 'GET',
      url: '/open-apis/authen/v1/user_info',
    }, opts);
    return { user: (res as any)?.data };
  }

  // Get specific user info
  const userId = validatePathParam(args.user_id, 'user_id');
  const userIdType = (args.user_id_type as string) || 'open_id';
  const res = await sdk.request({
    method: 'GET',
    url: `/open-apis/contact/v3/users/${userId}`,
    params: { user_id_type: userIdType },
  }, opts);
  return { user: (res as any)?.data?.user };
}

// ─── Search User ────────────────────────────────────────────────────────────

async function executeSearchUser(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const data: any = {};
  if (args.emails) data.emails = args.emails;
  if (args.mobiles) data.mobiles = args.mobiles;
  if (!data.emails && !data.mobiles) throw new Error('emails or mobiles is required');

  const res = await sdk.request({
    method: 'POST',
    url: '/open-apis/contact/v3/users/batch_get_id',
    data,
    params: { user_id_type: 'open_id' },
  }, opts);
  return { user_list: (res as any)?.data?.user_list };
}

// ─── IM Message (send/reply) ────────────────────────────────────────────────

async function executeImMessage(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'send': {
      if (!args.receive_id_type) throw new Error('receive_id_type is required for send');
      if (!args.receive_id) throw new Error('receive_id is required for send');
      const res = await sdk.im.v1.message.create({
        params: { receive_id_type: args.receive_id_type as any },
        data: {
          receive_id: args.receive_id as string,
          msg_type: args.msg_type as string,
          content: args.content as string,
          uuid: args.uuid as string | undefined,
        },
      }, opts);
      const data = (res as any)?.data;
      return { message_id: data?.message_id, chat_id: data?.chat_id, create_time: data?.create_time };
    }

    case 'reply': {
      if (!args.message_id) throw new Error('message_id is required for reply');
      const msgId = validatePathParam(args.message_id, 'message_id');
      const res = await sdk.im.v1.message.reply({
        path: { message_id: msgId },
        data: {
          content: args.content as string,
          msg_type: args.msg_type as string,
          reply_in_thread: args.reply_in_thread as boolean | undefined,
          uuid: args.uuid as string | undefined,
        },
      }, opts);
      const data = (res as any)?.data;
      return { message_id: data?.message_id, chat_id: data?.chat_id, create_time: data?.create_time };
    }

    default:
      throw new Error(`Unknown im_message action: ${args.action}`);
  }
}

// ─── IM Get Messages ────────────────────────────────────────────────────────

async function executeImGetMessages(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  if (!args.chat_id && !args.open_id) throw new Error('chat_id or open_id is required');
  if (args.chat_id && args.open_id) throw new Error('chat_id and open_id are mutually exclusive');

  let chatId = args.chat_id as string ?? '';
  if (args.open_id) {
    // Resolve open_id to p2p chat_id
    const p2pRes = await sdk.request({
      method: 'POST',
      url: '/open-apis/im/v1/chat_p2p/batch_query',
      data: { chatter_ids: [args.open_id] },
      params: { user_id_type: 'open_id' },
    }, opts);
    const chats = (p2pRes as any)?.data?.p2p_chats;
    if (!chats?.length) throw new Error(`No P2P chat found for open_id=${args.open_id}`);
    chatId = chats[0].chat_id;
  }

  const startTs = args.start_time ? parseTimeToTimestamp(args.start_time as string) : undefined;
  const endTs = args.end_time ? parseTimeToTimestamp(args.end_time as string) : undefined;
  const sortType = args.sort_rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc';

  const res = await sdk.im.v1.message.list({
    params: {
      container_id_type: 'chat',
      container_id: chatId,
      start_time: startTs ?? undefined,
      end_time: endTs ?? undefined,
      sort_type: sortType as any,
      page_size: (args.page_size as number) ?? 50,
      page_token: args.page_token as string | undefined,
    },
  }, opts);

  return {
    items: (res as any)?.data?.items,
    has_more: (res as any)?.data?.has_more,
    page_token: (res as any)?.data?.page_token,
  };
}

// ─── IM Search Messages ─────────────────────────────────────────────────────

async function executeImSearchMessages(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const startTs = args.start_time ? parseTimeToTimestamp(args.start_time as string) : undefined;
  const endTs = args.end_time ? parseTimeToTimestamp(args.end_time as string) : undefined;

  const searchData: any = {
    query: (args.query as string) || '',
    start_time: startTs || '978307200', // 2001-01-01 as default
    end_time: endTs || Math.floor(Date.now() / 1000).toString(),
  };
  if (args.sender_ids) searchData.from_ids = args.sender_ids;
  if (args.chat_id) searchData.chat_ids = [args.chat_id];
  if (args.message_type) searchData.message_type = args.message_type;

  const res = await (sdk.search as any).message.create({
    data: searchData,
    params: {
      user_id_type: 'open_id',
      page_size: (args.page_size as number) ?? 50,
      page_token: args.page_token as string | undefined,
    },
  }, opts);

  const messageIds = (res as any)?.data?.items ?? [];
  const hasMore = (res as any)?.data?.has_more ?? false;
  const pageToken = (res as any)?.data?.page_token;

  if (messageIds.length === 0) {
    return { messages: [], has_more: hasMore, page_token: pageToken };
  }

  // Batch get message details
  const queryStr = messageIds.map((id: string) => `message_ids=${encodeURIComponent(id)}`).join('&');
  const mgetRes = await sdk.request({
    method: 'GET',
    url: `/open-apis/im/v1/messages/mget?${queryStr}`,
    params: { user_id_type: 'open_id' },
  }, opts);

  return {
    items: (mgetRes as any)?.data?.items,
    has_more: hasMore,
    page_token: pageToken,
  };
}

// ─── IM Fetch Resource ──────────────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'application/pdf': '.pdf',
  'application/msword': '.doc', 'application/zip': '.zip', 'text/plain': '.txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

async function executeImFetchResource(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const msgId = validatePathParam(args.message_id, 'message_id');
  const fileKey = validatePathParam(args.file_key, 'file_key');

  const res = await sdk.im.v1.messageResource.get({
    params: { type: args.type as string },
    path: { message_id: msgId, file_key: fileKey },
  }, opts);

  // Binary stream response
  const stream = (res as any).getReadableStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);

  const contentType = (res as any)?.headers?.['content-type'] || '';
  const mimeType = contentType ? contentType.split(';')[0].trim() : '';
  const ext = (mimeType ? MIME_TO_EXT[mimeType] : undefined) || (args.type === 'image' ? '.png' : '.bin');

  const tempPath = join(tmpdir(), `mlb-${randomBytes(4).toString('hex')}${ext}`);
  writeFileSync(tempPath, buffer);

  return { message_id: args.message_id, file_key: args.file_key, type: args.type, size_bytes: buffer.length, content_type: contentType, saved_path: tempPath };
}

// ─── Chat ───────────────────────────────────────────────────────────────────

async function executeChat(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'search': {
      if (!args.query) throw new Error('query is required for search');
      const res = await sdk.im.v1.chat.search({
        params: {
          user_id_type: 'open_id',
          query: args.query as string,
          page_size: args.page_size as number | undefined,
          page_token: args.page_token as string | undefined,
        },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'get': {
      if (!args.chat_id) throw new Error('chat_id is required for get');
      const chatId = validatePathParam(args.chat_id, 'chat_id');
      const res = await sdk.im.v1.chat.get({
        path: { chat_id: chatId },
        params: { user_id_type: 'open_id' },
      }, opts);
      return { chat: (res as any)?.data };
    }

    default:
      throw new Error(`Unknown chat action: ${args.action}`);
  }
}

// ─── Chat Members ───────────────────────────────────────────────────────────

async function executeChatMembers(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  if (!args.chat_id) throw new Error('chat_id is required');
  const chatId = validatePathParam(args.chat_id, 'chat_id');

  const res = await sdk.im.v1.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      member_id_type: ((args.member_id_type as string) || 'open_id') as 'open_id' | 'union_id' | 'user_id',
      page_size: args.page_size as number | undefined,
      page_token: args.page_token as string | undefined,
    },
  }, opts);

  return {
    items: (res as any)?.data?.items,
    has_more: (res as any)?.data?.has_more,
    page_token: (res as any)?.data?.page_token,
    member_total: (res as any)?.data?.member_total,
  };
}

// ─── Drive File ─────────────────────────────────────────────────────────────

const SMALL_FILE_THRESHOLD = 15 * 1024 * 1024; // 15MB

async function executeDriveFile(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'list': {
      const res = await sdk.drive.file.list({
        params: {
          folder_token: args.folder_token as string | undefined,
          page_size: args.page_size as number | undefined,
          page_token: args.page_token as string | undefined,
        },
      }, opts);
      return { files: (res as any)?.data?.files, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.next_page_token };
    }

    case 'get_meta': {
      if (!args.request_docs || !Array.isArray(args.request_docs)) throw new Error('request_docs is required (array of {doc_token, doc_type})');
      const res = await sdk.drive.meta.batchQuery({
        data: { request_docs: args.request_docs as any },
      }, opts);
      return { metas: (res as any)?.data?.metas ?? [] };
    }

    case 'copy': {
      if (!args.file_token) throw new Error('file_token is required');
      if (!args.name) throw new Error('name is required');
      if (!args.type) throw new Error('type is required');
      const fileToken = validatePathParam(args.file_token, 'file_token');
      const res = await sdk.drive.file.copy({
        path: { file_token: fileToken },
        data: { name: args.name as string, type: args.type as any, folder_token: (args.folder_token as string) || undefined } as any,
      }, opts);
      return { file: (res as any)?.data?.file };
    }

    case 'move': {
      if (!args.file_token) throw new Error('file_token is required');
      if (!args.type) throw new Error('type is required');
      if (!args.folder_token) throw new Error('folder_token is required');
      const mvToken = validatePathParam(args.file_token, 'file_token');
      const res = await sdk.drive.file.move({
        path: { file_token: mvToken },
        data: { type: args.type as any, folder_token: args.folder_token as string },
      }, opts);
      return { success: true, task_id: (res as any)?.data?.task_id };
    }

    case 'delete': {
      if (!args.file_token) throw new Error('file_token is required');
      if (!args.type) throw new Error('type is required');
      const delToken = validatePathParam(args.file_token, 'file_token');
      const res = await sdk.drive.file.delete({
        path: { file_token: delToken },
        params: { type: args.type as any },
      }, opts);
      return { success: true, task_id: (res as any)?.data?.task_id };
    }

    case 'upload': {
      if (!args.file_path) throw new Error('file_path is required for upload');
      const filePath = args.file_path as string;
      const fileBuffer = readFileSync(filePath);
      const fileName = (args.file_name as string) || basename(filePath);
      const fileSize = fileBuffer.length;

      if (fileSize <= SMALL_FILE_THRESHOLD) {
        const res = await sdk.drive.file.uploadAll({
          data: {
            file_name: fileName,
            parent_type: 'explorer',
            parent_node: (args.folder_token as string) || '',
            size: fileSize,
            file: fileBuffer,
          },
        }, opts);
        return { file_token: (res as any)?.data?.file_token, file_name: fileName, size: fileSize };
      } else {
        // Chunked upload for large files
        const prepRes = await sdk.drive.file.uploadPrepare({
          data: { file_name: fileName, parent_type: 'explorer', parent_node: (args.folder_token as string) || '', size: fileSize },
        }, opts);
        const { upload_id, block_size, block_num } = (prepRes as any).data;
        for (let seq = 0; seq < block_num; seq++) {
          const start = seq * block_size;
          const end = Math.min(start + block_size, fileSize);
          await sdk.drive.file.uploadPart({
            data: { upload_id: String(upload_id), seq: Number(seq), size: Number(end - start), file: fileBuffer.subarray(start, end) },
          }, opts);
        }
        const finishRes = await sdk.drive.file.uploadFinish({
          data: { upload_id, block_num },
        }, opts);
        return { file_token: (finishRes as any)?.data?.file_token, file_name: fileName, size: fileSize, upload_method: 'chunked' };
      }
    }

    case 'download': {
      if (!args.file_token) throw new Error('file_token is required');
      const dlToken = validatePathParam(args.file_token, 'file_token');
      const res = await sdk.drive.file.download({
        path: { file_token: dlToken },
      }, opts);
      const stream = (res as any).getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) { chunks.push(chunk as Buffer); }
      const buffer = Buffer.concat(chunks);

      if (args.output_path) {
        const outPath = args.output_path as string;
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, buffer);
        return { saved_path: outPath, size: buffer.length };
      }
      return { file_content_base64: buffer.toString('base64'), size: buffer.length };
    }

    default:
      throw new Error(`Unknown drive_file action: ${args.action}`);
  }
}

// ─── Doc Media ──────────────────────────────────────────────────────────────

function extractDocumentId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/docx\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}

async function executeDocMedia(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'insert': {
      if (!args.doc_id) throw new Error('doc_id is required');
      if (!args.file_path) throw new Error('file_path is required');
      const documentId = extractDocumentId(args.doc_id as string);
      const filePath = args.file_path as string;
      const mediaType = (args.type as string) || 'image';
      const stat = statSync(filePath);
      if (stat.size > 20 * 1024 * 1024) throw new Error(`File ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`);
      const fileName = basename(filePath);

      // 1. Create empty block at document end
      const blockType = mediaType === 'image' ? 27 : 23;
      const blockData = mediaType === 'image' ? { image: {} } : { file: { token: '' } };
      const createRes = await sdk.docx.documentBlockChildren.create({
        path: { document_id: documentId, block_id: documentId },
        data: { children: [{ block_type: blockType, ...blockData } as any] },
        params: { document_revision_id: -1 as any },
      }, opts);

      let blockId: string | undefined;
      if (mediaType === 'file') {
        blockId = (createRes as any)?.data?.children?.[0]?.children?.[0];
      } else {
        blockId = (createRes as any)?.data?.children?.[0]?.block_id;
      }
      if (!blockId) throw new Error('Failed to create media block');

      // 2. Upload media
      const parentType = mediaType === 'image' ? 'docx_image' : 'docx_file';
      const uploadRes = await sdk.drive.v1.media.uploadAll({
        data: {
          file_name: fileName,
          parent_type: parentType as any,
          parent_node: blockId,
          size: stat.size,
          file: readFileSync(filePath),
          extra: JSON.stringify({ drive_route_token: documentId }),
        },
      }, opts);
      const fileToken = (uploadRes as any)?.file_token ?? (uploadRes as any)?.data?.file_token;
      if (!fileToken) throw new Error('Upload failed: no file_token returned');

      // 3. Patch block with file token
      const patchRequest: any = { block_id: blockId };
      if (mediaType === 'image') {
        const alignMap: Record<string, number> = { left: 1, center: 2, right: 3 };
        patchRequest.replace_image = {
          token: fileToken,
          align: alignMap[(args.align as string) ?? 'center'],
          ...(args.caption ? { caption: { content: args.caption } } : {}),
        };
      } else {
        patchRequest.replace_file = { token: fileToken };
      }
      await sdk.docx.documentBlock.batchUpdate({
        path: { document_id: documentId },
        data: { requests: [patchRequest] },
        params: { document_revision_id: -1 as any },
      }, opts);

      return { success: true, type: mediaType, document_id: documentId, block_id: blockId, file_token: fileToken, file_name: fileName };
    }

    case 'download': {
      if (!args.resource_token) throw new Error('resource_token is required');
      if (!args.resource_type) throw new Error('resource_type is required');
      if (!args.output_path) throw new Error('output_path is required');
      const resToken = validatePathParam(args.resource_token, 'resource_token');

      let res: any;
      if (args.resource_type === 'media') {
        res = await sdk.drive.v1.media.download({ path: { file_token: resToken } }, opts);
      } else {
        res = await (sdk.board as any).v1.whiteboard.downloadAsImage({ path: { whiteboard_id: resToken } }, opts);
      }

      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) { chunks.push(chunk as Buffer); }
      const buffer = Buffer.concat(chunks);

      const contentType = res?.headers?.['content-type'] || '';
      let finalPath = args.output_path as string;
      const currentExt = extname(finalPath);
      if (!currentExt && contentType) {
        const mimeType = contentType.split(';')[0].trim();
        const defaultExt = args.resource_type === 'whiteboard' ? '.png' : undefined;
        const suggestedExt = MIME_TO_EXT[mimeType] || defaultExt;
        if (suggestedExt) finalPath = finalPath + suggestedExt;
      }

      mkdirSync(dirname(finalPath), { recursive: true });
      writeFileSync(finalPath, buffer);

      return { resource_type: args.resource_type, resource_token: args.resource_token, size_bytes: buffer.length, content_type: contentType, saved_path: finalPath };
    }

    default:
      throw new Error(`Unknown doc_media action: ${args.action}`);
  }
}

// ─── Doc Comments ───────────────────────────────────────────────────────────

async function executeDocComments(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  let fileToken = args.file_token as string;
  let fileType = args.file_type as string;

  // Auto-resolve wiki token to actual doc token
  if (fileType === 'wiki') {
    const wikiRes = await sdk.request({
      method: 'GET',
      url: '/open-apis/wiki/v2/spaces/get_node',
      params: { token: fileToken, obj_type: 'wiki' },
    }, opts);
    const node = (wikiRes as any)?.data?.node;
    if (!node?.obj_token || !node?.obj_type) throw new Error(`Cannot resolve wiki token "${fileToken}" to actual document`);
    fileToken = node.obj_token;
    fileType = node.obj_type;
  }

  switch (args.action) {
    case 'list': {
      const res = await sdk.drive.v1.fileComment.list({
        path: { file_token: fileToken },
        params: {
          file_type: fileType as any,
          is_whole: args.is_whole as boolean | undefined,
          is_solved: args.is_solved as boolean | undefined,
          page_size: args.page_size as number | undefined,
          page_token: args.page_token as string | undefined,
          user_id_type: 'open_id',
        },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'create': {
      if (!args.elements || !Array.isArray(args.elements)) throw new Error('elements is required (array of {type, text/open_id/url})');
      const sdkElements = (args.elements as any[]).map((el: any) => {
        if (el.type === 'text') return { type: 'text_run' as const, text_run: { text: el.text } };
        if (el.type === 'mention') return { type: 'person' as const, person: { user_id: el.open_id } };
        if (el.type === 'link') return { type: 'docs_link' as const, docs_link: { url: el.url } };
        return { type: 'text_run' as const, text_run: { text: '' } };
      });
      const res = await sdk.drive.v1.fileComment.create({
        path: { file_token: fileToken },
        params: { file_type: fileType as any, user_id_type: 'open_id' },
        data: { reply_list: { replies: [{ content: { elements: sdkElements } }] } } as any,
      }, opts);
      return (res as any)?.data;
    }

    case 'patch': {
      if (!args.comment_id) throw new Error('comment_id is required');
      if (args.is_solved_value === undefined) throw new Error('is_solved_value is required');
      const commentId = validatePathParam(args.comment_id, 'comment_id');
      await sdk.drive.v1.fileComment.patch({
        path: { file_token: fileToken, comment_id: commentId },
        params: { file_type: fileType as any },
        data: { is_solved: args.is_solved_value as boolean },
      }, opts);
      return { success: true };
    }

    default:
      throw new Error(`Unknown doc_comments action: ${args.action}`);
  }
}

// ─── Calendar Attendee ──────────────────────────────────────────────────────

async function executeCalendarAttendee(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const calendarId = (args.calendar_id as string) || 'primary';
  if (!args.event_id) throw new Error('event_id is required');
  const eventId = validatePathParam(args.event_id, 'event_id');

  switch (args.action) {
    case 'list': {
      const res = await sdk.calendar.calendarEventAttendee.list({
        path: { calendar_id: calendarId, event_id: eventId },
        params: { user_id_type: 'open_id', page_size: args.page_size as any, page_token: args.page_token as any },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'add': {
      if (!args.attendees) throw new Error('attendees is required');
      const attendeeData = (args.attendees as any[]).map((a: any) => ({
        type: a.type,
        user_id: a.type === 'user' ? a.id : undefined,
        chat_id: a.type === 'chat' ? a.id : undefined,
        room_id: a.type === 'resource' ? a.id : undefined,
        third_party_email: a.type === 'third_party' ? a.id : undefined,
      }));
      const res = await sdk.calendar.calendarEventAttendee.create({
        path: { calendar_id: calendarId, event_id: eventId },
        params: { user_id_type: 'open_id' },
        data: { attendees: attendeeData, need_notification: true },
      }, opts);
      return { attendees: (res as any)?.data?.attendees };
    }

    case 'remove': {
      if (!args.attendees) throw new Error('attendees is required');
      const removeIds = (args.attendees as any[]).map((a: any) => ({
        type: a.type,
        user_id: a.type === 'user' ? a.id : undefined,
        chat_id: a.type === 'chat' ? a.id : undefined,
        room_id: a.type === 'resource' ? a.id : undefined,
        third_party_email: a.type === 'third_party' ? a.id : undefined,
      }));
      await sdk.calendar.calendarEventAttendee.batchDelete({
        path: { calendar_id: calendarId, event_id: eventId },
        data: { attendees: removeIds, need_notification: true } as any,
      }, opts);
      return { success: true };
    }

    default:
      throw new Error(`Unknown calendar_attendee action: ${args.action}`);
  }
}

// ─── Task Comment ───────────────────────────────────────────────────────────

async function executeTaskComment(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  if (!args.task_guid) throw new Error('task_guid is required');
  const taskGuid = validatePathParam(args.task_guid, 'task_guid');

  switch (args.action) {
    case 'list': {
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/task/v2/tasks/${taskGuid}/comments`,
        params: { page_size: args.page_size as any, page_token: args.page_token as any, user_id_type: 'open_id' },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'create': {
      if (!args.content) throw new Error('content is required');
      const res = await sdk.request({
        method: 'POST',
        url: `/open-apis/task/v2/tasks/${taskGuid}/comments`,
        data: { content: args.content },
        params: { user_id_type: 'open_id' },
      }, opts);
      return { comment: (res as any)?.data?.comment };
    }

    default:
      throw new Error(`Unknown task_comment action: ${args.action}`);
  }
}

// ─── Task Subtask ───────────────────────────────────────────────────────────

async function executeTaskSubtask(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  if (!args.task_guid) throw new Error('task_guid is required');
  const taskGuid = validatePathParam(args.task_guid, 'task_guid');

  switch (args.action) {
    case 'list': {
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/task/v2/tasks/${taskGuid}/subtasks`,
        params: { page_size: args.page_size as any, page_token: args.page_token as any, user_id_type: 'open_id' },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'create': {
      if (!args.summary) throw new Error('summary is required');
      const subtaskData: any = { summary: args.summary };
      if (args.description) subtaskData.description = args.description;
      const res = await sdk.request({
        method: 'POST',
        url: `/open-apis/task/v2/tasks/${taskGuid}/subtasks`,
        data: subtaskData,
        params: { user_id_type: 'open_id' },
      }, opts);
      return { subtask: (res as any)?.data?.subtask };
    }

    default:
      throw new Error(`Unknown task_subtask action: ${args.action}`);
  }
}

// ─── Bitable View ───────────────────────────────────────────────────────────

async function executeBitableView(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  const appToken = args.app_token as string;
  const tableId = args.table_id as string;

  switch (args.action) {
    case 'list': {
      const res = await sdk.bitable.appTableView.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: args.page_size as any, page_token: args.page_token as any },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'create': {
      if (!args.view_name) throw new Error('view_name is required');
      if (!args.view_type) throw new Error('view_type is required');
      const res = await sdk.bitable.appTableView.create({
        path: { app_token: appToken, table_id: tableId },
        data: { view_name: args.view_name as string, view_type: args.view_type as any },
      }, opts);
      return { view: (res as any)?.data?.view };
    }

    default:
      throw new Error(`Unknown bitable_view action: ${args.action}`);
  }
}

// ─── Wiki Space ─────────────────────────────────────────────────────────────

async function executeWikiSpace(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'list': {
      const res = await sdk.request({
        method: 'GET',
        url: '/open-apis/wiki/v2/spaces',
        params: { page_size: args.page_size as any, page_token: args.page_token as any },
      }, opts);
      return { items: (res as any)?.data?.items, has_more: (res as any)?.data?.has_more, page_token: (res as any)?.data?.page_token };
    }

    case 'get': {
      if (!args.space_id) throw new Error('space_id is required');
      const spId = validatePathParam(args.space_id, 'space_id');
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/wiki/v2/spaces/${spId}`,
      }, opts);
      return { space: (res as any)?.data?.space };
    }

    default:
      throw new Error(`Unknown wiki_space action: ${args.action}`);
  }
}

// ─── Sheet Export ────────────────────────────────────────────────────────────

async function executeSheetExport(sdk: lark.Client, args: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
  switch (args.action) {
    case 'create': {
      if (!args.spreadsheet_token) throw new Error('spreadsheet_token is required');
      const token = validatePathParam(args.spreadsheet_token, 'spreadsheet_token');
      const ext = (args.file_extension as string) || 'xlsx';
      const res = await sdk.request({
        method: 'POST',
        url: `/open-apis/sheets/v2/export`,
        data: { token, type: ext === 'csv' ? 'csv' : 'xlsx' },
      }, opts);
      return { ticket: (res as any)?.data?.ticket };
    }

    case 'query': {
      if (!args.ticket) throw new Error('ticket is required');
      const ticket = validatePathParam(args.ticket, 'ticket');
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/sheets/v2/export/query/${ticket}`,
      }, opts);
      return { status: (res as any)?.data?.status, file_token: (res as any)?.data?.file_token, file_size: (res as any)?.data?.file_size };
    }

    case 'download': {
      if (!args.file_token) throw new Error('file_token is required');
      const fileToken = validatePathParam(args.file_token, 'file_token');
      const res = await sdk.request({
        method: 'GET',
        url: `/open-apis/sheets/v2/export/download/${fileToken}`,
      }, opts);

      // Binary response
      const stream = (res as any).getReadableStream?.();
      if (stream) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) { chunks.push(chunk as Buffer); }
        const buffer = Buffer.concat(chunks);
        if (args.output_path) {
          const outPath = args.output_path as string;
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, buffer);
          return { saved_path: outPath, size: buffer.length };
        }
        return { file_content_base64: buffer.toString('base64'), size: buffer.length };
      }
      // If not a stream, return as-is
      return { data: (res as any)?.data };
    }

    default:
      throw new Error(`Unknown sheet_export action: ${args.action}`);
  }
}
