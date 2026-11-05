/** A dedicated, one-operation transport for the directly approved recovery.
 * This does not change the installed module's unconditional 6399 prohibition.
 * The source reference is an audit fence, not a locally minted permission token;
 * the operator and independent reviewer must resolve the actual human message.
 */
export const APPROVAL = {
  sourceRef: 'thread_mp3ab0r9xqxrkrc5#0001792567485090-000030-4df86429',
  cardRef: 'thread_mp3ab0r9xqxrkrc5#0001792562134828-000581-0fe5091c',
  taskId: '0001792120368760-000117-3373a9bc',
  ownerUserId: 'default-user',
  archiveApprovalSourceRef: 'thread_mvae90t3xxjfgf2o#0001792617865321-000067-d91f0838',
  archiveBytes: 4543690,
  archiveSha256: '6a9ce578e0d5678c4023b16a8b11c0893e0bc0c66e8a3bc917d77cf3c2533965',
  archiveDigest: 'sha512-7/NKDVTUVo3jjJEDqeSPk1R3B9vyoiwsdAsHGJdAvlbnCDOjNYB6Mh8p0d3VKdjTBYdcmuybIAjV6oTTc60/NA==',
  redisCli: '/opt/homebrew/Cellar/redis/8.4.0/bin/redis-cli',
  redisCliSha256: '8a87b89cb03992aeb9f4095d2deee00bf3ae8389301e2f78533fada347b0b6dd',
  repositories: ['zts212653/clowder-ai', 'zts212653/clowder-ai', 'zts212653/clowder-ai-plugins'],
  directory: '/home/user/cat-cafe/.git/github-event-recovery/20261021-alpha18-supported-migration',
} as const;

export interface SourceScope {
  ownerUserId: string;
  keyPrefix: string;
  repositories: readonly string[];
  excludedTaskIds: readonly string[];
  sourceRef: string;
  oldWriterProofRef: string;
}
export function approvedScope(approvalSource: string, oldWriterProofRef: string): SourceScope {
  if (approvalSource !== APPROVAL.sourceRef) throw new Error('Direct human approval source must match exactly');
  if (!oldWriterProofRef || oldWriterProofRef.length > 500)
    throw new Error('Independent old writer evidence is required');
  return {
    ownerUserId: APPROVAL.ownerUserId,
    keyPrefix: 'cat-cafe:',
    repositories: [...APPROVAL.repositories],
    excludedTaskIds: [APPROVAL.taskId],
    sourceRef: APPROVAL.sourceRef,
    oldWriterProofRef,
  };
}
