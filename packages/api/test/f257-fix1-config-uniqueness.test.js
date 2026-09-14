/**
 * F257 修复清单 #1 — 昵称唯一性与模糊 @ fail-closed（config 层）
 *
 * 证据坐标：dev-628ea4d1（@砚砚 确定性投错 codex；宪宪×3/砚砚×5/烁烁×2 活体冲突）。
 * 契约：
 *   1. mentionPatterns 跨猫冲突 → toAllCatConfigs 抛错（fail-closed，启动拒绝）
 *   2. nickname 跨猫冲突 → 不阻断加载（现网存量冲突需可启动），结构化告警可收集
 *   3. nickname 从家族（breed）层移到 per-cat：非 default variant 不再继承 breed.nickname
 *   4. 写入层（runtime-cat-catalog）nickname 增量唯一：新写入与他猫冲突 → 拒；
 *      清空/收敛操作永远放行（防止存量多冲突陷入无法单步收敛的死锁）
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const { toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
const { collectCrossCatConflicts } = await import('../dist/config/cat-uniqueness.js');
const { createRuntimeCat, updateRuntimeCat } = await import('../dist/config/runtime-cat-catalog.js');

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** 最小可加载 breed；overrides 覆盖顶层字段 */
function makeBreed(id, catId, overrides = {}) {
  return {
    id,
    catId,
    name: `${id}-name`,
    displayName: `${id}-display`,
    avatar: `/avatars/${id}.png`,
    color: { primary: '#000000', secondary: '#ffffff' },
    mentionPatterns: [`@${catId}`],
    roleDescription: 'test cat',
    defaultVariantId: `${id}-default`,
    variants: [
      {
        id: `${id}-default`,
        clientId: 'anthropic',
        defaultModel: 'claude-sonnet-4-5-20250929',
        mcpSupport: true,
        cli: { command: 'claude', outputFormat: 'stream-json' },
        personality: 'test',
      },
    ],
    ...overrides,
  };
}

function makeConfig(breeds) {
  return { version: 1, breeds };
}

describe('F257 #1 修复：mentionPatterns 跨猫冲突 fail-closed', () => {
  it('两只猫共享同一 mention pattern → toAllCatConfigs 抛错（启动拒绝）', () => {
    const config = makeConfig([
      makeBreed('breed-a', 'cata', { mentionPatterns: ['@cata', '@砚砚'] }),
      makeBreed('breed-b', 'catb', { mentionPatterns: ['@catb', '@砚砚'] }),
    ]);
    assert.throws(
      () => toAllCatConfigs(config),
      (err) => /@砚砚/.test(err.message) && /cata/.test(err.message) && /catb/.test(err.message),
      'conflict error should name the pattern and both holder cats',
    );
  });

  it('pattern 冲突判定大小写不敏感（@Shared vs @shared）', () => {
    const config = makeConfig([
      makeBreed('breed-a', 'cata', { mentionPatterns: ['@Shared'] }),
      makeBreed('breed-b', 'catb', { mentionPatterns: ['@shared'] }),
    ]);
    assert.throws(() => toAllCatConfigs(config), /shared/i);
  });

  it('同一只猫自身 pattern 重复（breed 与 variant 同值）不算跨猫冲突', () => {
    const config = makeConfig([
      makeBreed('breed-a', 'cata', { mentionPatterns: ['@cata', '@cata'] }),
      makeBreed('breed-b', 'catb'),
    ]);
    const all = toAllCatConfigs(config);
    assert.ok(all.cata);
    assert.ok(all.catb);
  });
});

