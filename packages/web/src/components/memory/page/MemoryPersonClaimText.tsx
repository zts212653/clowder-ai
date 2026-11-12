import { type PersonClaim, personClaimText } from './people-types';

export function MemoryPersonClaimText({ claim }: { claim: PersonClaim }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm">{personClaimText(claim.payload, claim.approvedText)}</p>
  );
}

export function MemoryPersonClaimTechnicalDetails({ claim }: { claim: PersonClaim }) {
  if (claim.payload.kind === 'redacted') return null;
  return (
    <details className="text-xs text-cafe-muted">
      <summary className="cursor-pointer">技术详情</summary>
      <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words">
        {JSON.stringify(claim.payload, null, 2)}
      </pre>
    </details>
  );
}
