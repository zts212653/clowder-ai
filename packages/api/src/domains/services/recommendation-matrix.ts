import { englishRecommendation } from './recommendation-display.js';
import { SERVICE_MATRIX } from './recommendation-matrix-data.js';
import type { EnvironmentProfile, MatchCriteria, MatrixEntry, ServiceRecommendation } from './recommendation-types.js';

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function matchesCriteria(criteria: MatchCriteria, profile: EnvironmentProfile): boolean {
  if (criteria.os && !asArray(criteria.os).includes(profile.os)) return false;
  if (criteria.arch && !asArray(criteria.arch).includes(profile.arch)) return false;
  if (criteria.gpu && !asArray(criteria.gpu).includes(profile.gpu)) return false;
  if (criteria.pythonArch && !asArray(criteria.pythonArch).includes(profile.pythonArch)) return false;
  return true;
}

export function findMatrixEntry(serviceId: string, profile: EnvironmentProfile): MatrixEntry | null {
  const entries = SERVICE_MATRIX[serviceId];
  if (!entries) return null;
  return entries.find((entry) => matchesCriteria(entry.match, profile)) ?? null;
}

export function buildRecommendation(
  serviceId: string,
  profile: EnvironmentProfile,
  locale: 'zh' | 'en' = 'zh',
): ServiceRecommendation {
  // Short-circuit when the host CPU architecture is unsupported (ia32,
  // arm, mips, ...). resolveArch flags these explicitly instead of
  // silently coercing to x64 — codex P2 3252087645. Fail fast in the
  // preview so the user sees a clear unsupported message rather than
  // a deep wheel-resolution error during install.
  if (profile.arch === 'unsupported') {
    const detected = profile.archRaw ?? 'unknown';
    return {
      serviceId,
      profile,
      models: [],
      notes: [],
      unsupported: {
        reason:
          locale === 'en'
            ? `CPU architecture "${detected}" is unsupported (arm64 / x64 only).`
            : `当前 CPU 架构 "${detected}" 不在受支持的列表（仅支持 arm64 / x64）`,
        userAction:
          locale === 'en'
            ? 'Retry on an arm64 or x64 host. Contact the developers for other architectures.'
            : '请在 arm64 或 x64 主机上重试；如需在 32 位或其他架构上运行，请联系开发者',
        retryHint:
          locale === 'en'
            ? 'Continue after switching to a supported host architecture.'
            : '更换主机或使用支持的架构后即可继续',
      },
    };
  }

  const entry = findMatrixEntry(serviceId, profile);
  if (!entry) {
    return {
      serviceId,
      profile,
      models: [],
      notes: [],
      unsupported: {
        reason:
          locale === 'en'
            ? `Service ${serviceId} has no recommended configuration for ${profile.os}/${profile.arch}/gpu=${profile.gpu}.`
            : `服务 ${serviceId} 没有针对当前环境（${profile.os}/${profile.arch}/gpu=${profile.gpu}）的推荐配置`,
        userAction:
          locale === 'en'
            ? 'Contact the developers or open a GitHub issue to add support for this environment.'
            : '请联系开发者补充矩阵条目，或在 GitHub 提 issue',
        retryHint:
          locale === 'en'
            ? 'Reopen the install dialog after environment support is added.'
            : '矩阵更新后无需操作，重新打开安装弹窗即可',
      },
    };
  }
  const recommendation = {
    serviceId,
    profile,
    models: entry.models ?? [],
    unsupported: entry.unsupported,
    notes: entry.notes ?? [],
    customModelHint: entry.customModelHint,
  };
  return locale === 'en' ? englishRecommendation(recommendation, entry) : recommendation;
}

export function getMatrixServiceIds(): string[] {
  return Object.keys(SERVICE_MATRIX);
}

export { SERVICE_MATRIX };
