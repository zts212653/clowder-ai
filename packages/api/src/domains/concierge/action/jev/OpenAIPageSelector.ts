import { createHash, randomUUID } from 'node:crypto';
import { resolveOpenAIPlatformAccount } from '../../../../config/account-resolver.js';
import { resolveActiveProjectRoot } from '../../../../utils/active-project-root.js';
import { createOpenAIPlatformClient } from '../../../services/openai-platform/client.js';
import {
  chooseCurrentAction,
  type createJevPageSelector,
  ownerLiteralValues,
  pageDecisionQuestions,
  validateInput,
} from './JevPageSelector.js';

/** Explicit capability selection; account storage is shared with every other Platform consumer. */
export function readOpenAIPageSelector(
  env: NodeJS.ProcessEnv,
  projectRoot = resolveActiveProjectRoot(),
  onAccountUnavailable?: () => void,
) {
  const provider = env.CAT_CAFE_PAGE_DECISION_PROVIDER?.trim();
  if (provider && provider !== 'openai' && provider !== 'jev') throw new Error('Unknown page decision provider');
  if (provider !== 'openai') return undefined;
  const accountRef = env.OPENAI_PLATFORM_ACCOUNT_REF?.trim() || undefined;
  if (onAccountUnavailable) {
    let available = false;
    try {
      available = Boolean(resolveOpenAIPlatformAccount(projectRoot, accountRef));
    } catch {
      // Availability is diagnostic only; account resolution remains authoritative on every call.
    }
    if (!available) onAccountUnavailable();
  }
  const client = createOpenAIPlatformClient({
    projectRoot,
    accountRef,
  });
  const model = env.OPENAI_DECISIONS_MODEL?.trim() || 'gpt-6-luna';
  const selector: ReturnType<typeof createJevPageSelector> = {
    async select(input) {
      validateInput(input);
      const candidates = input.candidates.map(({ id, label, operation }) => ({ id, label, operation }));
      const values = input.literalValues ?? ownerLiteralValues(input.utterance);
      if (
        values.length > 8 ||
        values.some((value) => !value || value.length > 2_000 || !input.utterance.includes(value))
      )
        throw new Error('Page decision owner literal unavailable');
      const request = {
        model,
        input: JSON.stringify({ ownerRequest: input.utterance, candidates, ownerLiteralValues: values }),
        questions: Object.entries(pageDecisionQuestions(candidates, values)).map(([name, question]) => ({
          name,
          type: 'choice' as const,
          instructions: question.instructions,
          choices: Object.entries(question.criteria).map(([value, description]) => ({
            value,
            description: typeof description === 'string' ? description : JSON.stringify(description),
          })),
        })),
      };
      const start = Date.now();
      const result = await client.decide(request, { signal: input.signal });
      const target = result.answers.find((answer) => answer.name === 'target');
      const value = result.answers.find((answer) => answer.name === 'value');
      if (target?.type !== 'choice' || value?.type !== 'choice') throw new Error('Page decision refused');
      const choice = chooseCurrentAction({ model: result.model, answers: { target, value } }, candidates, values);
      return {
        choice,
        receipt: {
          requestId: randomUUID(),
          providerRequestId: result.providerRequestId,
          requestedModel: model,
          servedModel: result.model,
          provider: 'openai',
          accountRef: result.accountRef,
          inputSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
          candidates,
          choice,
          confidence: target.confidence,
          elapsedMs: Date.now() - start,
        },
      };
    },
  };
  return selector;
}
