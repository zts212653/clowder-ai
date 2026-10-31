async function settleCheck(check, execute, errors) {
  try {
    const result = await execute(check.name);
    if (result?.status === 'not_run' && typeof result.reason === 'string') Object.assign(check, result);
    else if (result === undefined) check.status = 'passed';
    else throw new Error('Invalid check result');
  } catch (error) {
    check.status = 'failed';
    errors.push(error);
  }
}

async function continuationSafe(check, canContinue, errors) {
  if (!canContinue) return true;
  try {
    const safe = (await canContinue(check.name)) === true;
    check.cleanup = safe ? 'confirmed' : 'unconfirmed';
    return safe;
  } catch (error) {
    errors.push(error);
    check.cleanup = 'unconfirmed';
    return false;
  }
}

/** Collect independent observations; callers still reject any incomplete or failed result. */
export async function collectChecks(names, execute, { canContinue, observe = () => {} } = {}) {
  const checks = names.map((name) => ({ name, status: 'not_run' }));
  const errors = [];
  await observe(checks);
  for (const check of checks) {
    await settleCheck(check, execute, errors);
    const safe = await continuationSafe(check, canContinue, errors);
    if (!safe) {
      check.executionStatus = check.status;
      check.status = 'failed';
      check.reason = 'cleanup-unconfirmed';
      for (const pending of checks.slice(checks.indexOf(check) + 1)) pending.reason = 'prior-cleanup-unconfirmed';
      errors.push(new Error(`Cleanup unconfirmed after ${check.name}`));
    }
    await observe(checks);
    if (!safe) break;
  }
  return {
    status: checks.every((check) => check.status === 'passed' && check.cleanup !== 'unconfirmed') ? 'passed' : 'failed',
    checks,
    errors,
  };
}

export function assertChecksPassed(result) {
  if (result.status !== 'passed')
    throw new AggregateError(result.errors, 'Candidate checks failed; see individual results');
}
