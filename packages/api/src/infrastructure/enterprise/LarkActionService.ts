/**
 * F162 Phase B: Lark/Feishu Action Service.
 *
 * Typed methods for enterprise operations via lark-cli (larksuite/cli, Go binary).
 * This is the governance boundary (ADR-029): audit log, error normalization.
 * All cat-facing Lark enterprise actions go through here — never raw CLI calls.
 *
 * Feishu capabilities covered (Phase B):
 *   - docs    (Markdown-backed Lark Docs)
 *   - base    (Bitable, multi-dimensional tables) + fields/records scaffolding
 *   - task    (task v2)
 *   - calendar (event v4; lark-cli v1.x does not expose VC/meeting URLs)
 *   - slides  (presentation; Feishu-exclusive vs WeCom)
 *
 * ADR-029 Core Principle: ActionService is required for all external tool actions.
 */

import type { FastifyBaseLogger } from 'fastify';
import { LarkApiError, type LarkCliExecutor } from './LarkCliExecutor.js';
import type {
  LarkBaseCreateResponse,
  LarkBaseHandle,
  LarkCalendarCreateResponse,
  LarkCalendarEventHandle,
  LarkContactSearchResponse,
  LarkDocHandle,
  LarkDocsCreateResponse,
  LarkGoldenChainResult,
  LarkSlideHandle,
  LarkSlidesCreateResponse,
  LarkTaskCreateResponse,
  LarkTaskHandle,
} from './lark-types.js';

export interface CreateDocOpts {
  /** Document title */
  title: string;
  /** Markdown content (Lark-flavored). Pass plain markdown; lark-cli handles conversion. */
  markdown?: string;
  /** Optional parent folder token */
  folderToken?: string;
}

export interface CreateBaseOpts {
  /** Base (Bitable) app name */
  name: string;
  /** Optional parent folder token */
  folderToken?: string;
  /** e.g. "Asia/Shanghai" */
  timeZone?: string;
}

export interface CreateTaskOpts {
  /** Task title */
  summary: string;
  description?: string;
  /** Assignee open_id (single assignee for Phase B; use assignMany for multi) */
  assigneeOpenId?: string;
  /** Due date: ISO 8601, YYYY-MM-DD, +2d relative, or ms timestamp */
  due?: string;
  /** Client token for idempotency */
  idempotencyKey?: string;
}

export interface CreateCalendarEventOpts {
  /** Event title */
  summary: string;
  description?: string;
  /** ISO 8601 start time */
  start: string;
  /** ISO 8601 end time */
  end: string;
  /** Attendee IDs (ou_xxx user, oc_xxx chat, omm_xxx room), comma-joined input allowed */
  attendeeOpenIds?: string[];
  /** Calendar ID (default: primary) */
  calendarId?: string;
  /** RFC5545 recurrence rule */
  rrule?: string;
}

export interface CreateSlidesOpts {
  title: string;
  folderToken?: string;
}

export interface GoldenChainOpts {
  docTitle: string;
  docMarkdown: string;
  baseName: string;
  tasks: Array<{
    summary: string;
    assigneeOpenId: string;
    due?: string;
    description?: string;
  }>;
  calendarSummary: string;
  calendarStart: string;
  calendarEnd: string;
  calendarAttendeeOpenIds: string[];
  /** If true, also create a Slides deck and include in summary */
  includeSlides?: boolean;
}

export class LarkActionService {
  private readonly executor: LarkCliExecutor;
  private readonly log: FastifyBaseLogger;

  constructor(executor: LarkCliExecutor, log: FastifyBaseLogger) {
    this.executor = executor;
    this.log = log;
  }

  async isAvailable(): Promise<boolean> {
    return this.executor.isAvailable();
  }

  async createDoc(opts: CreateDocOpts): Promise<LarkDocHandle> {
    this.audit('createDoc', { title: opts.title, hasMarkdown: Boolean(opts.markdown) });
    const res = await this.executor.exec<LarkDocsCreateResponse>('docs', '+create', {
      title: opts.title,
      ...(opts.markdown ? { markdown: opts.markdown } : {}),
      ...(opts.folderToken ? { 'folder-token': opts.folderToken } : {}),
    });
    const data = res.data;
    if (!data?.doc_id) {
      throw new Error(`Lark docs +create returned no doc_id: ${JSON.stringify(res)}`);
    }
    const url = data.doc_url ?? `https://feishu.cn/docx/${data.doc_id}`;
    return { documentId: data.doc_id, url, title: opts.title };
  }

  async createBase(opts: CreateBaseOpts): Promise<LarkBaseHandle> {
    this.audit('createBase', { name: opts.name });
    const res = await this.executor.exec<LarkBaseCreateResponse>('base', '+base-create', {
      name: opts.name,
      ...(opts.folderToken ? { 'folder-token': opts.folderToken } : {}),
      ...(opts.timeZone ? { 'time-zone': opts.timeZone } : {}),
    });
    const base = res.data?.base;
    if (!base?.base_token) {
      throw new Error(`Lark base +base-create returned no base_token: ${JSON.stringify(res)}`);
    }
    const url = base.url ?? `https://feishu.cn/base/${base.base_token}`;
    return { appToken: base.base_token, url, name: base.name ?? opts.name };
  }

  async createTask(opts: CreateTaskOpts): Promise<LarkTaskHandle> {
    this.audit('createTask', { summary: opts.summary });
    const res = await this.executor.exec<LarkTaskCreateResponse>('task', '+create', {
      summary: opts.summary,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.assigneeOpenId ? { assignee: opts.assigneeOpenId } : {}),
      ...(opts.due ? { due: opts.due } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    });
    const data = res.data;
    if (!data?.guid) {
      throw new Error(`Lark task +create returned no guid: ${JSON.stringify(res)}`);
    }
    return {
      guid: data.guid,
      summary: opts.summary,
      ...(data.url ? { url: data.url } : {}),
    };
  }

