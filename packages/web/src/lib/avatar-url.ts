import { API_URL } from '@/utils/api-client';

const canonicalAvatarPath = /^\/api\/cats\/[^/?#]+\/avatar(?:\?|$)/;

export function isCanonicalAvatarUrl(src: string | null | undefined): boolean {
  return !!src && /^(?:https?:\/\/[^/]+)?\/api\/cats\/[^/?#]+\/avatar(?:\?|$)/.test(src);
}

export function resolveAvatarUrl(src: string): string {
  return canonicalAvatarPath.test(src) ? `${API_URL}${src}` : src;
}
