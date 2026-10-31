/**
 * Lifecycle capabilities that belong to the official runtime process only.
 *
 * The runtime launcher opts in explicitly (scripts/runtime-worktree.sh). Every process the
 * API spawns on someone's behalf — agent CLIs, terminal panes, managed wakeWhen commands —
 * may start a dev server inside a feature worktree; if one of these values leaked, that dev
 * server would act like the runtime owner (e.g. autostart the shared IM bots and knock the
 * production connection offline). Each spawn path strips or neutralises exactly this list.
 */
export const RUNTIME_ONLY_LIFECYCLE_ENV_KEYS = [
  'CONNECTOR_GATEWAY_AUTOSTART',
  'CAT_CAFE_PROVISION_GLOBAL_SIDECAR',
  'CAT_CAFE_RUNTIME_ARTIFACTS_VERIFIED',
  'CAT_CAFE_ALPHA_COORDINATES',
] as const;
