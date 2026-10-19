import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CANONICAL_TOOL_REGISTRY } from '../../mcp-server/src/canonical-server-tools.js';
import { applyReadonlyFilter, buildCollabTools, buildMemoryTools } from '../../mcp-server/src/server-toolsets.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { buildConversationDutyPromptLines } from '../src/domains/concierge/conversation-duty.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import { liveRealtimePrompt } from '../src/domains/concierge/live/live-conversation-context.js';
import {
  LIVE_FRONT_DESK_SCENES,
  liveFrontDeskDeepLines,
  liveFrontDeskFastGuidance,
} from '../src/domains/concierge/live-front-desk.js';

// The exact surface buildLiveMcpConfig mounts for a Live call: collab + memory, filtered by the desktop profile.
const liveEnv = {
  collectiveWork: false,
  participation: false,
  readonly: false,
  hasAgentKey: false,
  desktopMode: 'live-companion',
  agentKeyUnion: false,
};
const mounted = new Set(
  applyReadonlyFilter([...buildCollabTools(liveEnv), ...buildMemoryTools(liveEnv)], liveEnv).map((tool) =>
    tool.name.replace(/^cat_cafe_/, ''),
  ),
);
const canonicalShortNames = CANONICAL_TOOL_REGISTRY.map((tool) => tool.name.replace(/^cat_cafe_/, ''));
const namedTools = (text: string) => canonicalShortNames.filter((name) => new RegExp(`\\b${name}\\b`).test(text));

const dutyText = (householdToolsEnabled: boolean) =>
  buildConversationDutyPromptLines({
    liveCompanion: { householdToolsEnabled, compositionInstructions: 'HOST_SELECTION' } as never,
    threadKind: 'concierge',
    threadId: 'home',
  }).join('\n');

test('both prompt paths carry the front-desk duty and all current scenes', () => {
  assert.equal(LIVE_FRONT_DESK_SCENES.length, 7);
  const fast = liveRealtimePrompt({ catId: 'codex', householdToolsEnabled: true, compositionInstructions: 'HOST' });
  const deep = dutyText(true);
  for (const output of [fast, deep]) {
    assert.match(output, /前台/);
    assert.match(output, /不再问|不问“要不要”/, 'clear authorised goals are executed, not re-confirmed');
    assert.match(output, /不虚构已经开始|不说已经开始/);
  }
  assert.ok(fast.includes(liveFrontDeskFastGuidance(true)), 'the fast voice prompt must consume the short guidance');
  for (const line of liveFrontDeskDeepLines(true)) assert.ok(deep.includes(line), 'deep duty must consume every line');
  for (const scene of LIVE_FRONT_DESK_SCENES) {
    assert.ok(deep.includes(scene.title), `deep duty is missing scene ${scene.id}`);
    assert.ok(fast.includes(scene.cue), `fast voice is missing the cue for ${scene.id}`);
  }
});

test('every tool the guidance names is mounted for Live; capture tools are never offered', () => {
  const deep = dutyText(true);
  for (const name of namedTools(deep)) assert.ok(mounted.has(name), `${name} is named but not mounted for Live`);
  for (const scene of LIVE_FRONT_DESK_SCENES) {
    for (const tool of scene.tools) {
      assert.ok(mounted.has(tool), `${scene.id} relies on unmounted ${tool}`);
      assert.ok(scene.deep.includes(tool), `${scene.id} declares ${tool} without telling the cat how to use it`);
    }
  }
  assert.ok(!mounted.has('audio_capture_start'), 'fixture sanity: new capture is not part of this package');
  assert.doesNotMatch(deep, /audio_capture|开始录音了|已经开始录/);
  const meeting = LIVE_FRONT_DESK_SCENES.find((scene) => scene.id === 'meeting');
  assert.ok(meeting);
  assert.match(meeting.deep, /三件事/, 'joining, reading an existing capture and starting a recording stay distinct');
  assert.match(meeting.deep, /不能只丢一句/, 'a missing tool is explained, not bounced back as a manual click');
});

test('Live can show a web result through the scoped preview receipt without opening other operational tools', () => {
  assert.ok(mounted.has('preview_open'), 'a web result must render through Preview, not open its source in Workspace');
  const show = LIVE_FRONT_DESK_SCENES.find((scene) => scene.id === 'show');
  assert.ok(show);
  assert.ok(show.tools.includes('preview_open'));
  assert.match(show.deep, /preview_open/);
  assert.match(show.deep, /visiblePageAdmission/);
  assert.match(show.deep, /applied/);
  assert.match(show.deep, /queued/);
  assert.match(show.deep, /unconfirmed/);
  assert.match(show.deep, /只有返回 applied 才说“已经打开了”/);
  assert.match(show.deep, /queued 或 unconfirmed 就说已经发出打开请求、尚未确认展示/);
  assert.match(show.deep, /blocked 就说明未打开/);
  assert.match(show.deep, /伙伴已经启动并确认的 localhost 成品地址/);
  assert.match(show.deep, /回到原来的 thread 交给原来的负责猫/);
  assert.match(show.deep, /原工作来源和改的是哪一版/);
  assert.doesNotMatch(show.deep, /本次没有网页预览工具/);
  for (const name of ['shell_exec', 'audio_capture_start', 'create_task', 'plugin_enable', 'propose_thread'])
    assert.ok(!mounted.has(name), `${name} remains outside the Live surface`);
});

test('with household tools closed, no prompt path names a tool or promises the actions', () => {
  const deep = dutyText(false);
  const fast = liveRealtimePrompt({ catId: 'codex', householdToolsEnabled: false });
  assert.deepEqual(namedTools(deep), [], 'no MCP server is mounted, so no tool may be named');
  assert.deepEqual(namedTools(fast), []);
  for (const output of [deep, fast]) assert.match(output, /做不了/);
  for (const scene of LIVE_FRONT_DESK_SCENES) assert.ok(!deep.includes(scene.deep), `${scene.id} must not be offered`);
  assert.doesNotMatch(fast, /会议记录可以读/, 'the closed voice prompt must not promise reading meeting records');
});

for (const householdToolsEnabled of [true, false]) {
  test(`the realtime start request carries the guidance (household tools ${householdToolsEnabled ? 'open' : 'closed'})`, async () => {
    const call = await LiveCompanionCall.create({
      binding: {
        userId: 'owner',
        threadId: 'home',
        catId: createCatId('codex-astra'),
        callId: `desk-${householdToolsEnabled}`,
      },
      messageStore: new MessageStore(),
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      householdToolsEnabled,
      verifyNativeBinding: async () => true,
      publish() {},
    });
    let prompt = '';
    await call.ready('native', {
      submitText: async () => 'unused',
      request: async (method, params) => {
        if (method === 'thread/realtime/start') {
          prompt = String(params.prompt);
          await call.observe({
            method: 'thread/realtime/started',
            params: { threadId: 'native', realtimeSessionId: 'r' },
          });
          await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
        }
        if (method === 'thread/realtime/stop')
          await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
        return {};
      },
    });
    try {
      await call.start('offer');
      assert.ok(prompt.includes(liveFrontDeskFastGuidance(householdToolsEnabled)));
    } finally {
      await call.stop();
    }
  });
}

for (const tools of [true, false]) {
  test(`Live fast/deep prompts have no notice-to-catch-up protocol (tools=${tools})`, () => {
    for (const prompt of [dutyText(tools), liveRealtimePrompt({ catId: 'codex', householdToolsEnabled: tools })]) {
      assert.doesNotMatch(prompt, /收到来信提示|freshness notice|acknowledgeHeld|readIntent.*unread/i);
    }
  });
}
