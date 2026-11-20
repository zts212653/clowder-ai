import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCodexExecLaunchArguments } from '../src/runtime/codex-exec-launch-arguments.ts';

const groups = {
  readOnly: '__CAT_CAFE_CODEX_GROUP_readOnly__',
  beforeSandbox: '__CAT_CAFE_CODEX_GROUP_beforeSandbox__',
  sandbox: '__CAT_CAFE_CODEX_GROUP_sandbox__',
  afterSandbox: '__CAT_CAFE_CODEX_GROUP_afterSandbox__',
  serviceTier: '__CAT_CAFE_CODEX_GROUP_serviceTier__',
  user: '__CAT_CAFE_CODEX_GROUP_user__',
  tail: '__CAT_CAFE_CODEX_GROUP_tail__',
};

describe('Codex exec launch arguments', () => {
  test('fresh exec owns the group order and stdin marker', () => {
    const { args } = buildCodexExecLaunchArguments({ readOnly: false, groups });

    assert.deepEqual(args, [
      'exec',
      '--json',
      groups.readOnly,
      groups.beforeSandbox,
      groups.sandbox,
      groups.afterSandbox,
      groups.serviceTier,
      groups.user,
      groups.tail,
      '--',
      '-',
    ]);
  });

  test('resume owns exec/resume/ID and the same group order', () => {
    const { args } = buildCodexExecLaunchArguments({ sessionId: 'thread-1', readOnly: false, groups });

    assert.deepEqual(args, [
      'exec',
      'resume',
      'thread-1',
      '--json',
      groups.readOnly,
      groups.beforeSandbox,
      groups.sandbox,
      groups.afterSandbox,
      groups.serviceTier,
      groups.user,
      groups.tail,
      '--',
      '-',
    ]);
  });

  test('omits absent groups but keeps the fixed precedence', () => {
    const { args } = buildCodexExecLaunchArguments({
      readOnly: true,
      groups: { sandbox: groups.sandbox, afterSandbox: groups.afterSandbox },
    });

    assert.deepEqual(args, ['exec', '--json', groups.sandbox, groups.afterSandbox, '--', '-']);
  });

  test('the package never receives group contents, only tokens', () => {
    const input = { readOnly: false, groups };
    const { args } = buildCodexExecLaunchArguments(input);

    assert.ok(args.includes(groups.readOnly));
    assert.ok(!args.some((arg) => arg.includes('developer_instructions=')));
    assert.ok(!args.some((arg) => arg.includes('mcp_servers')));
  });
});
