import { z } from 'zod';

export interface DecisionQuestionBase {
  name: string;
  instructions: string;
}
export type DecisionQuestion = DecisionQuestionBase &
  (
    | { type: 'predicate' }
    | { type: 'choice'; choices: readonly { value: string; description?: string }[] }
    | { type: 'score'; levels: readonly { label: string; description?: string }[] }
  );
export interface DecisionRequest {
  model: string;
  input: string | readonly Record<string, unknown>[];
  questions: readonly DecisionQuestion[];
}
const probability = z.number().min(0).max(1);
const base = { name: z.string().min(1) };
const answerSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('predicate'), probability }).passthrough(),
  z.object({ ...base, type: z.literal('choice'), choice: z.string(), confidence: probability }).passthrough(),
  z.object({ ...base, type: z.literal('score'), score: z.number().finite(), confidence: probability }).passthrough(),
  z.object({ ...base, type: z.literal('refusal') }).passthrough(),
]);
export const decisionResponseSchema = z
  .object({ model: z.string().min(1), answers: z.array(answerSchema) })
  .passthrough();
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;

export function validateDecisionRequest(request: DecisionRequest): void {
  if (
    !request.model.trim() ||
    request.questions.length < 1 ||
    request.questions.length > 400 ||
    new Set(request.questions.map((q) => q.name)).size !== request.questions.length ||
    request.questions.some(
      (q) =>
        !q.name.trim() ||
        !q.instructions.trim() ||
        (q.type === 'choice' &&
          (q.choices.length < 2 || new Set(q.choices.map((c) => c.value)).size !== q.choices.length)) ||
        (q.type === 'score' && q.levels.length < 2),
    )
  )
    throw new Error('Invalid Decisions request');
}

export function parseDecisionResponse(raw: unknown, request: DecisionRequest): DecisionResponse {
  const parsed = decisionResponseSchema.parse(raw);
  if (
    parsed.answers.length !== request.questions.length ||
    new Set(parsed.answers.map((answer) => answer.name)).size !== parsed.answers.length
  )
    throw new Error('Decisions answers incomplete');
  for (const answer of parsed.answers) {
    const question = request.questions.find((q) => q.name === answer.name);
    if (
      !question ||
      (answer.type !== 'refusal' && answer.type !== question.type) ||
      (answer.type === 'choice' &&
        question.type === 'choice' &&
        !question.choices.some((c) => c.value === answer.choice)) ||
      (answer.type === 'score' &&
        question.type === 'score' &&
        (answer.score < 0 || answer.score > question.levels.length - 1))
    )
      throw new Error('Decisions answer outside requested question');
  }
  return parsed;
}
