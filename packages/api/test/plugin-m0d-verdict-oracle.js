function failureClasses(report) {
  if (!Array.isArray(report?.failures) || !report.failures.every((failure) => typeof failure === 'string')) {
    throw new TypeError('behavior report failures must be a string array');
  }
  return {
    statusPassed: !report.failures.some((failure) => failure.startsWith('status:')),
    sideEffectsPassed: !report.failures.some(
      (failure) => !failure.startsWith('status:') && !failure.startsWith('errorCode:'),
    ),
  };
}

export function evaluateDeclaredVerdict(execution, report, outcome) {
  const oracle = execution?.verdictOracle;
  const { statusPassed, sideEffectsPassed } = failureClasses(report);
  if (oracle?.kind === 'behavior-expectation') {
    return { verdict: report.passed === true ? 'pass' : 'canonical-mismatch', sideEffectsPassed };
  }
  if (oracle?.kind === 'json-rpc-error') {
    const passed =
      outcome?.status === 'error' && outcome.error?.code === oracle.code && statusPassed && sideEffectsPassed;
    return { verdict: passed ? 'pass' : 'admission-safety-failure', sideEffectsPassed };
  }
  throw new Error(`unsupported verdict oracle ${String(oracle?.kind)}`);
}
