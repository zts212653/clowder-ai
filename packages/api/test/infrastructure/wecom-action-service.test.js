/**
 * F162: WeComActionService unit tests.
 *
 * Tests the action service with a mock executor to verify:
 * - Correct CLI commands are dispatched for each action
 * - Response mapping (CLI snake_case → service camelCase)
 * - Golden chain orchestration order
 * - Audit logging
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function noopLog() {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => noopLog() };
  return log;
}

const { WeComActionService } = await import('../../dist/infrastructure/enterprise/WeComActionService.js');

/** Mock executor that records calls and returns canned responses */
class MockExecutor {
  calls = [];
  responses = new Map();

  async isAvailable() {
    return true;
  }

  setResponse(category, method, response) {
    this.responses.set(`${category}.${method}`, response);
  }

  async exec(category, method, params) {
    this.calls.push({ category, method, params });
    const key = `${category}.${method}`;
    const response = this.responses.get(key);
    if (!response) throw new Error(`No mock response for ${key}`);
    return response;
  }
}

describe('WeComActionService', () => {
  let service;
  let mockExec;
  let auditCalls;

  beforeEach(() => {
    mockExec = new MockExecutor();
    const log = noopLog();
    // Capture audit calls
    auditCalls = [];
    log.info = (obj, msg) => {
      if (msg === '[WeComAction] audit') auditCalls.push(obj);
    };
    service = new WeComActionService(mockExec, log);
  });

  describe('createDoc()', () => {
    it('creates a document and returns a DocHandle', async () => {
      mockExec.setResponse('doc', 'create_doc', {
        errcode: 0,
        errmsg: 'ok',
        docid: 'DOC123',
        url: 'https://doc.weixin.qq.com/DOC123',
      });

      const result = await service.createDoc({ docName: 'Test PRD' });
      assert.equal(result.docId, 'DOC123');
      assert.equal(result.url, 'https://doc.weixin.qq.com/DOC123');
      assert.equal(result.docName, 'Test PRD');

      // Verify CLI was called correctly
      assert.equal(mockExec.calls.length, 1);
      assert.equal(mockExec.calls[0].category, 'doc');
      assert.equal(mockExec.calls[0].method, 'create_doc');
      assert.equal(mockExec.calls[0].params.doc_type, 3);
      assert.equal(mockExec.calls[0].params.doc_name, 'Test PRD');
    });

    it('writes content when provided', async () => {
      mockExec.setResponse('doc', 'create_doc', {
        errcode: 0,
        errmsg: 'ok',
        docid: 'DOC456',
        url: 'https://doc.weixin.qq.com/DOC456',
      });
      mockExec.setResponse('doc', 'edit_doc_content', { errcode: 0, errmsg: 'ok' });

      await service.createDoc({ docName: 'With Content', content: '# Hello' });

      assert.equal(mockExec.calls.length, 2);
      assert.equal(mockExec.calls[1].method, 'edit_doc_content');
      assert.equal(mockExec.calls[1].params.docid, 'DOC456');
      assert.equal(mockExec.calls[1].params.content, '# Hello');
      assert.equal(mockExec.calls[1].params.content_type, 1);
    });

    it('produces an audit log entry', async () => {
      mockExec.setResponse('doc', 'create_doc', { errcode: 0, errmsg: 'ok', docid: 'D1', url: 'u' });
      await service.createDoc({ docName: 'Audit Test' });
      assert.equal(auditCalls.length, 1);
      assert.equal(auditCalls[0].method, 'createDoc');
    });
  });

  describe('createTodo()', () => {
    it('creates a todo and maps the response', async () => {
      mockExec.setResponse('todo', 'create_todo', {
        errcode: 0,
        errmsg: 'ok',
        todo_id: 'TODO789',
      });

      const result = await service.createTodo({
        content: 'Review the PRD',
        followerUserIds: ['user1', 'user2'],
        remindTime: '2026-04-20 09:00:00',
      });

      assert.equal(result.todoId, 'TODO789');
      assert.equal(result.content, 'Review the PRD');

      const params = mockExec.calls[0].params;
      assert.deepEqual(params.follower_list, {
        followers: [{ follower_id: 'user1' }, { follower_id: 'user2' }],
      });
      assert.equal(params.remind_time, '2026-04-20 09:00:00');
    });
  });

  describe('createMeeting()', () => {
    it('creates a meeting and maps the response', async () => {
      mockExec.setResponse('meeting', 'create_meeting', {
        errcode: 0,
        errmsg: 'ok',
        meetingid: 'MTG001',
        meeting_code: '123-456-789',
        meeting_link: 'https://meeting.tencent.com/dm/xxx',
      });

      const result = await service.createMeeting({
        title: 'PRD Review',
        startDatetime: '2026-04-20 14:00',
        durationSeconds: 3600,
        inviteeUserIds: ['user1', 'user2'],
      });

      assert.equal(result.meetingId, 'MTG001');
      assert.equal(result.meetingCode, '123-456-789');
      assert.equal(result.meetingLink, 'https://meeting.tencent.com/dm/xxx');
      assert.equal(result.title, 'PRD Review');
    });
  });

  describe('getUserList()', () => {
    it('returns normalized user list', async () => {
      mockExec.setResponse('contact', 'get_userlist', {
        errcode: 0,
        errmsg: 'ok',
        userlist: [
          { userid: 'u1', name: '张三', alias: 'zhangsan' },
          { userid: 'u2', name: '李四' },
        ],
      });

      const users = await service.getUserList();
      assert.equal(users.length, 2);
      assert.equal(users[0].userId, 'u1');
      assert.equal(users[0].name, '张三');
      assert.equal(users[0].alias, 'zhangsan');
      assert.equal(users[1].alias, undefined);
    });
  });

  describe('createSmartTable() — CellTextValue conversion', () => {
    it('converts plain string values to CellTextValue[] for text fields', async () => {
      mockExec.setResponse('doc', 'create_doc', {
        errcode: 0,
        errmsg: 'ok',
        docid: 'TBL_CV',
        url: 'https://doc.weixin.qq.com/TBL_CV',
      });
      mockExec.setResponse('doc', 'smartsheet_get_sheet', {
        errcode: 0,
        errmsg: 'ok',
        sheet_list: [{ sheet_id: 'SH1', title: '默认子表' }],
      });
      mockExec.setResponse('doc', 'smartsheet_get_fields', {
        errcode: 0,
        errmsg: 'ok',
        fields: [{ field_id: 'DF1', field_title: '文本', field_type: 'text' }],
      });
      mockExec.setResponse('doc', 'smartsheet_update_fields', { errcode: 0, errmsg: 'ok' });
      mockExec.setResponse('doc', 'smartsheet_add_fields', { errcode: 0, errmsg: 'ok', fields: [] });
      mockExec.setResponse('doc', 'smartsheet_add_records', { errcode: 0, errmsg: 'ok', records: [] });

      await service.createSmartTable({
        tableName: 'CellText Test',
        fields: [
          { fieldTitle: '任务', fieldType: 'FIELD_TYPE_TEXT' },
          { fieldTitle: '状态', fieldType: 'FIELD_TYPE_SINGLE_SELECT' },
          { fieldTitle: '截止时间', fieldType: 'FIELD_TYPE_DATE_TIME' },
        ],
        records: [{ 任务: '写测试', 状态: '待处理', 截止时间: '2026-04-20' }],
      });

      // Find the smartsheet_add_records call
      const addRecordsCall = mockExec.calls.find((c) => c.method === 'smartsheet_add_records');
      assert.ok(addRecordsCall, 'smartsheet_add_records should be called');

      const values = addRecordsCall.params.records[0].values;
      // FIELD_TYPE_TEXT → wrapped in CellTextValue[]
      assert.deepEqual(values['任务'], [{ text: '写测试', type: 'text' }]);
      // FIELD_TYPE_SINGLE_SELECT → wrapped in Option[]
      assert.deepEqual(values['状态'], [{ text: '待处理' }]);
      // FIELD_TYPE_DATE_TIME → passed through as-is
      assert.equal(values['截止时间'], '2026-04-20');
    });
  });

  describe('createSmartTable() — empty sheet_list guard', () => {
    it('throws when API returns no default sheet', async () => {
      mockExec.setResponse('doc', 'create_doc', {
        errcode: 0,
        errmsg: 'ok',
        docid: 'TBL_GUARD',
        url: 'https://doc.weixin.qq.com/TBL_GUARD',
      });
      mockExec.setResponse('doc', 'smartsheet_get_sheet', {
        errcode: 0,
        errmsg: 'ok',
        sheet_list: [],
      });

      await assert.rejects(
        () =>
          service.createSmartTable({
            tableName: 'Guard Test',
            fields: [{ fieldTitle: '任务', fieldType: 'FIELD_TYPE_TEXT' }],
            records: [],
          }),
        (err) => {
          assert.ok(err.message.includes('no default sheet'));
          return true;
        },
      );
    });
  });

  describe('goldenChain()', () => {
    it('executes all 4 steps in sequence and returns combined result', async () => {
      // Step 1: Create doc
      mockExec.setResponse('doc', 'create_doc', {
        errcode: 0,
        errmsg: 'ok',
        docid: 'DOC_GC',
        url: 'https://doc.weixin.qq.com/DOC_GC',
      });
      mockExec.setResponse('doc', 'edit_doc_content', { errcode: 0, errmsg: 'ok' });

      // Step 2: Create smart table — second create_doc call returns different response
      // We need to handle this since MockExecutor uses category.method as key
      // Override exec to handle sequence
      let createDocCallCount = 0;
      const origExec = mockExec.exec.bind(mockExec);
      mockExec.exec = async (cat, method, params) => {
        if (cat === 'doc' && method === 'create_doc') {
          createDocCallCount++;
          if (createDocCallCount === 2) {
            return { errcode: 0, errmsg: 'ok', docid: 'TBL_GC', url: 'https://doc.weixin.qq.com/TBL_GC' };
          }
        }
        mockExec.calls.push({ category: cat, method, params });
        return origExec(cat, method, params);
      };

      // Step 2 sub-commands (smart table default field flow)
      mockExec.setResponse('doc', 'smartsheet_get_sheet', {
        errcode: 0,
        errmsg: 'ok',
        sheet_list: [{ sheet_id: 'SHEET1', title: '默认子表' }],
      });
      mockExec.setResponse('doc', 'smartsheet_get_fields', {
        errcode: 0,
        errmsg: 'ok',
        fields: [{ field_id: 'DEFAULT_F', field_title: '文本', field_type: 'text' }],
      });
      mockExec.setResponse('doc', 'smartsheet_update_fields', { errcode: 0, errmsg: 'ok' });
      mockExec.setResponse('doc', 'smartsheet_add_fields', { errcode: 0, errmsg: 'ok', fields: [] });
      mockExec.setResponse('doc', 'smartsheet_add_records', { errcode: 0, errmsg: 'ok', records: [] });

      // Step 3: Todo
      mockExec.setResponse('todo', 'create_todo', { errcode: 0, errmsg: 'ok', todo_id: 'TD1' });

      // Step 4: Meeting
      mockExec.setResponse('meeting', 'create_meeting', {
        errcode: 0,
        errmsg: 'ok',
        meetingid: 'MTG_GC',
        meeting_code: '111-222-333',
        meeting_link: 'https://meeting.tencent.com/dm/gc',
      });

      const result = await service.goldenChain({
        docName: 'Q2 PRD',
        docContent: '# Q2 Plan',
        tableName: 'Q2 Tasks',
        tasks: [{ content: 'Write tests', assigneeUserId: 'u1', remindTime: '2026-04-20 09:00:00' }],
        meetingTitle: 'Q2 Review',
        meetingStart: '2026-04-20 14:00',
        meetingDurationSeconds: 3600,
        meetingInviteeUserIds: ['u1'],
      });

      // Verify all 4 results
      assert.equal(result.doc.docId, 'DOC_GC');
      assert.equal(result.smartTable.docId, 'TBL_GC');
      assert.equal(result.todos.length, 1);
      assert.equal(result.todos[0].todoId, 'TD1');
      assert.equal(result.meeting.meetingId, 'MTG_GC');

      // Verify summary
      assert.ok(result.summary.includes('Q2 PRD'));
      assert.ok(result.summary.includes('Q2 Tasks'));
      assert.ok(result.summary.includes('Q2 Review'));
      assert.ok(result.summary.includes('1 条已分发'));
    });
  });
});
