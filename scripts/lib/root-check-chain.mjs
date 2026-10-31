// `check` is a pure composition of the three requirement tiers, so a guard
// asking "is this check wired into the gate?" must look through that
// composition. Expanding only the tiers keeps the question unchanged: nested
// sub-chains inside an individual check are still that check's own business.
const TIER_SCRIPTS = Object.freeze(['check:sources', 'check:installed', 'check:artifacts']);

const stepsOf = (scripts, name) =>
  (scripts?.[name] ?? '')
    .split('&&')
    .map((step) => step.trim())
    .filter(Boolean);

/**
 * Flat list of the steps `pnpm check` actually runs, with the tier
 * composition expanded.
 */
export function rootCheckSteps(scripts) {
  return stepsOf(scripts, 'check').flatMap((step) => {
    const name = step.replace(/^pnpm\s+/u, '').trim();
    return TIER_SCRIPTS.includes(name) ? stepsOf(scripts, name) : [step];
  });
}

/** The expanded chain rendered back as ` && `-joined text, for regex guards. */
export function rootCheckChain(scripts) {
  return rootCheckSteps(scripts).join(' && ');
}

export { TIER_SCRIPTS };
