const EXTERNAL_REVIEW_MODES = new Set(['formal', 'advisory_read_only']);
const ENGLISH_REVIEW_ARTIFACT = '(?:reviews?|comments?|verdicts?|findings?|conclusions?)';
const ENGLISH_GITHUB_ARTIFACT = `(?:github\\s+(?:pr\\s+)?${ENGLISH_REVIEW_ARTIFACT}|${ENGLISH_REVIEW_ARTIFACT}.{0,24}\\b(?:on|to|in)\\s+(?:the\\s+)?github)`;
const ENGLISH_NO_GITHUB_DELIVERY = [
  new RegExp(
    `\\b(?:do\\s+not|don't|must\\s+not|never)\\s+(?:(?:post|leave|write|publish|submit|deliver|add|make)\\s+(?:any\\s+|an?\\s+|the\\s+)?${ENGLISH_GITHUB_ARTIFACT}|(?:comment|review)\\b.{0,24}\\b(?:on|to|in)\\s+(?:the\\s+)?github)`,
    'i',
  ),
  new RegExp(`\\b(?:skip|omit|avoid)\\s+(?:any\\s+|an?\\s+|the\\s+)?${ENGLISH_GITHUB_ARTIFACT}`, 'i'),
  /\b(?:skip|omit|avoid|refrain\s+from)\s+(?:posting|leaving|writing|publishing|submitting|delivering|commenting|reviewing)\b.{0,24}\b(?:on|to|in)\s+(?:the\s+)?github\b/i,
  new RegExp(`\\bkeep\\s+(?:the\\s+)?${ENGLISH_REVIEW_ARTIFACT}\\s+out\\s+of\\s+github\\b`, 'i'),
  new RegExp(`\\bno\\s+${ENGLISH_GITHUB_ARTIFACT}`, 'i'),
];
const CHINESE_NO_GITHUB_DELIVERY = [
  /(?:不要|禁止|不得|无需|不必|别|勿|不再)[^。；\n]{0,24}(?:github|pr)[^。；\n]{0,16}(?:评论|留言|回写|发布|提交|结论|verdict)/i,
  /(?:不要|禁止|不得|无需|不必|别|勿|不再)[^。；\n]{0,24}(?:评论|留言|回写|发布|提交|结论|verdict)[^。；\n]{0,16}(?:github|pr)/i,
  /(?:结论|评审|复审|verdict|评论|留言|回写)[^。；\n]{0,8}不(?:再)?(?:落|发|发布|提交|回写|留)[^。；\n]{0,8}(?:github|pr)/i,
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function reviewModeFor(input) {
  if (input?.reviewMode === undefined) return 'formal';
  return EXTERNAL_REVIEW_MODES.has(input.reviewMode) ? input.reviewMode : 'unknown';
}

export function hasNoGitHubDeliveryDirective(instructions) {
  if (!nonEmptyString(instructions)) return false;
  return [...ENGLISH_NO_GITHUB_DELIVERY, ...CHINESE_NO_GITHUB_DELIVERY].some((pattern) => pattern.test(instructions));
}

export function checkReviewEntryMode(input, { classifyIntent, checkExactTarget }) {
  const errors = [];
  const intent = classifyIntent(input);
  const mode = reviewModeFor(input);
  const entry = isRecord(input?.entry) ? input.entry : null;

  if (!entry) {
    return { ok: false, intent, mode, errors: ['Review entry payload is missing.'] };
  }
  if (!['task', 'tracker'].includes(entry.kind)) {
    errors.push('Review entry kind must be task or tracker.');
  }
  if (mode === 'unknown') {
    errors.push('Review entry mode must be formal or advisory_read_only.');
  }
  if (!nonEmptyString(entry.instructions)) {
    errors.push('Review entry requires explicit task or tracker instructions.');
  }
  errors.push(...checkExactTarget(input.target, entry.evidenceRefs));

  if (intent === 'external') {
    if (
      nonEmptyString(entry.instructions) &&
      hasNoGitHubDeliveryDirective(entry.instructions) &&
      mode !== 'advisory_read_only'
    ) {
      errors.push(
        'Formal external review entry contains a no-comment contradiction and must preserve GitHub delivery.',
      );
    }
    if (mode === 'advisory_read_only' && input.completion?.status === 'complete') {
      errors.push('advisory_read_only may not enter review-complete state.');
    }
  } else if (intent !== 'local_cat') {
    errors.push('Review entry provenance is contradictory or insufficient; intent must fail closed.');
  }

  return { ok: errors.length === 0, intent, mode, errors };
}

export function evaluateReviewEntryFixtureScenario(pair, variant, checkReviewEntry) {
  const scenario = isRecord(pair) ? pair[variant] : null;
  const pairId = isRecord(pair) && nonEmptyString(pair.id) ? pair.id : 'unknown';
  if (!isRecord(scenario)) {
    return {
      scenarios: 0,
      intentMismatches: 0,
      entryMismatches: 0,
      failures: [`${pairId}.${variant} is missing.`],
    };
  }

  const result = checkReviewEntry(scenario.input);
  const intentMatches = result.intent === scenario.expectedIntent;
  const entryMatches = result.ok === scenario.expectedOk && result.mode === scenario.expectedMode;
  const failures = [];
  if (!intentMatches) {
    failures.push(`${pairId}.${variant}: expected intent ${scenario.expectedIntent}, received ${result.intent}.`);
  }
  if (!entryMatches) {
    failures.push(
      `${pairId}.${variant}: expected mode=${scenario.expectedMode} ok=${scenario.expectedOk}, received mode=${result.mode} ok=${result.ok}: ${result.errors.join(' ')}`,
    );
  }
  return {
    scenarios: 1,
    intentMismatches: intentMatches ? 0 : 1,
    entryMismatches: entryMatches ? 0 : 1,
    failures,
  };
}
