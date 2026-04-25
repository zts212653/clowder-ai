/**
 * Cat Model Configuration
 * F32-b: Dynamic env key resolution — CAT_{CATID}_MODEL (uppercased, hyphens → underscores)
 *
 * 运行时来源: .cat-cafe/cat-catalog.json（唯一配置源）
 * 环境变量 CAT_{CATID}_MODEL 可 override，用于调试。
 */

import { catRegistry } from '@cat-cafe/shared';

/**
 * F32-b: Generate dynamic env key from catId.
 * e.g. "opus" → "CAT_OPUS_MODEL", "opus-45" → "CAT_OPUS_45_MODEL"
 */
function getCatModelEnvKey(catId: string): string {
  return `CAT_${catId.toUpperCase().replace(/-/g, '_')}_MODEL`;
}

/**
 * 获取猫的实际模型。
 * 运行时读 catRegistry（.cat-cafe/cat-catalog.json），环境变量可 override。
 */
export function getCatModel(catName: string): string {
  // 1. 环境变量最高优先 (dynamic key: CAT_{CATID}_MODEL)
  const envKey = getCatModelEnvKey(catName);
  const envValue = process.env[envKey]?.trim();
  if (envValue) {
    return envValue;
  }

  // 2. catRegistry (populated from .cat-cafe/cat-catalog.json at startup)
  const entry = catRegistry.tryGet(catName);
  if (entry) {
    return entry.config.defaultModel;
  }

  throw new Error(`No model configured for cat "${catName}"`);
}

/**
 * 获取所有猫的模型配置 (用于 ConfigRegistry)
 */
export function getAllCatModels(): Record<string, string> {
  const result: Record<string, string> = {};
  const allIds = catRegistry.getAllIds().map(String);
  for (const catName of allIds) {
    result[catName] = getCatModel(catName);
  }
  return result;
}