  async createCalendarEvent(opts: CreateCalendarEventOpts): Promise<LarkCalendarEventHandle> {
    this.audit('createCalendarEvent', { summary: opts.summary });
    const attendeeIds = opts.attendeeOpenIds?.length ? opts.attendeeOpenIds.join(',') : undefined;
    const res = await this.executor.exec<LarkCalendarCreateResponse>('calendar', '+create', {
      summary: opts.summary,
      start: opts.start,
      end: opts.end,
      ...(opts.description ? { description: opts.description } : {}),
      ...(attendeeIds ? { 'attendee-ids': attendeeIds } : {}),
      ...(opts.calendarId ? { 'calendar-id': opts.calendarId } : {}),
      ...(opts.rrule ? { rrule: opts.rrule } : {}),
    });
    const data = res.data;
    if (!data?.event_id) {
      throw new Error(`Lark calendar +create returned no event_id: ${JSON.stringify(res)}`);
    }
    return {
      eventId: data.event_id,
      calendarId: opts.calendarId ?? 'primary',
      summary: data.summary ?? opts.summary,
    };
  }

  async createSlides(opts: CreateSlidesOpts): Promise<LarkSlideHandle> {
    this.audit('createSlides', { title: opts.title });
    const res = await this.executor.exec<LarkSlidesCreateResponse>('slides', '+create', {
      title: opts.title,
      ...(opts.folderToken ? { 'folder-token': opts.folderToken } : {}),
    });
    const data = res.data;
    if (!data?.xml_presentation_id) {
      throw new Error(`Lark slides +create returned no xml_presentation_id: ${JSON.stringify(res)}`);
    }
    const url = data.url ?? `https://feishu.cn/slides/${data.xml_presentation_id}`;
    return { presentationId: data.xml_presentation_id, url, title: data.title ?? opts.title };
  }

  /**
   * Best-effort user lookup by name/query. Degrades to empty array ONLY when the failure
   * is a scope/permission error (not every tenant grants contact:contact.search). Other
   * failures (protocol error, CLI unavailable, vendor outage, unexpected API codes) bubble
   * up to the caller so real problems aren't masked as "no matches".
   */
  async searchUsers(query: string): Promise<Array<{ openId: string; name: string }>> {
    this.audit('searchUsers', { query });
    try {
      const res = await this.executor.exec<LarkContactSearchResponse>('contact', '+search-user', { query });
      return (res.data?.users ?? []).map((u) => ({ openId: u.open_id, name: u.name }));
    } catch (err) {
      if (err instanceof LarkApiError && isScopeOrPermissionError(err)) {
        this.log.warn({ err, query }, '[LarkAction] searchUsers degraded — contact scope not granted');
        return [];
      }
      throw err;
    }
  }

  /**
   * Golden Chain: One sentence → Doc + Base + Tasks + Calendar Event (+ optional Slides).
   * Feishu showcase, parity with WeCom F162 Phase A goldenChain but adapted to Lark primitives:
   *   - Doc (Markdown) replaces WeCom Doc
   *   - Base (Bitable) replaces WeCom smart table
   *   - Task v2 replaces WeCom Todo
   *   - Calendar Event (with VC link) replaces WeCom Meeting
   *   - Slides is Feishu-exclusive bonus
   */
  async goldenChain(opts: GoldenChainOpts): Promise<LarkGoldenChainResult & { slides?: LarkSlideHandle }> {
    this.audit('goldenChain', { docTitle: opts.docTitle, taskCount: opts.tasks.length });

    const doc = await this.createDoc({ title: opts.docTitle, markdown: opts.docMarkdown });

    const base = await this.createBase({ name: opts.baseName });

    const tasks: LarkTaskHandle[] = [];
    for (const t of opts.tasks) {
      tasks.push(
        await this.createTask({
          summary: t.summary,
          assigneeOpenId: t.assigneeOpenId,
          ...(t.due ? { due: t.due } : {}),
          ...(t.description ? { description: t.description } : {}),
        }),
      );
    }

    const calendarEvent = await this.createCalendarEvent({
      summary: opts.calendarSummary,
      start: opts.calendarStart,
      end: opts.calendarEnd,
      attendeeOpenIds: opts.calendarAttendeeOpenIds,
    });

    let slides: LarkSlideHandle | undefined;
    if (opts.includeSlides) {
      try {
        slides = await this.createSlides({ title: `${opts.docTitle} — Slides` });
      } catch (err) {
        this.log.warn({ err }, '[LarkAction] Slides creation failed — continuing without');
      }
    }

    const lines = [
      `📄 文档: ${doc.title} — ${doc.url}`,
      `📊 多维表: ${base.name} — ${base.url}`,
      `✅ 任务: ${tasks.length} 条已分发`,
      `🗓 日程: ${calendarEvent.summary}`,
    ];
    if (slides) lines.push(`🎞 幻灯片: ${slides.title} — ${slides.url}`);
    const summary = lines.join('\n');

    return { doc, base, tasks, calendarEvent, summary, ...(slides ? { slides } : {}) };
  }

  private audit(method: string, params: unknown): void {
    this.log.info({ service: 'LarkAction', method, params }, '[LarkAction] audit');
  }
}

function isScopeOrPermissionError(err: LarkApiError): boolean {
  const type = err.type.toLowerCase();
  if (type.includes('permission') || type.includes('scope') || type.includes('forbidden')) return true;
  // Common Lark permission/scope codes (99991664 scope_denied, 99991668 forbidden, 1254xxx contact-scope)
  return err.code === 99991664 || err.code === 99991668 || (err.code >= 1254000 && err.code <= 1254999);
}
