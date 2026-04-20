/**
 * F162 Phase B: LarkActionService unit tests.
 *
 * Tests the action service with a mock executor to verify:
 * - Correct CLI domain/command pairs are dispatched per action
 * - Flag composition (snake_case opts → kebab-case lark-cli flags)
 * - Response mapping (lark-cli flattened data.* → service camelCase handles)
 * - Golden chain orchestration order (doc → base → tasks → calendar → optional slides)
 * - Audit logging
 * - Graceful degradation for searchUsers (returns [] when contact scope missing)
 *
 * Mock response shape follows real lark-cli output (probed 2026-04-17):
 *   success: { ok: true, identity: 'user', data: { doc_id, doc_url, ... } }
 *   failure: { ok: false, identity, error: { type, code, message, hint } }
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function noopLog() {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => noopLog() };
  return log;
}

const { LarkActionService } = await import('../../dist/infrastructure/enterprise/LarkActionService.js');
const { LarkApiError, LarkCliProtocolError } = await import('../../dist/infrastructure/enterprise/LarkCliExecutor.js');

/** Mock executor that records calls and returns canned responses keyed by `domain.command` */
class MockExecutor {
  calls = [];
  responses = new Map();
  throwFor = new Map();

  async isAvailable() {
    return true;
  }

  setResponse(domain, command, response) {
    this.responses.set(`${domain}.${command}`, response);
  }

  setError(domain, command, error) {
    this.throwFor.set(`${domain}.${command}`, error);
  }

  async exec(domain, command, flags) {
    this.calls.push({ domain, command, flags });
    const key = `${domain}.${command}`;
    const err = this.throwFor.get(key);
    if (err) throw err;
    const response = this.responses.get(key);
    if (!response) throw new Error(`No mock response for ${key}`);
    return response;
  }
}

