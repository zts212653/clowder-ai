import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkToolPermission, getSkillPermissions } from '../dist/skill-security/skill-permissions.js';

describe('SkillPermissions', () => {
  test('external skill cannot access capabilities write path', () => {
    const perms = getSkillPermissions({ isExternal: true });
    assert.strictEqual(perms.canWriteCapabilities, false);
  });

  test('external skill cannot trigger other skills', () => {
    const perms = getSkillPermissions({ isExternal: true });
    assert.strictEqual(perms.canTriggerSkills, false);
  });

  test('external skill requires per-tool confirmation', () => {
    const perms = getSkillPermissions({ isExternal: true });
    assert.strictEqual(perms.toolAutoAllow, false);
  });

  test('first-run external skill defaults to dry-run mode', () => {
    const perms = getSkillPermissions({ isExternal: true, firstRun: true });
    assert.strictEqual(perms.mode, 'dry-run');
  });

  test('approved external skill uses read-only mode', () => {
    const perms = getSkillPermissions({ isExternal: true, status: 'approved' });
    assert.strictEqual(perms.mode, 'read-only');
  });

  test('internal skill has full permissions', () => {
    const perms = getSkillPermissions({ isExternal: false });
    assert.strictEqual(perms.canWriteCapabilities, true);
    assert.strictEqual(perms.canTriggerSkills, true);
    assert.strictEqual(perms.toolAutoAllow, true);
    assert.strictEqual(perms.mode, 'full');
  });
});

describe('checkToolPermission', () => {
  test('high-risk tool requires confirmation for external skill', () => {
    const result = checkToolPermission('write_file', { isExternal: true });
    assert.strictEqual(result.requiresConfirmation, true);
    assert.strictEqual(result.risk, 'high');
  });

  test('read-only tool auto-allowed for approved external skill', () => {
    const result = checkToolPermission('read_file', { isExternal: true, status: 'approved' });
    assert.strictEqual(result.requiresConfirmation, false);
    assert.strictEqual(result.risk, 'low');
  });

  test('any tool auto-allowed for internal skill', () => {
    const result = checkToolPermission('write_file', { isExternal: false });
    assert.strictEqual(result.requiresConfirmation, false);
  });

  test('execute_command is high-risk', () => {
    const result = checkToolPermission('execute_command', { isExternal: true });
    assert.strictEqual(result.risk, 'high');
  });

  test('network-related tools are high-risk', () => {
    const result = checkToolPermission('send_email', { isExternal: true });
    assert.strictEqual(result.risk, 'high');
  });

  test('namespaced MCP tool with dangerous verb is high-risk', () => {
    const r1 = checkToolPermission('mcp__codex_apps__github_create_issue', { isExternal: true });
    assert.strictEqual(r1.risk, 'high');
    const r2 = checkToolPermission('mcp__cat_cafe__cat_cafe_update_task', { isExternal: true });
    assert.strictEqual(r2.risk, 'high');
  });

  test('namespaced MCP read tool is low-risk', () => {
    const result = checkToolPermission('mcp__cat_cafe__cat_cafe_get_thread_context', { isExternal: true });
    assert.strictEqual(result.risk, 'low');
  });

  test('approved external skill still needs confirmation for high-risk namespaced tool', () => {
    const result = checkToolPermission('mcp__cat_cafe__cat_cafe_update_task', {
      isExternal: true,
      status: 'approved',
    });
    assert.strictEqual(result.requiresConfirmation, true);
  });

  test('camelCase namespaced tool with dangerous verb is high-risk', () => {
    const r1 = checkToolPermission('mcp__MCP_DOCKER__createRepository', { isExternal: true });
    assert.strictEqual(r1.risk, 'high');
    const r2 = checkToolPermission('mcp__MCP_DOCKER__updateRepositoryInfo', { isExternal: true });
    assert.strictEqual(r2.risk, 'high');
    const r3 = checkToolPermission('mcp__MCP_DOCKER__deleteRepositoryTag', { isExternal: true });
    assert.strictEqual(r3.risk, 'high');
  });

  test('camelCase namespaced read/check tool is low-risk', () => {
    const r1 = checkToolPermission('mcp__MCP_DOCKER__checkRepository', { isExternal: true });
    assert.strictEqual(r1.risk, 'low');
    const r2 = checkToolPermission('mcp__MCP_DOCKER__getRepositoryInfo', { isExternal: true });
    assert.strictEqual(r2.risk, 'low');
    const r3 = checkToolPermission('mcp__MCP_DOCKER__listRepositoryTags', { isExternal: true });
    assert.strictEqual(r3.risk, 'low');
  });
});