describe('F257 #1 修复：nickname 跨猫冲突 = 告警不阻断（存量兼容）', () => {
  it('两只猫同 nickname → 加载成功 + collectCrossCatConflicts 报告冲突', () => {
    const config = makeConfig([
      makeBreed('breed-a', 'cata', { nickname: '砚砚' }),
      makeBreed('breed-b', 'catb', { nickname: '砚砚' }),
    ]);
    const all = toAllCatConfigs(config); // 不抛：现网存量冲突（砚砚×5）必须仍可启动
    const { nicknameConflicts, patternConflicts } = collectCrossCatConflicts(all);
    assert.equal(patternConflicts.length, 0);
    assert.equal(nicknameConflicts.length, 1);
    assert.equal(nicknameConflicts[0].nickname, '砚砚');
    assert.deepEqual([...nicknameConflicts[0].holders].sort(), ['cata', 'catb']);
  });

  it('nickname 唯一时 conflicts 为空', () => {
    const config = makeConfig([
      makeBreed('breed-a', 'cata', { nickname: '宪宪' }),
      makeBreed('breed-b', 'catb', { nickname: '砚砚' }),
    ]);
    const { nicknameConflicts } = collectCrossCatConflicts(toAllCatConfigs(config));
    assert.equal(nicknameConflicts.length, 0);
  });
});

describe('F257 #1 修复：nickname 从家族层移到 per-cat（继承语义收窄）', () => {
  function multiVariantConfig() {
    return makeConfig([
      makeBreed('ragdoll', 'opus', {
        nickname: '宪宪',
        variants: [
          {
            id: 'ragdoll-default',
            clientId: 'anthropic',
            defaultModel: 'claude-opus-4-6',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: 'test',
          },
          {
            id: 'ragdoll-fable',
            catId: 'fable-5',
            clientId: 'anthropic',
            defaultModel: 'claude-fable-5',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: 'test',
          },
          {
            id: 'ragdoll-named',
            catId: 'named-cat',
            nickname: '专属名',
            clientId: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: 'test',
          },
        ],
        defaultVariantId: 'ragdoll-default',
      }),
    ]);
  }

  it('default variant 仍继承 breed.nickname（单猫家族行为不变）', () => {
    const all = toAllCatConfigs(multiVariantConfig());
    assert.equal(all.opus.nickname, '宪宪');
  });

  it('非 default variant 不再继承 breed.nickname（dev-628ea4d1 根因：家族层昵称复制到每只猫）', () => {
    const all = toAllCatConfigs(multiVariantConfig());
    assert.equal(all['fable-5'].nickname, undefined, 'non-default variant must NOT inherit family nickname');
  });

  it('variant 显式 nickname 仍然生效（per-cat 实例声明）', () => {
    const all = toAllCatConfigs(multiVariantConfig());
    assert.equal(all['named-cat'].nickname, '专属名');
  });

  it('variant nickname=null 表示显式无昵称（#1090 语义保持）', () => {
    const config = makeConfig([
      makeBreed('breed-a', 'cata', {
        nickname: '宪宪',
        variants: [
          {
            id: 'breed-a-default',
            nickname: null,
            clientId: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: 'test',
          },
        ],
        defaultVariantId: 'breed-a-default',
      }),
    ]);
    const all = toAllCatConfigs(config);
    assert.equal(all.cata.nickname, undefined);
  });
});

describe('F257 #1 修复（sol F1）：roleTemplate 派生 cat 写入冲突 fail-closed', () => {
  it('同模板连续创建两只猫：第二只因 pattern 冲突被明确拒绝，不生成静默碰撞', () => {
    // FirstRunQuest 形状：从 roleTemplate 菜单数据派生 input（name → @name pattern）
    const projectRoot = mkdtempSync(join(tmpdir(), 'f257-roletpl-'));
    tempDirs.push(projectRoot);
    const empty = makeConfig([makeBreed('seed-breed', 'seed-cat')]);
    writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(empty, null, 2));
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(empty, null, 2));

    const fromTemplate = (catId) => ({
      catId,
      name: '布偶猫',
      displayName: '布偶猫',
      avatar: '/avatars/opus.png',
      color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
      mentionPatterns: ['@布偶猫'],
      roleDescription: '主架构师',
      clientId: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });

    createRuntimeCat(projectRoot, fromTemplate('ragdoll-one'));
    assert.throws(
      () => createRuntimeCat(projectRoot, fromTemplate('ragdoll-two')),
      /@布偶猫/,
      'second cat from the same template must be explicitly rejected (fail-closed), never silently colliding',
    );
  });
});

