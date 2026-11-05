import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairLegacyNativeToolIdentities } from '../dist/config/cat-catalog-store.js';

function nativeBreed(overrides) {
  return {
    name: '旧名字',
    displayName: '旧名字',
    nickname: '旧昵称',
    avatar: '/avatars/default.png',
    roleDescription: '旧职责',
    personality: '旧性格',
    teamStrengths: '旧能力',
    defaultVariantId: 'v1',
    variants: [{ id: 'v1' }],
    ...overrides,
  };
}

test('repairs exact legacy native-tool defaults and leaves custom names alone', () => {
  const catalog = {
    breeds: [
      nativeBreed({
        id: 'kimi',
        catId: 'kimi',
        name: 'Kimi 伙伴',
        displayName: 'Kimi 伙伴',
        nickname: 'Kimi',
        avatar: '/avatars/default.png',
        roleDescription: '一起分析问题、完成任务',
        personality: '认真务实，先确认目标，完成后说明结果',
        teamStrengths: '任务拆解、实现与验证',
        variants: [{ id: 'v1', catId: 'kimi', clientId: 'kimi' }],
      }),
      nativeBreed({
        id: 'dsh',
        catId: 'dsh',
        name: 'DSH 伙伴',
        displayName: 'DSH 伙伴',
        nickname: '深深',
        avatar: '/avatars/family/kimi.png',
        roleDescription: '共创与推理伙伴，负责分析问题、编码实现和交叉验证',
        personality: '细心务实，先理清问题，再用可验证的结果交付',
        teamStrengths: '问题分析、编码、交叉验证',
        variants: [{ id: 'v1', catId: 'dsh', clientId: 'acp', acp: { command: 'dsh', startupArgs: [] } }],
      }),
      nativeBreed({
        id: 'pi',
        catId: 'pi',
        name: 'Pi 伙伴',
        displayName: 'Pi 伙伴',
        nickname: '派派',
        avatar: '/avatars/family/opencode.png',
        roleDescription: '轻量编码伙伴，负责拆解小任务、实现和验证',
        personality: '敏捷克制，先给最小可用实现，再补验证细节',
        teamStrengths: '任务拆解、编码实现、测试验证',
        variants: [
          { id: 'v1', catId: 'pi', clientId: 'acp', acp: { command: 'node', startupArgs: ['pi-acp-bridge.js'] } },
        ],
      }),
      nativeBreed({
        id: 'custom',
        catId: 'custom',
        name: '我的猫',
        displayName: '我的猫',
        nickname: '自定义',
        avatar: '/custom.png',
        variants: [{ id: 'v1', catId: 'custom', clientId: 'kimi' }],
      }),
    ],
  };

  assert.equal(repairLegacyNativeToolIdentities(catalog), true);
  const byId = new Map(catalog.breeds.map((breed) => [breed.id, breed]));
  assert.equal(byId.get('kimi')?.name, '梵花猫');
  assert.equal(byId.get('kimi')?.nickname, '墨墨');
  assert.equal(byId.get('kimi')?.avatar, '/avatars/family/kimi.png');
  assert.equal(byId.get('dsh')?.name, '小鲸鱼');
  assert.equal(byId.get('dsh')?.nickname, '鲸鲸');
  assert.equal(byId.get('dsh')?.avatar, '/avatars/family/dsh.png');
  assert.equal(byId.get('pi')?.name, '金渐层');
  assert.equal(byId.get('pi')?.nickname, '金哥');
  assert.equal(byId.get('custom')?.name, '我的猫');
  assert.equal(byId.get('custom')?.avatar, '/custom.png');

  assert.equal(repairLegacyNativeToolIdentities(catalog), false, 'migration must be idempotent');
});
