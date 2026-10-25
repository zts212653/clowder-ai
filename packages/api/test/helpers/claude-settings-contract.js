import assert from 'node:assert/strict';

export const claudeUserSettings = {
  spinnerTipsEnabled: false,
  model: 'user-model',
  env: { USER_SETTING: 'kept' },
  permissions: { allow: ['Read'], deny: ['Write'] },
  disableAllHooks: true,
  hooks: {
    PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo user-before' }] }],
    PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo user-after' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
    PreCompact: [{ matcher: 'manual', hooks: [{ type: 'command', command: 'echo user-compact' }] }],
  },
};

/** User settings survive launch composition; host safety hooks stay enabled and run as well. */
export function assertClaudeSettingsPreserved(actual, expected = claudeUserSettings) {
  const { hooks: expectedHooks, disableAllHooks: _requested, ...expectedSettings } = expected;
  const { hooks, disableAllHooks, ...settings } = actual;
  assert.deepEqual(settings, expectedSettings, 'preserve every ordinary user setting');
  assert.equal(disableAllHooks, false, 'user settings cannot disable host safety hooks');
  for (const event of ['PreToolUse', 'PostToolUse']) {
    assert.deepEqual(hooks[event].slice(0, -1), expectedHooks[event], `preserve the user ${event} hooks`);
    const managed = hooks[event].at(-1);
    assert.equal(managed.matcher, '.*', `host ${event} must cover every tool`);
    assert.equal(managed.hooks.length, 1);
    assert.equal(managed.hooks[0].type, 'command');
    assert.match(managed.hooks[0].command, /secret-native-hook\.mjs/);
  }
  for (const [event, entries] of Object.entries(expectedHooks)) {
    if (event !== 'PreToolUse' && event !== 'PostToolUse')
      assert.deepEqual(hooks[event], entries, `preserve the user's ${event} hooks without a compaction plan`);
  }
}
