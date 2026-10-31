/**
 * pnpm forwards the separator used after a package script as a literal leading
 * `--` on supported versions. Keep that transport detail outside the planner,
 * runner, and summarizer contracts so each still rejects every other unknown
 * argument.
 */
export function normalizePublicTestCliArgv(argv) {
  if (!Array.isArray(argv)) throw new Error('public-test CLI arguments must be an array');
  return argv[0] === '--' ? argv.slice(1) : [...argv];
}