describe('F257 #1 修复：写入层 nickname 增量唯一（fail-closed 新增冲突，放行收敛）', () => {
  function makeProject(breeds) {
    const projectRoot = mkdtempSync(join(tmpdir(), 'f257-fix1-'));
    tempDirs.push(projectRoot);
    const config = makeConfig(breeds);
    writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(config, null, 2));
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(config, null, 2));
    return projectRoot;
  }

  function makeRuntimeInput(catId, nickname) {
    return {
      catId,
      name: `${catId}-name`,
      displayName: `${catId}-display`,
      ...(nickname ? { nickname } : {}),
      avatar: `/avatars/${catId}.png`,
      color: { primary: '#000000', secondary: '#ffffff' },
      mentionPatterns: [`@${catId}`],
      roleDescription: 'runtime test cat',
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    };
  }

  it('createRuntimeCat：nickname 已被他猫持有 → 拒绝写入', () => {
    const projectRoot = makeProject([makeBreed('breed-a', 'cata', { nickname: '宪宪' })]);
    assert.throws(
      () => createRuntimeCat(projectRoot, makeRuntimeInput('cat-new1', '宪宪')),
      /宪宪.*cata|cata.*宪宪/s,
      'creating a cat with an already-held nickname must fail-closed',
    );
  });

  it('createRuntimeCat：nickname 未被持有 → 正常创建', () => {
    const projectRoot = makeProject([makeBreed('breed-a', 'cata', { nickname: '宪宪' })]);
    const updated = createRuntimeCat(projectRoot, makeRuntimeInput('cat-new2', '新名'));
    assert.equal(toAllCatConfigs(updated)['cat-new2'].nickname, '新名');
  });

  it('updateRuntimeCat：改 nickname 撞他猫 → 拒绝写入', () => {
    const projectRoot = makeProject([
      makeBreed('breed-a', 'cata', { nickname: '宪宪' }),
      makeBreed('breed-b', 'catb', { nickname: '砚砚' }),
    ]);
    assert.throws(() => updateRuntimeCat(projectRoot, 'catb', { nickname: '宪宪' }), /宪宪.*cata|cata.*宪宪/s);
  });

  it('updateRuntimeCat：清空 nickname 永远放行——即使 catalog 中仍有其他猫互相冲突（防收敛死锁）', () => {
    const projectRoot = makeProject([
      makeBreed('breed-a', 'cata', { nickname: '砚砚' }),
      makeBreed('breed-b', 'catb', { nickname: '砚砚' }),
      makeBreed('breed-c', 'catc', { nickname: '砚砚' }),
    ]);
    // 存量三重冲突（模拟现网砚砚×5）：单步清掉一只必须成功，否则 operator 无法逐步收敛
    const updated = updateRuntimeCat(projectRoot, 'cata', { nickname: '' });
    const all = toAllCatConfigs(updated);
    assert.equal(all.cata.nickname, undefined);
    assert.equal(all.catb.nickname, '砚砚');
  });

  it('updateRuntimeCat：nickname 不变的幂等写入放行', () => {
    const projectRoot = makeProject([
      makeBreed('breed-a', 'cata', { nickname: '砚砚' }),
      makeBreed('breed-b', 'catb', { nickname: '砚砚' }),
    ]);
    const updated = updateRuntimeCat(projectRoot, 'cata', { nickname: '砚砚' });
    assert.equal(toAllCatConfigs(updated).cata.nickname, '砚砚');
  });

  it('updateRuntimeCat：改成未被持有的新 nickname 放行', () => {
    const projectRoot = makeProject([
      makeBreed('breed-a', 'cata', { nickname: '砚砚' }),
      makeBreed('breed-b', 'catb', { nickname: '砚砚' }),
    ]);
    const updated = updateRuntimeCat(projectRoot, 'catb', { nickname: '小砚' });
    assert.equal(toAllCatConfigs(updated).catb.nickname, '小砚');
  });
});
