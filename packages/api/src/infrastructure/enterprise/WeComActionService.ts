/**
 * F162: WeChat Work Action Service.
 *
 * Typed methods for enterprise operations via wecom-cli.
 * This is the governance boundary (ADR-029): audit log, error normalization.
 * All cat-facing enterprise actions go through here — never raw CLI calls.
 *
 * ADR-029 Core Principle: ActionService is required for all external tool actions.
 */

import type { FastifyBaseLogger } from 'fastify';
import { WeComCliExecutor } from './WeComCliExecutor.js';
import type {
  DocHandle,
  GoldenChainResult,
  MeetingHandle,
  TodoHandle,
  WeComDocResponse,
  WeComMeetingResponse,
  WeComSmartTableFieldsResponse,
  WeComSmartTableGetFieldsResponse,
  WeComSmartTableRecordsResponse,
  WeComSmartTableSheetResponse,
  WeComTodoResponse,
  WeComUserListResponse,
} from './wecom-types.js';

export interface CreateDocOpts {
  docName: string;
  /** Markdown content to write after creation */
  content?: string;
}

export interface CreateSmartTableOpts {
  tableName: string;
  fields: Array<{ fieldTitle: string; fieldType: string }>;
  records: Array<Record<string, unknown>>;
}

export interface CreateTodoOpts {
  content: string;
  followerUserIds: string[];
  /** ISO datetime string for reminder, e.g. "2026-04-20 09:00:00" */
  remindTime?: string;
}

export interface CreateMeetingOpts {
  title: string;
  /** ISO datetime string, e.g. "2026-04-20 14:00" */
  startDatetime: string;
  /** Duration in seconds */
  durationSeconds: number;
  inviteeUserIds: string[];
}

export interface GoldenChainOpts {
  docName: string;
  docContent: string;
  tableName: string;
  tasks: Array<{ content: string; assigneeUserId: string; remindTime?: string }>;
  meetingTitle: string;
  meetingStart: string;
  meetingDurationSeconds: number;
  meetingInviteeUserIds: string[];
}

export class WeComActionService {
  private readonly executor: WeComCliExecutor;
  private readonly log: FastifyBaseLogger;

  constructor(executor: WeComCliExecutor, log: FastifyBaseLogger) {
    this.executor = executor;
    this.log = log;
  }

  async isAvailable(): Promise<boolean> {
    return this.executor.isAvailable();
  }

  async createDoc(opts: CreateDocOpts): Promise<DocHandle> {
    this.audit('createDoc', opts);
    const res = await this.executor.exec<WeComDocResponse>('doc', 'create_doc', {
      doc_type: 3, // Markdown document
      doc_name: opts.docName,
    });
    if (opts.content) {
      await this.executor.exec('doc', 'edit_doc_content', {
        docid: res.docid,
        content: opts.content,
        content_type: 1, // Markdown
      });
    }
    return { docId: res.docid, url: res.url, docName: opts.docName };
  }

  async createSmartTable(opts: CreateSmartTableOpts): Promise<DocHandle> {
    this.audit('createSmartTable', opts);
    // Step 1: Create smart table document (comes with default sheet + one default field "文本")
    const res = await this.executor.exec<WeComDocResponse>('doc', 'create_doc', {
      doc_type: 10,
      doc_name: opts.tableName,
    });

    if (opts.fields.length > 0) {
      // Step 2: Get default sheet ID
      const sheets = await this.executor.exec<WeComSmartTableSheetResponse>('doc', 'smartsheet_get_sheet', {
        docid: res.docid,
      });
      const sheetId = sheets.sheet_list[0]?.sheet_id;
      if (!sheetId) {
        throw new Error(
          `Smart table "${opts.tableName}" created (docid=${res.docid}) but API returned no default sheet`,
        );
      }

      // Step 3: Get default field ID, rename it to first user field (avoids orphan "文本" column)
      const existingFields = await this.executor.exec<WeComSmartTableGetFieldsResponse>(
        'doc',
        'smartsheet_get_fields',
        { docid: res.docid, sheet_id: sheetId },
      );
      const defaultFieldId = existingFields.fields[0]?.field_id;
      const [firstField, ...remainingFields] = opts.fields;
      if (defaultFieldId && firstField) {
        await this.executor.exec('doc', 'smartsheet_update_fields', {
          docid: res.docid,
          sheet_id: sheetId,
          fields: [{ field_id: defaultFieldId, field_title: firstField.fieldTitle, field_type: firstField.fieldType }],
        });
      }

      // Step 4: Add remaining fields
      if (remainingFields.length > 0) {
        await this.executor.exec<WeComSmartTableFieldsResponse>('doc', 'smartsheet_add_fields', {
          docid: res.docid,
          sheet_id: sheetId,
          fields: remainingFields.map((f) => ({ field_title: f.fieldTitle, field_type: f.fieldType })),
        });
      }

      // Step 5: Add records (convert plain values to API-specific formats per field type)
      if (opts.records.length > 0) {
        const fieldTypeMap = new Map(opts.fields.map((f) => [f.fieldTitle, f.fieldType]));
        await this.executor.exec<WeComSmartTableRecordsResponse>('doc', 'smartsheet_add_records', {
          docid: res.docid,
          sheet_id: sheetId,
          records: opts.records.map((r) => ({
            values: Object.fromEntries(
              Object.entries(r).map(([key, val]) => [key, toCellValue(fieldTypeMap.get(key), val)]),
            ),
          })),
        });
      }
    }

    return { docId: res.docid, url: res.url, docName: opts.tableName };
  }

