/**
 * Human-facing identities for agent tools that are discovered directly on the
 * host (Kimi CLI, DSH ACP, Pi ACP).
 *
 * These identities are deliberately shipped in code as well as in
 * `cat-template.json`: an upgraded install can keep an older project template
 * for a while, and a detected partner must still look like the cat the product
 * promised instead of falling back to a generic "Kimi 伙伴" placeholder.
 *
 * `legacy` records the exact strings written by earlier releases. Repair code
 * may replace a field only when it still equals that legacy value, so a user's
 * own edits are never overwritten.
 */
export type NativeToolKey = 'kimi' | 'dsh' | 'pi';

export interface NativeToolColor {
  primary: string;
  secondary: string;
}

export interface NativeToolLegacyIdentity {
  name: string;
  nickname: string;
  avatar: string;
  roleDescription: string;
  personality: string;
  teamStrengths: string;
}

export interface NativeToolIdentity {
  key: NativeToolKey;
  templateId: string;
  name: string;
  nickname: string;
  avatar: string;
  color: NativeToolColor;
  roleDescription: string;
  personality: string;
  teamStrengths: string;
  legacy: NativeToolLegacyIdentity;
}

export const NATIVE_TOOL_IDENTITIES: Record<NativeToolKey, NativeToolIdentity> = {
  kimi: {
    key: 'kimi',
    templateId: 'turkish-van',
    name: '梵花猫',
    nickname: '墨墨',
    avatar: '/avatars/family/kimi.png',
    color: { primary: '#6B6F9E', secondary: '#E2E3F0' },
    roleDescription: '共创伙伴，擅长编码、文档与任务验收',
    personality: '细心务实，保留自己的判断，愿意把事情接住做完',
    teamStrengths: '编码、文档、验收',
    legacy: {
      name: 'Kimi 伙伴',
      nickname: 'Kimi',
      avatar: '/avatars/default.png',
      roleDescription: '一起分析问题、完成任务',
      personality: '认真务实，先确认目标，完成后说明结果',
      teamStrengths: '任务拆解、实现与验证',
    },
  },
  dsh: {
    key: 'dsh',
    templateId: 'dsh',
    name: '小鲸鱼',
    nickname: '鲸鲸',
    avatar: '/avatars/family/dsh.png',
    color: { primary: '#3B7EA1', secondary: '#DCEBF2' },
    roleDescription: '共创与推理伙伴，负责分析问题、编码实现和交叉验证',
    personality: '细心务实，先理清问题，再用可验证的结果交付',
    teamStrengths: '问题分析、编码、交叉验证',
    legacy: {
      name: 'DSH 伙伴',
      nickname: '深深',
      avatar: '/avatars/family/kimi.png',
      roleDescription: '共创与推理伙伴，负责分析问题、编码实现和交叉验证',
      personality: '细心务实，先理清问题，再用可验证的结果交付',
      teamStrengths: '问题分析、编码、交叉验证',
    },
  },
  pi: {
    key: 'pi',
    templateId: 'golden-chinchilla',
    name: '金渐层',
    nickname: '金哥',
    avatar: '/avatars/family/opencode.png',
    color: { primary: '#C8A951', secondary: '#F5EDDA' },
    roleDescription: '轻量编码伙伴，负责拆解小任务、实现和验证',
    personality: '敏捷克制，先给最小可用实现，再补验证细节',
    teamStrengths: '任务拆解、编码实现、测试验证',
    legacy: {
      name: 'Pi 伙伴',
      nickname: '派派',
      avatar: '/avatars/family/opencode.png',
      roleDescription: '轻量编码伙伴，负责拆解小任务、实现和验证',
      personality: '敏捷克制，先给最小可用实现，再补验证细节',
      teamStrengths: '任务拆解、编码实现、测试验证',
    },
  },
};

export interface NativeToolIdentityInput {
  /** Discovery client id (`kimi`, `acp`, ...). */
  clientId?: string | null;
  /** Runtime id or catalog cat id (`kimi`, `dsh`, `pi`, ...). */
  catId?: string | null;
  /** ACP launch descriptor; only used to tell DSH and Pi apart. */
  acp?: unknown;
}

function descriptorText(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Resolve a discovered runtime or persisted catalog variant to one of the
 * identities this module owns. Returns undefined for unrelated tools.
 */
export function resolveNativeToolKey(input: NativeToolIdentityInput): NativeToolKey | undefined {
  const clientId = (input.clientId ?? '').trim().toLowerCase();
  const catId = (input.catId ?? '').trim().toLowerCase();

  if (clientId === 'kimi' || catId === 'kimi') return 'kimi';

  if (catId === 'dsh' || catId === 'pi') return catId;

  if (clientId !== 'acp') return undefined;

  const descriptor = descriptorText(input.acp);
  if (descriptor.includes('pi-acp-bridge') || descriptor.includes('pi-coding-agent')) return 'pi';
  if (descriptor.includes('dsh') || descriptor.includes('deepseek')) return 'dsh';
  return undefined;
}

export function nativeToolIdentityFor(input: NativeToolIdentityInput): NativeToolIdentity | undefined {
  const key = resolveNativeToolKey(input);
  return key ? NATIVE_TOOL_IDENTITIES[key] : undefined;
}
