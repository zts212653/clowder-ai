import type { RuntimeInteractionRecord, RuntimeInteractionRequest } from '@cat-cafe/shared';
import { ReadOnlyChoiceList } from './ReadOnlyChoiceList';

/** Original request only: never reconstruct private answers or reinstall response controls. */
export function RuntimeInteractionRequestDetails({
  request,
  terminal,
}: {
  request: RuntimeInteractionRequest;
  terminal?: RuntimeInteractionRecord['terminal'];
}) {
  const response = terminal?.response;
  return (
    <div className="min-w-0 space-y-3 break-words text-sm">
      <h3 className="font-semibold">{request.title}</h3>
      {request.description ? <p className="whitespace-pre-wrap">{request.description}</p> : null}
      {request.kind === 'question'
        ? request.questions.map((question) => (
            <section key={question.id} className="space-y-1">
              <h4 className="font-semibold">{question.header}</h4>
              <p className="whitespace-pre-wrap">{question.question}</p>
              {!question.isSecret && question.options ? (
                <ReadOnlyChoiceList
                  options={question.options.map((option, index) => ({ ...option, id: String(index) }))}
                  selectedIds={
                    response?.kind === 'answers'
                      ? (response.selectedOptionIndexes?.[question.id] ?? []).map(String)
                      : []
                  }
                />
              ) : null}
            </section>
          ))
        : null}
      {request.kind === 'approval' ? (
        <ReadOnlyChoiceList
          options={request.decisions}
          selectedIds={response?.kind === 'decision' ? [response.decisionId] : []}
        />
      ) : null}
      {request.kind === 'elicitation' ? (
        <>
          <p className="whitespace-pre-wrap">{request.message}</p>
          {request.mode === 'form' ? (
            <dl className="space-y-2">
              {Object.entries(request.requestedSchema.properties).map(([id, property]) => (
                <div key={id}>
                  <dt className="font-semibold">{property.title ?? id}</dt>
                  {property.description ? <dd>{property.description}</dd> : null}
                </div>
              ))}
            </dl>
          ) : (
            <p className="break-all">{request.url}</p>
          )}
          <ReadOnlyChoiceList
            options={request.decisions}
            selectedIds={response?.kind === 'decision' ? [response.decisionId] : []}
          />
        </>
      ) : null}
    </div>
  );
}