describe('LarkActionService', () => {
  let service;
  let mockExec;
  let auditCalls;
  let warnCalls;

  beforeEach(() => {
    mockExec = new MockExecutor();
    const log = noopLog();
    auditCalls = [];
    warnCalls = [];
    log.info = (obj, msg) => {
      if (msg === '[LarkAction] audit') auditCalls.push(obj);
    };
    log.warn = (obj, msg) => {
      warnCalls.push({ obj, msg });
    };
    service = new LarkActionService(mockExec, log);
  });

  describe('createDoc()', () => {
    it('creates a doc and returns a DocHandle', async () => {
      mockExec.setResponse('docs', '+create', {
        ok: true,
        identity: 'user',
        data: {
          doc_id: 'DOC123',
          doc_url: 'https://www.feishu.cn/docx/DOC123',
          message: '文档创建成功',
        },
      });

      const result = await service.createDoc({ title: 'Hello', markdown: '# hi' });
      assert.equal(result.documentId, 'DOC123');
      assert.equal(result.url, 'https://www.feishu.cn/docx/DOC123');
      assert.equal(result.title, 'Hello');

      assert.equal(mockExec.calls.length, 1);
      assert.equal(mockExec.calls[0].domain, 'docs');
      assert.equal(mockExec.calls[0].command, '+create');
      assert.equal(mockExec.calls[0].flags.title, 'Hello');
      assert.equal(mockExec.calls[0].flags.markdown, '# hi');
    });

    it('falls back to a synthesized URL when response omits doc_url', async () => {
      mockExec.setResponse('docs', '+create', {
        ok: true,
        identity: 'user',
        data: { doc_id: 'DOC_NO_URL' },
      });
      const result = await service.createDoc({ title: 'no url' });
      assert.equal(result.url, 'https://feishu.cn/docx/DOC_NO_URL');
    });

    it('throws when response omits doc_id', async () => {
      mockExec.setResponse('docs', '+create', { ok: true, identity: 'user', data: {} });
      await assert.rejects(() => service.createDoc({ title: 'x' }), /no doc_id/);
    });

    it('produces an audit entry', async () => {
      mockExec.setResponse('docs', '+create', {
        ok: true,
        identity: 'user',
        data: { doc_id: 'D', doc_url: 'u' },
      });
      await service.createDoc({ title: 'Audit' });
      assert.equal(auditCalls.length, 1);
      assert.equal(auditCalls[0].method, 'createDoc');
    });

    it('passes folder-token flag when folderToken is provided', async () => {
      mockExec.setResponse('docs', '+create', {
        ok: true,
        identity: 'user',
        data: { doc_id: 'D2', doc_url: 'u2' },
      });
      await service.createDoc({ title: 't', folderToken: 'FOLDER_X' });
      assert.equal(mockExec.calls[0].flags['folder-token'], 'FOLDER_X');
    });
  });

  describe('createBase()', () => {
    it('creates a base and returns a BaseHandle', async () => {
      mockExec.setResponse('base', '+base-create', {
        ok: true,
        identity: 'user',
        data: {
          base: {
            base_token: 'BASE_XYZ',
            name: 'Q2 Tracker',
            url: 'https://icnzjwzqfxa8.feishu.cn/base/BASE_XYZ',
            folder_token: '',
          },
          created: true,
        },
      });

      const result = await service.createBase({ name: 'Q2 Tracker', timeZone: 'Asia/Shanghai' });
      assert.equal(result.appToken, 'BASE_XYZ');
      assert.equal(result.name, 'Q2 Tracker');
      assert.equal(result.url, 'https://icnzjwzqfxa8.feishu.cn/base/BASE_XYZ');

      assert.equal(mockExec.calls[0].domain, 'base');
      assert.equal(mockExec.calls[0].command, '+base-create');
      assert.equal(mockExec.calls[0].flags.name, 'Q2 Tracker');
      assert.equal(mockExec.calls[0].flags['time-zone'], 'Asia/Shanghai');
    });

    it('throws when base_token missing', async () => {
      mockExec.setResponse('base', '+base-create', {
        ok: true,
        identity: 'user',
        data: { base: {} },
      });
      await assert.rejects(() => service.createBase({ name: 'x' }), /no base_token/);
    });
  });

  describe('createTask()', () => {
    it('creates a task and maps the response', async () => {
      mockExec.setResponse('task', '+create', {
        ok: true,
        identity: 'user',
        data: {
          guid: 'TASK_ABC',
          url: 'https://applink.feishu.cn/client/todo/detail?guid=TASK_ABC',
        },
      });

      const result = await service.createTask({
        summary: 'Write tests',
        description: 'cover golden chain',
        assigneeOpenId: 'ou_user_1',
        due: '+2d',
        idempotencyKey: 'key-1',
      });

      assert.equal(result.guid, 'TASK_ABC');
      assert.equal(result.summary, 'Write tests');
      assert.equal(result.url, 'https://applink.feishu.cn/client/todo/detail?guid=TASK_ABC');

      const flags = mockExec.calls[0].flags;
      assert.equal(flags.summary, 'Write tests');
      assert.equal(flags.description, 'cover golden chain');
      assert.equal(flags.assignee, 'ou_user_1');
      assert.equal(flags.due, '+2d');
      assert.equal(flags['idempotency-key'], 'key-1');
    });

    it('throws when guid missing', async () => {
      mockExec.setResponse('task', '+create', { ok: true, identity: 'user', data: {} });
      await assert.rejects(() => service.createTask({ summary: 's' }), /no guid/);
    });
  });

  describe('createCalendarEvent()', () => {
    it('creates an event with attendees', async () => {
      mockExec.setResponse('calendar', '+create', {
        ok: true,
        identity: 'user',
        data: {
          event_id: 'EVT1',
          summary: 'PRD Review',
          start: '2026-04-20T14:00:00+08:00',
          end: '2026-04-20T15:00:00+08:00',
        },
      });

      const result = await service.createCalendarEvent({
        summary: 'PRD Review',
        start: '2026-04-20T14:00:00+08:00',
        end: '2026-04-20T15:00:00+08:00',
        attendeeOpenIds: ['ou_a', 'ou_b'],
        calendarId: 'cal_primary',
      });

      assert.equal(result.eventId, 'EVT1');
      assert.equal(result.calendarId, 'cal_primary');
      assert.equal(result.summary, 'PRD Review');

      const flags = mockExec.calls[0].flags;
      assert.equal(flags.summary, 'PRD Review');
      assert.equal(flags.start, '2026-04-20T14:00:00+08:00');
      assert.equal(flags.end, '2026-04-20T15:00:00+08:00');
      assert.equal(flags['attendee-ids'], 'ou_a,ou_b');
      assert.equal(flags['calendar-id'], 'cal_primary');
    });

    it('defaults calendarId to "primary" when not provided', async () => {
      mockExec.setResponse('calendar', '+create', {
        ok: true,
        identity: 'user',
        data: { event_id: 'EVT2' },
      });
      const result = await service.createCalendarEvent({
        summary: 'x',
        start: 'a',
        end: 'b',
      });
      assert.equal(result.calendarId, 'primary');
    });

    it('omits attendee-ids flag when list empty', async () => {
      mockExec.setResponse('calendar', '+create', {
        ok: true,
        identity: 'user',
        data: { event_id: 'EVT3' },
      });
      await service.createCalendarEvent({ summary: 's', start: 'a', end: 'b', attendeeOpenIds: [] });
      assert.equal(mockExec.calls[0].flags['attendee-ids'], undefined);
    });
  });

  describe('createSlides()', () => {
    it('creates a presentation and returns a handle', async () => {
      mockExec.setResponse('slides', '+create', {
        ok: true,
        identity: 'user',
        data: {
          xml_presentation_id: 'PRES1',
          title: 'Q2 Deck',
          url: 'https://icnzjwzqfxa8.feishu.cn/slides/PRES1',
          revision_id: 1,
        },
      });
      const result = await service.createSlides({ title: 'Q2 Deck' });
      assert.equal(result.presentationId, 'PRES1');
      assert.equal(result.url, 'https://icnzjwzqfxa8.feishu.cn/slides/PRES1');
      assert.equal(result.title, 'Q2 Deck');
    });

    it('throws when xml_presentation_id missing', async () => {
      mockExec.setResponse('slides', '+create', { ok: true, identity: 'user', data: {} });
      await assert.rejects(() => service.createSlides({ title: 'x' }), /no xml_presentation_id/);
    });
  });

  describe('searchUsers()', () => {
    it('returns normalized users on success', async () => {
      mockExec.setResponse('contact', '+search-user', {
        ok: true,
        identity: 'user',
        data: {
          users: [
            { open_id: 'ou_1', name: '张三', email: 'z@x.com' },
            { open_id: 'ou_2', name: '李四' },
          ],
        },
      });
      const users = await service.searchUsers('张');
      assert.equal(users.length, 2);
      assert.equal(users[0].openId, 'ou_1');
      assert.equal(users[0].name, '张三');
      assert.equal(users[1].openId, 'ou_2');
    });

    it('returns [] gracefully on LarkApiError with permission/scope type', async () => {
      const permErr = new LarkApiError(
        { type: 'permission_denied', code: 99991664, message: 'scope not granted' },
        'contact',
        '+search-user',
      );
      mockExec.setError('contact', '+search-user', permErr);
      const users = await service.searchUsers('anyone');
      assert.deepEqual(users, []);
      assert.equal(warnCalls.length, 1);
    });

    it('returns [] gracefully on LarkApiError with scope_denied code', async () => {
      const scopeErr = new LarkApiError(
        { type: 'forbidden', code: 1254001, message: 'contact scope missing' },
        'contact',
        '+search-user',
      );
      mockExec.setError('contact', '+search-user', scopeErr);
      const users = await service.searchUsers('anyone');
      assert.deepEqual(users, []);
    });

    it('does NOT degrade on non-permission LarkApiError (bubbles up)', async () => {
      const otherErr = new LarkApiError(
        { type: 'validation_error', code: 1470400, message: 'bad query param' },
        'contact',
        '+search-user',
      );
      mockExec.setError('contact', '+search-user', otherErr);
      await assert.rejects(
        () => service.searchUsers('x'),
        (err) => {
          assert.ok(err instanceof LarkApiError);
          assert.equal(err.code, 1470400);
          return true;
        },
      );
    });

    it('does NOT degrade on LarkCliProtocolError (bubbles up)', async () => {
      const protoErr = new LarkCliProtocolError('non-JSON', new SyntaxError('bad'), '<html>');
      mockExec.setError('contact', '+search-user', protoErr);
      await assert.rejects(
        () => service.searchUsers('x'),
        (err) => {
          assert.ok(err instanceof LarkCliProtocolError);
          return true;
        },
      );
    });

    it('does NOT degrade on generic Error (bubbles up)', async () => {
      mockExec.setError('contact', '+search-user', new Error('network blew up'));
      await assert.rejects(() => service.searchUsers('x'), /network blew up/);
    });
  });

  describe('goldenChain()', () => {
    it('runs doc → base → tasks → calendar in order and builds a summary', async () => {
      mockExec.setResponse('docs', '+create', {
        ok: true,
        identity: 'user',
        data: { doc_id: 'GC_DOC', doc_url: 'https://www.feishu.cn/docx/GC_DOC' },
      });
      mockExec.setResponse('base', '+base-create', {
        ok: true,
        identity: 'user',
        data: { base: { base_token: 'GC_BASE', name: 'Q2 Tasks', url: 'https://feishu.cn/base/GC_BASE' } },
      });
      mockExec.setResponse('task', '+create', {
        ok: true,
        identity: 'user',
        data: { guid: 'GC_TASK_1', url: 'https://applink.feishu.cn/todo/GC_TASK_1' },
      });
      mockExec.setResponse('calendar', '+create', {
        ok: true,
        identity: 'user',
        data: { event_id: 'GC_EVT', summary: 'Q2 Review' },
      });

      const result = await service.goldenChain({
        docTitle: 'Q2 PRD',
        docMarkdown: '# Q2 Plan',
        baseName: 'Q2 Tasks',
        tasks: [{ summary: 'Write tests', assigneeOpenId: 'ou_1' }],
        calendarSummary: 'Q2 Review',
        calendarStart: '2026-04-20T14:00:00+08:00',
        calendarEnd: '2026-04-20T15:00:00+08:00',
        calendarAttendeeOpenIds: ['ou_1'],
      });

      const order = mockExec.calls.map((c) => `${c.domain}.${c.command}`);
      assert.deepEqual(order, ['docs.+create', 'base.+base-create', 'task.+create', 'calendar.+create']);

      assert.equal(result.doc.documentId, 'GC_DOC');
      assert.equal(result.base.appToken, 'GC_BASE');
      assert.equal(result.tasks.length, 1);
      assert.equal(result.tasks[0].guid, 'GC_TASK_1');
      assert.equal(result.calendarEvent.eventId, 'GC_EVT');

      assert.ok(result.summary.includes('Q2 PRD'));
      assert.ok(result.summary.includes('Q2 Tasks'));
      assert.ok(result.summary.includes('Q2 Review'));
      assert.ok(result.summary.includes('1 条已分发'));
    });

    it('includes slides step when includeSlides=true', async () => {
      mockExec.setResponse('docs', '+create', {
        ok: true,
        identity: 'user',
        data: { doc_id: 'D', doc_url: 'u' },
      });
      mockExec.setResponse('base', '+base-create', {
        ok: true,
        identity: 'user',
        data: { base: { base_token: 'B', name: 'B', url: 'u' } },
      });
      mockExec.setResponse('task', '+create', {
        ok: true,
        identity: 'user',
        data: { guid: 'T' },
      });
      mockExec.setResponse('calendar', '+create', {
        ok: true,
        identity: 'user',
        data: { event_id: 'E' },
      });
      mockExec.setResponse('slides', '+create', {
        ok: true,
        identity: 'user',
        data: { xml_presentation_id: 'P', title: 'Deck', url: 'https://feishu.cn/slides/P' },
      });

      const result = await service.goldenChain({
        docTitle: 'Title',
        docMarkdown: '# md',
        baseName: 'B',
        tasks: [{ summary: 't', assigneeOpenId: 'ou' }],
        calendarSummary: 's',
        calendarStart: 'a',
        calendarEnd: 'b',
        calendarAttendeeOpenIds: ['ou'],
        includeSlides: true,
      });

      assert.ok(result.slides, 'slides should be present');
      assert.equal(result.slides.presentationId, 'P');
      assert.ok(result.summary.includes('幻灯片'));
      assert.ok(result.summary.includes('Deck'));
    });

    it('continues successfully when slides step fails', async () => {
      mockExec.setResponse('docs', '+create', {
        ok: true,
        identity: 'user',
        data: { doc_id: 'D', doc_url: 'u' },
      });
      mockExec.setResponse('base', '+base-create', {
        ok: true,
        identity: 'user',
        data: { base: { base_token: 'B', name: 'B', url: 'u' } },
      });
      mockExec.setResponse('task', '+create', {
        ok: true,
        identity: 'user',
        data: { guid: 'T' },
      });
      mockExec.setResponse('calendar', '+create', {
        ok: true,
        identity: 'user',
        data: { event_id: 'E' },
      });
      mockExec.setError('slides', '+create', new Error('slides forbidden'));

      const result = await service.goldenChain({
        docTitle: 'Title',
        docMarkdown: '# md',
        baseName: 'B',
        tasks: [{ summary: 't', assigneeOpenId: 'ou' }],
        calendarSummary: 's',
        calendarStart: 'a',
        calendarEnd: 'b',
        calendarAttendeeOpenIds: ['ou'],
        includeSlides: true,
      });

      assert.equal(result.slides, undefined, 'slides should be absent on failure');
      assert.ok(!result.summary.includes('幻灯片'));
      assert.ok(warnCalls.some((w) => w.msg?.includes('Slides creation failed')));
    });
  });
});
