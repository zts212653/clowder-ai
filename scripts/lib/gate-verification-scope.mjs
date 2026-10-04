const SHA40 = /^[0-9a-f]{40}$/u;

// Omitted scope belongs only to the pre-source-full merge protocol.
export function gateVerificationScope(value) {
  if (value === undefined) return 'merge';
  if (value === 'merge' || value === 'source_full') return value;
  throw new Error(`Unknown gate verificationScope: ${String(value)}`);
}

export function gateInvocationScope(argv) {
  const indexes = argv.flatMap((arg, index) => (arg === '--source-full' ? [index] : []));
  if (!indexes.length) return { verificationScope: 'merge', sourceSha: null };
  const sourceSha = argv[indexes[0] + 1];
  if (indexes.length !== 1 || !SHA40.test(sourceSha ?? '')) {
    throw new Error('--source-full requires one exact 40-hex source SHA');
  }
  if (['--no-rebase', '--skip-install', '--auto-fix', '--continuity-claim'].some((flag) => argv.includes(flag))) {
    throw new Error('--source-full cannot be combined with local, partial or continuity options');
  }
  return { verificationScope: 'source_full', sourceSha };
}

export function gateRunHasScope(run, expected) {
  try {
    const resultScope = gateVerificationScope(run.result?.verificationScope);
    const frozenScope = gateVerificationScope(run.frozenIdentity?.verificationScope);
    return resultScope === expected && frozenScope === expected;
  } catch {
    return false;
  }
}

export function assertSourceFullCut(sourceSha, headSha, baseSha, continuityClaimId) {
  if (sourceSha && (headSha !== sourceSha || baseSha !== sourceSha || continuityClaimId)) {
    throw new Error('source_full requires the exact source HEAD/base and forbids continuity claims');
  }
}

export function assertSourceFullIdentity(identity) {
  if (
    gateVerificationScope(identity.verificationScope) === 'source_full' &&
    (identity.headSha !== identity.baseSha || identity.route !== 'full' || identity.mode !== 'full')
  ) {
    throw new Error('source_full requires base=head, route=full and mode=full');
  }
}
