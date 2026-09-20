/**
 * The install's one owner.
 *
 * Two settings can name it. `DEFAULT_OWNER_USER_ID` is the owner trust anchor that
 * privileged gates check, and it is the one `.env.example` asks a multi-user
 * deployment to set. `CAT_CAFE_USER_ID` is the user whose runtime data this install
 * owns, defaulting to `default-user`. The anchor wins when configured, the same
 * precedence the agent-key sidecars already use, so configuring only the anchor stays
 * supported: this install's lifecycle spaces, schedulers, publishers and memory index
 * all belong to that user. Browser sessions are narrower by design -- only a direct
 * loopback bootstrap is minted as the owner, and a remote or proxied one never is
 * (see `infrastructure/session-auth.ts`) -- so this identity is not a session grant.
 *
 * Only two explicit, different owners contradict each other: the operator has declared
 * one user privileged and another the data owner, so no single owner identity exists.
 * Whichever half a consumer reads, the other is wrong -- privileged gates trust one id
 * while runtime data and F257 lifecycle spaces belong to the other. That configuration
 * refuses to boot, because the alternative is an install whose owner cannot govern it
 * with no error anywhere.
 */
export function installOwnerUserId(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeUserId = (env.CAT_CAFE_USER_ID ?? 'default-user').trim();
  if (!runtimeUserId) throw new Error('[api] CAT_CAFE_USER_ID must not be blank');
  return env.DEFAULT_OWNER_USER_ID?.trim() || runtimeUserId;
}

/**
 * The same identity, asserted coherent. Boot calls this once, so an install with two
 * declared owners never starts; every other consumer reads the total derivation
 * above, because a library accessor must not throw on a legacy configuration.
 */
export function resolveInstallOwnerUserId(env: NodeJS.ProcessEnv = process.env): string {
  const owner = installOwnerUserId(env);
  const trustAnchor = env.DEFAULT_OWNER_USER_ID?.trim();
  const configuredRuntimeUserId = env.CAT_CAFE_USER_ID?.trim();
  if (trustAnchor && configuredRuntimeUserId && trustAnchor !== configuredRuntimeUserId) {
    throw new Error(
      `[api] DEFAULT_OWNER_USER_ID ("${trustAnchor}") and CAT_CAFE_USER_ID ("${configuredRuntimeUserId}") ` +
        'explicitly declare different owners, so this install has no single owner identity: privileged gates ' +
        'would trust one id while runtime data and F257 lifecycle spaces belong to the other. Set both to the ' +
        'owner, or set only DEFAULT_OWNER_USER_ID and leave CAT_CAFE_USER_ID unset.',
    );
  }
  return owner;
}