  async createTodo(opts: CreateTodoOpts): Promise<TodoHandle> {
    this.audit('createTodo', opts);
    const res = await this.executor.exec<WeComTodoResponse>('todo', 'create_todo', {
      content: opts.content,
      follower_list: { followers: opts.followerUserIds.map((id) => ({ follower_id: id })) },
      ...(opts.remindTime ? { remind_time: opts.remindTime } : {}),
    });
    return { todoId: res.todo_id, content: opts.content };
  }

  async createMeeting(opts: CreateMeetingOpts): Promise<MeetingHandle> {
    this.audit('createMeeting', opts);
    const res = await this.executor.exec<WeComMeetingResponse>('meeting', 'create_meeting', {
      title: opts.title,
      meeting_start_datetime: opts.startDatetime,
      meeting_duration: opts.durationSeconds,
      invitees: { userid: opts.inviteeUserIds },
    });
    return {
      meetingId: res.meetingid,
      meetingCode: res.meeting_code,
      meetingLink: res.meeting_link,
      title: opts.title,
    };
  }

  async getUserList(): Promise<Array<{ userId: string; name: string; alias?: string }>> {
    this.audit('getUserList', {});
    const res = await this.executor.exec<WeComUserListResponse>('contact', 'get_userlist', {});
    return res.userlist.map((u) => ({ userId: u.userid, name: u.name, alias: u.alias }));
  }

  /**
   * Golden Chain: One sentence → Doc + Smart Table + Todos + Meeting.
   * This is the F162 showcase — all 4 operations in sequence.
   */
  async goldenChain(opts: GoldenChainOpts): Promise<GoldenChainResult> {
    this.audit('goldenChain', { docName: opts.docName, taskCount: opts.tasks.length });

    // Step 1: Create document with content
    const doc = await this.createDoc({ docName: opts.docName, content: opts.docContent });

    // Step 2: Create smart table with task breakdown
    const smartTable = await this.createSmartTable({
      tableName: opts.tableName,
      fields: [
        { fieldTitle: '任务', fieldType: 'FIELD_TYPE_TEXT' },
        { fieldTitle: '负责人', fieldType: 'FIELD_TYPE_TEXT' },
        { fieldTitle: '截止时间', fieldType: 'FIELD_TYPE_DATE_TIME' },
        { fieldTitle: '状态', fieldType: 'FIELD_TYPE_SINGLE_SELECT' },
      ],
      records: opts.tasks.map((t) => ({
        任务: t.content,
        负责人: t.assigneeUserId,
        截止时间: t.remindTime ?? '',
        状态: '待处理',
      })),
    });

    // Step 3: Create todos for each person (sequential — each needs its own API call)
    const todos: TodoHandle[] = [];
    for (const task of opts.tasks) {
      todos.push(
        await this.createTodo({
          content: task.content,
          followerUserIds: [task.assigneeUserId],
          remindTime: task.remindTime,
        }),
      );
    }

    // Step 4: Create meeting
    const meeting = await this.createMeeting({
      title: opts.meetingTitle,
      startDatetime: opts.meetingStart,
      durationSeconds: opts.meetingDurationSeconds,
      inviteeUserIds: opts.meetingInviteeUserIds,
    });

    const summary = [
      `📄 文档: ${doc.docName} — ${doc.url}`,
      `📊 表格: ${smartTable.docName} — ${smartTable.url}`,
      `✅ 待办: ${todos.length} 条已分发`,
      `🎥 会议: ${meeting.title} — ${meeting.meetingLink}`,
    ].join('\n');

    return { doc, smartTable, todos, meeting, summary };
  }

  private audit(method: string, params: unknown): void {
    this.log.info({ service: 'WeComAction', method, params }, '[WeComAction] audit');
  }
}

/**
 * Convert a plain record value to the format expected by wecom-cli smartsheet API.
 * - FIELD_TYPE_TEXT → CellTextValue[]: [{text, type: "text"}]
 * - FIELD_TYPE_SINGLE_SELECT → Option[]: [{text}]
 * - Other types (DATE_TIME, NUMBER, etc.) → pass through as-is
 */
function toCellValue(fieldType: string | undefined, value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;
  switch (fieldType) {
    case 'FIELD_TYPE_TEXT':
      return [{ text: value, type: 'text' }];
    case 'FIELD_TYPE_SINGLE_SELECT':
      return [{ text: value }];
    default:
      return value;
  }
}
