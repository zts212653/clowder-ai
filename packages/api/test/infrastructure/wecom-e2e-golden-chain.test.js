/**
 * F162: End-to-end golden chain integration test.
 *
 * This test makes REAL wecom-cli calls — it creates actual documents, tables,
 * todos, and meetings in the configured WeChat Work enterprise.
 *
 * Prerequisites:
 * - wecom-cli must be installed and configured (`wecom-cli init` completed)
 * - Enterprise account must have permissions for doc/todo/meeting APIs
 *
 * Run manually: node --test packages/api/test/infrastructure/wecom-e2e-golden-chain.test.js
 * Skipped in CI (no credentials).
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { WeComCliExecutor } = await import('../../dist/infrastructure/enterprise/WeComCliExecutor.js');
const { WeComActionService } = await import('../../dist/infrastructure/enterprise/WeComActionService.js');

function noopLog() {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => noopLog() };
  return log;
}

/** Check if wecom-cli is configured (not just installed — has valid credentials) */
async function isWeComConfigured() {
  try {
    const { stdout } = await execFileAsync('wecom-cli', ['contact', 'get_userlist', '{}'], { timeout: 15_000 });
    const outer = JSON.parse(stdout.trim());
    const inner = JSON.parse(outer.content[0].text);
    return inner.errcode === 0;
  } catch {
    return false;
  }
}

describe('F162 E2E: Golden Chain (real CLI calls)', async () => {
  const configured = await isWeComConfigured();
  if (!configured) {
    it('SKIPPED — wecom-cli not configured (run `wecom-cli init` first)', () => {
      assert.ok(true, 'Skipped: no credentials');
    });
    return;
  }

  const log = noopLog();
  const executor = new WeComCliExecutor(log, 30_000);
  const service = new WeComActionService(executor, log);

  it('creates a document with content', async () => {
    const doc = await service.createDoc({
      docName: 'F162 E2E Test - 文档',
      content: '# 端到端测试\n\n由布偶猫自动创建。',
    });
    assert.ok(doc.docId, 'docId must exist');
    assert.ok(doc.url.startsWith('https://'), 'url must be https');
    assert.equal(doc.docName, 'F162 E2E Test - 文档');
    console.log(`  ✓ Doc created: ${doc.url}`);
  });

  it('creates a todo', async () => {
    const todo = await service.createTodo({
      content: 'F162 E2E Test - 待办',
      followerUserIds: ['YuJiaRong'],
    });
    assert.ok(todo.todoId, 'todoId must exist');
    console.log(`  ✓ Todo created: ${todo.todoId}`);
  });

  it('creates a meeting', async () => {
    // Use unique title to avoid 400302 "same meeting" on re-runs
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const meeting = await service.createMeeting({
      title: `F162 E2E Test - 会议 ${ts}`,
      startDatetime: '2026-04-20 14:00',
      durationSeconds: 1800,
      inviteeUserIds: ['YuJiaRong'],
    });
    assert.ok(meeting.meetingId, 'meetingId must exist');
    assert.ok(meeting.meetingLink.startsWith('https://'), 'meetingLink must be https');
    console.log(`  ✓ Meeting created: ${meeting.meetingLink}`);
  });

  it('creates a smart table with populated text fields (read-back verification)', async () => {
    const table = await service.createSmartTable({
      tableName: 'F162 E2E Test - 表格',
      fields: [
        { fieldTitle: '任务', fieldType: 'FIELD_TYPE_TEXT' },
        { fieldTitle: '状态', fieldType: 'FIELD_TYPE_SINGLE_SELECT' },
      ],
      records: [{ 任务: '端到端测试', 状态: '通过' }],
    });
    assert.ok(table.docId, 'docId must exist');
    assert.ok(table.url.startsWith('https://'), 'url must be https');

    // Read-back: verify text field values are actually populated (not silently dropped)
    const sheets = await executor.exec('doc', 'smartsheet_get_sheet', { docid: table.docId });
    const sheetId = sheets.sheet_list[0].sheet_id;
    const records = await executor.exec('doc', 'smartsheet_get_records', { docid: table.docId, sheet_id: sheetId });
    assert.ok(records.records.length >= 1, 'should have at least 1 record');
    const firstRecord = records.records[0].values;
    // Text field values come back as CellTextValue[] — extract text content
    const taskValue = Array.isArray(firstRecord['任务'])
      ? firstRecord['任务'].map((v) => v.text).join('')
      : firstRecord['任务'];
    assert.ok(
      taskValue && taskValue.includes('端到端测试'),
      `text field "任务" must contain "端到端测试", got: ${taskValue}`,
    );
    console.log(`  ✓ Smart table created + read-back verified: ${table.url}`);
  });

  it('executes golden chain (all 4 in sequence)', async () => {
    const result = await service.goldenChain({
      docName: 'F162 Golden Chain Demo',
      docContent: '# 黄金链路端到端验证\n\n由布偶猫 (Claude Opus) 自动创建。\n\n## 目标\n验证企微 CLI 全链路。',
      tableName: 'Golden Chain 任务表',
      tasks: [
        { content: '验证文档创建', assigneeUserId: 'YuJiaRong', remindTime: '2026-04-20 09:00:00' },
        { content: '验证表格创建', assigneeUserId: 'YuJiaRong' },
      ],
      meetingTitle: 'Golden Chain 验收会',
      meetingStart: '2026-04-20 15:00',
      meetingDurationSeconds: 3600,
      meetingInviteeUserIds: ['YuJiaRong'],
    });

    // Verify all 4 resources
    assert.ok(result.doc.docId, 'doc.docId');
    assert.ok(result.doc.url.startsWith('https://'), 'doc.url');
    assert.ok(result.smartTable.docId, 'smartTable.docId');
    assert.ok(result.smartTable.url.startsWith('https://'), 'smartTable.url');
    assert.equal(result.todos.length, 2, 'should have 2 todos');
    assert.ok(result.todos[0].todoId, 'todos[0].todoId');
    assert.ok(result.todos[1].todoId, 'todos[1].todoId');
    assert.ok(result.meeting.meetingId, 'meeting.meetingId');
    assert.ok(result.meeting.meetingLink.startsWith('https://'), 'meeting.meetingLink');

    // Verify summary
    assert.ok(result.summary.includes('F162 Golden Chain Demo'));
    assert.ok(result.summary.includes('Golden Chain 任务表'));
    assert.ok(result.summary.includes('2 条已分发'));
    assert.ok(result.summary.includes('Golden Chain 验收会'));

    console.log('\n=== Golden Chain Result ===');
    console.log(result.summary);
    console.log('========================\n');
  });
});
