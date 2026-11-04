import type { FileProfileRepository, ProfileFileSnapshot } from '../../cats/services/profile/ProfileRepository.js';
import type { MemberMemoryReference, MemberSessionScope, MemberSessionServices } from './types.js';

type Scope = MemberSessionScope & { readonly catId: string };
function bounded(snapshot: ProfileFileSnapshot | null): ProfileFileSnapshot | null {
  if (snapshot && Buffer.byteLength(snapshot.content) > 65536) throw new Error('member_session_memory_too_large');
  return snapshot;
}

/** Canonical owner corpus and the catalog-bound relationship only. References
 * are not file paths or permission to search other home/project material. */
export function createMemberProfileMemory(repository: FileProfileRepository) {
  const read = (sourceRef: string, scope: Scope) => {
    if (sourceRef === repository.currentCorpusUri()) return bounded(repository.readCorpus(scope.ownerUserId));
    if (sourceRef === repository.currentRelationshipUri())
      return bounded(repository.readPrimer(repository.scope(scope.ownerUserId, scope.catId)));
    throw new Error('unsupported_member_memory');
  };
  const resolve: MemberSessionServices['resolveMemory'] = async (ref, scope) => {
    await scope.assertCurrent();
    const snapshot = read(ref.sourceRef, scope);
    if (!snapshot) throw new Error('member_session_memory_unavailable');
    if (snapshot.revision !== ref.revision) throw new Error('member_session_memory_changed');
    await scope.assertCurrent();
    return { sourceRef: ref.sourceRef, revision: snapshot.revision, text: snapshot.content };
  };
  return {
    resolve,
    async list(scope: Scope): Promise<readonly MemberMemoryReference[]> {
      await scope.assertCurrent();
      const references = [repository.currentCorpusUri(), repository.currentRelationshipUri()].flatMap((sourceRef) => {
        const snapshot = read(sourceRef, scope);
        return snapshot ? [{ sourceRef, revision: snapshot.revision }] : [];
      });
      await scope.assertCurrent();
      return references;
    },
  };
}
