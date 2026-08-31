/**
 * F257 修复清单 #1 — 跨猫唯一性校验（dev-628ea4d1 根因修复）。
 *
 * 分级契约（为什么 patterns 与 nickname 力度不同）：
 * - mentionPatterns 跨猫冲突 → fail-closed（toAllCatConfigs 抛错 = 启动拒绝）。
 *   pattern 是路由确定性的根基：共享 pattern 意味着 @token 必然有一只猫收错球。
 *   现网数据（template + catalog）无字面冲突，启动拒绝可安全上线。
 * - nickname 跨猫冲突 → 结构化告警（不阻断加载）。现网存量冲突（宪宪×3/砚砚×5/
 *   烁烁×2）阻断启动会砸运行实例；新增冲突由写入层增量拒绝（runtime-cat-catalog
 *   assertNicknameAvailable），存量由 operator 经 UI 逐步收敛——清空/收敛操作
 *   永远放行，防止「任何单步修改都无法使全量校验通过」的收敛死锁。
 *
 * 归一化口径与 runtime-cat-catalog.assertUniqueMentionAliases 一致：trim + lowercase。
 */

import type { CatConfig } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import { normalizeMentionAlias } from './template-variant-backfill.js';

const log = createModuleLogger('cat-uniqueness');

export interface PatternConflict {
  readonly pattern: string;
  readonly holders: readonly string[];
}

export interface NicknameConflict {
  readonly nickname: string;
  readonly holders: readonly string[];
}

export interface CrossCatConflicts {
  readonly patternConflicts: readonly PatternConflict[];
  readonly nicknameConflicts: readonly NicknameConflict[];
}

/** pattern 归一化复用 template-variant-backfill.normalizeMentionAlias（单一真相源）；nickname 同口径 */
export function normalizeNickname(nickname: string): string {
  return nickname.trim().toLowerCase();
}

interface HolderEntry {
  display: string;
  holders: string[];
}

function addHolder(map: Map<string, HolderEntry>, key: string, display: string, catId: string): void {
  const entry = map.get(key);
  if (entry) {
    entry.holders.push(catId);
    return;
  }
  map.set(key, { display, holders: [catId] });
}

/** 展开后的 per-cat 配置 → 跨猫 pattern / nickname 冲突清单（纯函数） */
export function collectCrossCatConflicts(configs: Record<string, CatConfig>): CrossCatConflicts {
  const patternHolders = new Map<string, HolderEntry>();
  const nicknameHolders = new Map<string, HolderEntry>();

  for (const [catId, config] of Object.entries(configs)) {
    const ownPatterns = new Set<string>();
    for (const pattern of config.mentionPatterns) {
      const key = normalizeMentionAlias(pattern);
      // 同猫内部重复（breed/variant 同值、大小写变体）不是跨猫冲突
      if (!key || ownPatterns.has(key)) continue;
      ownPatterns.add(key);
      addHolder(patternHolders, key, pattern.trim(), catId);
    }

    if (config.nickname) {
      const key = normalizeNickname(config.nickname);
      if (key) addHolder(nicknameHolders, key, config.nickname.trim(), catId);
    }
  }

  const toConflicts = <T>(map: Map<string, HolderEntry>, build: (entry: HolderEntry) => T): T[] =>
    [...map.values()].filter((entry) => entry.holders.length > 1).map(build);

  return {
    patternConflicts: toConflicts(patternHolders, (e) => ({ pattern: e.display, holders: e.holders })),
    nicknameConflicts: toConflicts(nicknameHolders, (e) => ({ nickname: e.display, holders: e.holders })),
  };
}

/**
 * fail-closed 出口：mentionPatterns 跨猫冲突 → 抛错。
 * 调用点 = toAllCatConfigs（加载 / 写入冒烟 / registry 构建的共同必经点）。
 */
export function assertNoCrossCatPatternConflicts(configs: Record<string, CatConfig>): void {
  const { patternConflicts } = collectCrossCatConflicts(configs);
  if (patternConflicts.length === 0) return;
  const detail = patternConflicts
    .map((c) => `mention pattern "${c.pattern}" is shared by cats [${c.holders.join(', ')}]`)
    .join('; ');
  throw new Error(
    `Cross-cat mention pattern conflict (fail-closed, F257 #1 / dev-628ea4d1): ${detail}. ` +
      'Each mention pattern must resolve to exactly one cat — fix cat-template.json / .cat-cafe/cat-catalog.json ' +
      'so every pattern has a single holder.',
  );
}

/** 进程内同一冲突集合只告警一次（loadCatConfig 为中频调用，避免日志刷屏） */
const warnedSignatures = new Set<string>();

/**
 * nickname 跨猫冲突结构化告警（不阻断）。返回冲突清单便于调用方/测试消费。
 * fail-closed 不适用的原因见文件头「分级契约」。
 */
export function warnOnNicknameConflicts(configs: Record<string, CatConfig>): readonly NicknameConflict[] {
  const { nicknameConflicts } = collectCrossCatConflicts(configs);
  if (nicknameConflicts.length === 0) return nicknameConflicts;
  const signature = JSON.stringify(
    nicknameConflicts
      .map((c) => [c.nickname, [...c.holders].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  if (!warnedSignatures.has(signature)) {
    warnedSignatures.add(signature);
    log.warn(
      { conflicts: nicknameConflicts.map((c) => ({ nickname: c.nickname, holders: c.holders })) },
      'Cross-cat nickname conflict (F257 #1, warn-only for legacy data): nicknames must be per-cat unique — ' +
        'release or rename via the cat editor. New conflicts are rejected at write time.',
    );
  }
  return nicknameConflicts;
}
