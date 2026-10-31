import { DeferredPersonMemoryReceiptKeys } from '../RedisDeferredPersonMemoryReceiptStore.js';
import type { HardForgetPersonInput } from './PersonMemoryStore.js';
import { PersonMemoryKeys } from './person-memory-keys.js';

export interface HardForgetKeys {
  fenceKey: string;
  receiptKey: string;
  personKey: string;
  artifactSet: string;
  registeredPersonBindingKey: string;
}

export function hardForgetKeys(input: HardForgetPersonInput): HardForgetKeys {
  return {
    fenceKey: PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
    receiptKey: PersonMemoryKeys.forgetReceipt(input.ownerUserId, input.requestId),
    personKey: PersonMemoryKeys.person(input.ownerUserId, input.personId),
    artifactSet: PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId),
    registeredPersonBindingKey: DeferredPersonMemoryReceiptKeys.binding(
      input.ownerUserId,
      'registered_person',
      input.personId,
    ),
  };
}
