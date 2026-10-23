import type { RuntimeInteractionRequest } from '@cat-cafe/shared';

/** Original request only: never reconstruct private answers or reinstall response controls. */
export function RuntimeInteractionRequestDetails({ request }: { request: RuntimeInteractionRequest }) {
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
                <ul className="list-inside list-disc">
                  {question.options.map((option) => (
                    <li key={option.label}>
                      {option.label}
                      {option.description ? <p>{option.description}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))
        : null}
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
        </>
      ) : null}
    </div>
  );
}
