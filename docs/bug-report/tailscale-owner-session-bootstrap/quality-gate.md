---
feature_ids: [F156]
topics: [security, session, tailscale, cache, quality-gate]
doc_kind: quality-gate
created: 2026-08-14
updated: 2026-08-14
tips_exempt:
  reason: Verification evidence for restoring the existing opt-in private-network access path; no new user action or capability is introduced.
---

# F156 Tailscale owner session bootstrap — quality gate

## Verdict

Implementation commit `b3af0e75590c36cf0138b7c26002f84f507e2a87` is ready for non-author security review and repository CI. The implementation meets the pre-merge boundary: direct opt-in private/Tailscale clients receive the existing owner identity, public and forwarded callers fail closed, and current-build chat HTML cannot be replaced by a cross-build cached root shell.

This is not a deployment or field-completion claim. Runtime `:3003/:3004` is still on `83e7bd0cd68a841b7bb8e6d25a439763c8505481`; the real phone/tablet path remains open until reviewed merge, runtime update, and a Tailscale-IP acceptance probe all succeed.

## Vision and acceptance matrix

| Operator requirement | Implementation evidence | Verification evidence | Result |
|---|---|---|---|
| `IP:3003` should open the existing cat cafe with historical conversations | The production session route maps the existing `CORS_ALLOW_PRIVATE_NETWORK=true` opt-in into direct private-network owner bootstrap | Fastify injection from `100.88.90.108` and RFC1918 peers returns the configured owner; production wiring test requires the env option | Met pre-merge |
| Security hardening must not turn every remote caller into owner | Trust uses the actual direct peer address and rejects standard proxy forwarding headers | Public IPv4, CGNAT boundary values, loopback proxy, and private-address proxy remain non-owner | Met |
| A frontend update must not leave mobile devices loading an obsolete HTML shell | Both chat entry documents are dynamic; PWA start URL is runtime-cached rather than precached | Next production route table marks `/` and `/thread/[threadId]` dynamic; both return `private, no-cache, no-store`; generated `sw.js` has no root precache entry | Met pre-merge |
| No cache clearing ritual should be required after the repaired build is running | The repaired server response and worker policy replace the old one-year HTML cache contract | Isolated production HTTP probe and generated-worker inspection | Met in isolated build; field acceptance pending |

## Red-to-green record

1. API RED failed because opt-in RFC1918/Tailscale callers still received `default-user` instead of the configured owner; production wiring also omitted the private-network option.
2. Web RED failed because both chat documents lacked `force-dynamic` and `dynamicStartUrl` was `false`.
3. The implementation added one bounded direct-peer classifier, wired the existing operator opt-in into session bootstrap, and changed the two build-specific chat documents to dynamic rendering.
4. The same API run passed 25/25 and the Web configuration/cache-policy run passed 9/9.
5. A real isolated Next production build marked both routes dynamic; HTTP probes returned `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, and `sw.js` contained no `url:"/"` precache entry.

## Five-axis risk

- **Behavior:** high — changes the identity seen by a phone/tablet and restores historical thread visibility.
- **Data:** low — no persistence schema, store, migration, or user-data mutation.
- **Security:** high — modifies the owner bootstrap trust boundary, but only behind the pre-existing explicit private-network opt-in.
- **Contract:** medium — expands the meaning of `CORS_ALLOW_PRIVATE_NETWORK=true` from Origin admission to consistent single-user session admission for direct private peers.
- **Irreversible:** none — one commit reverts the behavior and no persistent data is rewritten.

## Verification evidence

| Check | Result |
|---|---|
| `pnpm --filter @cat-cafe/api build` | Exit 0 |
| `node --test packages/api/test/infrastructure/session-auth.test.js packages/api/test/auto-dream-index-wiring.test.js` | 25 passed, 0 failed |
| `node --test packages/web/test/next-config.test.cjs packages/web/test/chat-route-cache-policy.test.cjs` | 9 passed, 0 failed |
| `pnpm --filter @cat-cafe/web build` | Exit 0; `/` and `/thread/[threadId]` are dynamic |
| Isolated production server at `127.0.0.1:5112` | Root and thread HTML both 200 with `private, no-cache, no-store`; server stopped after probe |
| Generated `packages/web/public/sw.js` | `ROOT_PRECACHE=absent` |
| `pnpm check:capability-tips` | Exit 0; existing unrelated warnings only |
| `git diff --check origin/main...HEAD` | Exit 0 |
| `node scripts/check-hotfix-pattern.mjs` | No hotfix pattern |
| `node scripts/check-fallback-layers.mjs` | One logical OR added; cumulative threshold warning only |
| `pnpm check:architecture-ownership` | Command is not defined in this checkout; recorded as tooling drift rather than reported green |
| `pnpm gate --no-rebase --skip-install` | Exit 1 after 1,122 s because no `tmux` executable exists on this host; `tmux-gateway` and `tmux-spawn-override` setup failed before their tests could run. No changed F156 test failed. Repository CI remains required. |

## Dogfood-Your-Slice

Scope verdict: required because this is a user-visible remote-access bug.

Pre-merge end-to-end boundary exercised:

1. Session route registered with `ownerUserId=private-owner` and `trustPrivateNetwork=true`.
2. Direct peer `100.88.90.108` called `GET /api/session` and received `private-owner`.
3. Public, out-of-range CGNAT, and proxy-header variants called the same route and remained non-owner.
4. Exact worktree production Web build served `/` and `/thread/cache-acceptance` from `127.0.0.1:5112`; both returned non-cacheable HTML.

No dogfood defect remained. The structural boundary is that the real `100.88.90.108:3003` runtime cannot exercise this source before merge and runtime update; that exact field path remains a completion gate.

## Security and failure-mode audit

- Private-network trust is default-off and reuses the same explicit operator switch already required for private Origin admission.
- The positive ranges are RFC1918 IPv4 and Tailscale's `100.64.0.0/10`; `100.63.255.255` and `100.128.0.1` are negative boundary cases.
- IPv4-mapped Tailscale peers are normalized; arbitrary IPv6, public IPv4, malformed addresses, and loopback are not classified as private peers.
- Any standard forwarding header disqualifies the private-peer bootstrap. The code never trusts `X-Forwarded-For` as the source identity.
- No session token, cookie, user data, thread data, or Redis state is logged or changed by the repair.
- The fallback scanner's single new `loopback || (opt-in && direct-private-peer)` branch is the trust predicate itself, not an alternate recovery implementation. The coordinate-system repair is to make the existing private-network opt-in govern both Origin and session admission.
- No matching F156/Tailscale/session/cache `.pen` design exists. The change has no visual layout delta.
- Artifact hygiene found no root-level media or design artifact.

## Architecture ownership

Architecture cell: existing F156 browser trust/session boundary; nearest registered cell is `identity-session`.

Map delta: none. The repair adds no Store, Queue, Router, Adapter, persistence owner, or new authentication mechanism. The ownership registry does not currently enumerate browser HttpOnly session bootstrap as an `identity-session` subcell; reviewer should treat that missing map precision as an architecture warning, not infer a new owner from this bugfix.

## Close boundary

This quality gate authorizes review only. It does not close the incident. Remaining gates are non-author security review, CI, merge, runtime update, and a real phone/tablet probe confirming owner identity plus historical thread visibility at `http://<Tailscale-IP>:3003`.
