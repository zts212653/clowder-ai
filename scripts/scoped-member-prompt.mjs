import { readFileSync } from 'node:fs';

/** Allowlisted identity; account data, home overlays and project files never enter this projection. */
export function compileScopedMemberPrompt(input) {
  if (
    !input ||
    typeof input.catId !== 'string' ||
    !input.catId.trim() ||
    typeof input.model !== 'string' ||
    !input.model.trim()
  )
    throw new Error('scoped_member_identity_unavailable');
  const identity = [
    `你是 ${input.displayName || input.catId}${input.nickname ? ` / ${input.nickname}` : ''}。`,
    ...(input.roleDescription ? [`角色：${input.roleDescription}`] : []),
    ...(input.personality ? [`性格：${input.personality}`] : []),
    `Identity constant: \`@${input.catId}\` model=${input.model}`,
  ].join('\n');
  return readFileSync(new URL('../assets/prompt-templates/l0-scoped-member.md', import.meta.url), 'utf8').replace(
    '{{MEMBER_IDENTITY}}',
    identity,
  );
}
