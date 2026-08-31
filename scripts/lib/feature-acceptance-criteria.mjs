const ACCEPTANCE_CRITERION_LINE =
  /^- \[([ xX])\]\s+(?:\*\*)?(AC-[A-Z0-9][A-Z0-9._-]*(?:\s*\/\s*AC-[A-Z0-9][A-Z0-9._-]*)?)(?:\*\*)?\s*:/gim;

export function parseAcceptanceCriteria(markdown) {
  return [...String(markdown).matchAll(ACCEPTANCE_CRITERION_LINE)].map((match) => ({
    checked: match[1].toLowerCase() === 'x',
    label: match[2],
  }));
}

export function allAcceptanceCriteriaAreChecked(markdown) {
  const criteria = parseAcceptanceCriteria(markdown);
  return criteria.length > 0 && criteria.every((criterion) => criterion.checked);
}
