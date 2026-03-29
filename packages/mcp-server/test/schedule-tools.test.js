/**
 * F139 Phase 3A: Schedule MCP Tools (AC-G2)
 * Tests for cat_cafe_list_schedule_templates, cat_cafe_register_scheduled_task, cat_cafe_remove_scheduled_task
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Schedule MCP Tools — module exports', () => {
  test('scheduleTools array exports 4 tools', async () => {
    const { scheduleTools } = await import('../dist/tools/schedule-tools.js');
    assert.equal(scheduleTools.length, 4);
  });

  test('cat_cafe_preview_scheduled_task exists with templateId + trigger (P1-1: draft step)', async () => {
    const { scheduleTools, previewScheduledTaskInputSchema } = await import('../dist/tools/schedule-tools.js');
    const tool = scheduleTools.find((t) => t.name === 'cat_cafe_preview_scheduled_task');
    assert.ok(tool, 'preview tool should exist');
    assert.ok(previewScheduledTaskInputSchema.templateId, 'templateId schema required');
    assert.ok(previewScheduledTaskInputSchema.trigger, 'trigger schema required');
    assert.ok(tool.description.toLowerCase().includes('preview'), 'description should mention preview');
  });

  test('cat_cafe_list_schedule_templates has correct shape', async () => {
    const { scheduleTools } = await import('../dist/tools/schedule-tools.js');
    const tool = scheduleTools.find((t) => t.name === 'cat_cafe_list_schedule_templates');
    assert.ok(tool, 'tool should exist');
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.handler, 'function');
    // No required inputs — should be empty schema
    assert.deepEqual(tool.inputSchema, {});
  });

  test('cat_cafe_register_scheduled_task has templateId + trigger required', async () => {
    const { scheduleTools, registerScheduledTaskInputSchema } = await import('../dist/tools/schedule-tools.js');
    const tool = scheduleTools.find((t) => t.name === 'cat_cafe_register_scheduled_task');
    assert.ok(tool, 'tool should exist');
    assert.ok(registerScheduledTaskInputSchema.templateId, 'templateId schema required');
    assert.ok(registerScheduledTaskInputSchema.trigger, 'trigger schema required');
  });

  test('cat_cafe_remove_scheduled_task has taskId required', async () => {
    const { scheduleTools, removeScheduledTaskInputSchema } = await import('../dist/tools/schedule-tools.js');
    const tool = scheduleTools.find((t) => t.name === 'cat_cafe_remove_scheduled_task');
    assert.ok(tool, 'tool should exist');
    assert.ok(removeScheduledTaskInputSchema.taskId, 'taskId schema required');
  });

  test('handlers return error when callback config missing', async () => {
    // Ensure env vars are NOT set so handlers fail gracefully
    const origUrl = process.env['CAT_CAFE_API_URL'];
    const origInv = process.env['CAT_CAFE_INVOCATION_ID'];
    const origTok = process.env['CAT_CAFE_CALLBACK_TOKEN'];
    delete process.env['CAT_CAFE_API_URL'];
    delete process.env['CAT_CAFE_INVOCATION_ID'];
    delete process.env['CAT_CAFE_CALLBACK_TOKEN'];

    try {
      const { handleListScheduleTemplates, handleRegisterScheduledTask, handleRemoveScheduledTask } = await import(
        '../dist/tools/schedule-tools.js'
      );

      const listResult = await handleListScheduleTemplates({});
      assert.equal(listResult.isError, true);

      const regResult = await handleRegisterScheduledTask({
        templateId: 'reminder',
        trigger: JSON.stringify({ type: 'cron', expression: '0 9 * * *' }),
      });
      assert.equal(regResult.isError, true);

      const rmResult = await handleRemoveScheduledTask({ taskId: 'dyn-001' });
      assert.equal(rmResult.isError, true);
    } finally {
      // Restore
      if (origUrl) process.env['CAT_CAFE_API_URL'] = origUrl;
      if (origInv) process.env['CAT_CAFE_INVOCATION_ID'] = origInv;
      if (origTok) process.env['CAT_CAFE_CALLBACK_TOKEN'] = origTok;
    }
  });
});

describe('Schedule tools in registration', () => {
  test('scheduleTools are in collabTools surface', async () => {
    const { createCollabServer } = await import('../dist/collab.js');
    const server = createCollabServer();
    const registered = Object.keys(server._registeredTools);

    assert.ok(
      registered.includes('cat_cafe_list_schedule_templates'),
      'list_schedule_templates should be registered in collab surface',
    );
    assert.ok(
      registered.includes('cat_cafe_register_scheduled_task'),
      'register_scheduled_task should be registered in collab surface',
    );
    assert.ok(
      registered.includes('cat_cafe_remove_scheduled_task'),
      'remove_scheduled_task should be registered in collab surface',
    );
  });
});
