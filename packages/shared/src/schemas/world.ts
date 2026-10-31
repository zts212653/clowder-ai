import { z } from 'zod';

// --- Enums ---

export const WorldStatusSchema = z.enum(['draft', 'active', 'archived']);
export const SceneStatusSchema = z.enum(['draft', 'active', 'completed']);
export const WorldModeSchema = z.enum(['build', 'perform', 'replay']);
export const WorldActorKindSchema = z.enum(['user', 'cat', 'system']);
export const CanonStatusSchema = z.enum(['draft', 'proposed', 'accepted', 'rejected']);

export const WorldEventTypeSchema = z.enum([
  'scene_created',
  'scene_entered',
  'scene_completed',
  'dialogue',
  'narration',
  'character_definition_change',
  'character_state_change',
  'canon_proposed',
  'canon_accepted',
  'canon_rejected',
  'care_check_in',
  'scene_transition',
]);

// --- Actor ---

export const WorldActorRefSchema = z.object({
  kind: WorldActorKindSchema,
  id: z.string().min(1),
  displayName: z.string().optional(),
});

// --- JSON Patch (restricted subset: add/replace/remove) ---

export const JsonPatchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal('replace'), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: z.string() }),
]);

// --- Character sub-slots ---

export const CharacterCoreIdentitySchema = z.object({
  name: z.string().min(1),
  archetype: z.string().optional(),
  description: z.string().min(1),
});

export const CharacterInnerDriveSchema = z.object({
  motivation: z.string().min(1),
  fears: z.array(z.string()).optional(),
  values: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
});

export const RelationshipBondSchema = z.object({
  targetCharacterId: z.string().min(1),
  nature: z.string().min(1),
  tension: z.string().optional(),
  intensity: z.number().min(0).max(100).optional(),
});

export const CharacterRelationshipTensionSchema = z.object({
  bonds: z.array(RelationshipBondSchema),
});

export const CharacterVoiceAndImageSchema = z.object({
  voiceStyle: z.string().optional(),
  visualDescription: z.string().optional(),
  avatarUrl: z.string().optional(),
  signature: z.string().optional(),
});

export const CharacterGrowthStateSchema = z.object({
  currentArc: z.string().optional(),
  milestones: z.array(z.string()).optional(),
  wounds: z.array(z.string()).optional(),
});

export const CharacterMaskOverlaySchema = z.object({
  overlayPersonality: z.string().optional(),
  overlayVoiceStyle: z.string().optional(),
  overlayStrengths: z.array(z.string()).optional(),
  sceneDisplayName: z.string().optional(),
  sceneAvatar: z.string().optional(),
  scenePalette: z.string().optional(),
});

// --- Entity Records ---

export const WorldRecordSchema = z.object({
  worldId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  constitution: z.string().optional(),
  status: WorldStatusSchema,
  threadId: z.string().optional(),
  createdBy: WorldActorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CharacterRecordSchema = z.object({
  characterId: z.string().min(1),
  worldId: z.string().min(1),
  coreIdentity: CharacterCoreIdentitySchema,
  innerDrive: CharacterInnerDriveSchema,
  relationshipTension: CharacterRelationshipTensionSchema,
  voiceAndImage: CharacterVoiceAndImageSchema,
  growthState: CharacterGrowthStateSchema,
  maskOverlay: CharacterMaskOverlaySchema.optional(),
  baseCatId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SceneRecordSchema = z.object({
  sceneId: z.string().min(1),
  worldId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  mode: WorldModeSchema,
  status: SceneStatusSchema,
  activeCharacterIds: z.array(z.string()),
  setting: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- Actions (discriminated union on 'type') ---

const PerformDialogueActionSchema = z.object({
  type: z.literal('perform_dialogue'),
  characterId: z.string().min(1),
  content: z.string().min(1),
});

const NarrateActionSchema = z.object({
  type: z.literal('narrate'),
  content: z.string().min(1),
});

const EditCharacterDefinitionActionSchema = z.object({
  type: z.literal('edit_character_definition'),
  characterId: z.string().min(1),
  slot: z.enum(['coreIdentity', 'innerDrive', 'voiceAndImage']),
  patch: z.array(JsonPatchOperationSchema),
});

const UpdateCharacterStateActionSchema = z.object({
  type: z.literal('update_character_state'),
  characterId: z.string().min(1),
  slot: z.enum(['relationshipTension', 'growthState']),
  patch: z.array(JsonPatchOperationSchema),
});

const ProposeCanonActionSchema = z.object({
  type: z.literal('propose_canon'),
  sourceEventId: z.string().min(1).optional(),
  summary: z.string().min(1),
  category: z.string().optional(),
});

const DecideCanonActionSchema = z.object({
  type: z.literal('decide_canon'),
  recordId: z.string().min(1),
  decision: z.enum(['accepted', 'rejected']),
  reason: z.string().optional(),
});

const TransitionSceneActionSchema = z.object({
  type: z.literal('transition_scene'),
  targetSceneId: z.string().optional(),
  newSceneName: z.string().optional(),
  newSceneDescription: z.string().optional(),
});

const CareCheckInActionSchema = z.object({
  type: z.literal('care_check_in'),
  suggestion: z.string().min(1),
  realityBridge: z.string().min(1),
});

export const WorldActionSchema = z.discriminatedUnion('type', [
  PerformDialogueActionSchema,
  NarrateActionSchema,
  EditCharacterDefinitionActionSchema,
  UpdateCharacterStateActionSchema,
  ProposeCanonActionSchema,
  DecideCanonActionSchema,
  TransitionSceneActionSchema,
  CareCheckInActionSchema,
]);

export const WorldActionEnvelopeSchema = z.object({
  worldId: z.string().min(1),
  sceneId: z.string().min(1),
  actorCatId: z.string().min(1),
  mode: WorldModeSchema,
  actions: z.array(WorldActionSchema).min(1),
  idempotencyKey: z.string().min(1),
});

// --- Canon Promotion ---

export const CanonPromotionRecordSchema = z.object({
  recordId: z.string().min(1),
  worldId: z.string().min(1),
  sceneId: z.string().min(1),
  sourceEventId: z.string().min(1),
  status: CanonStatusSchema,
  summary: z.string().min(1),
  category: z.string().optional(),
  proposedBy: WorldActorRefSchema,
  decidedBy: WorldActorRefSchema.optional(),
  reason: z.string().optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});

// --- Event Log ---

export const WorldEventEntrySchema = z.object({
  eventId: z.string().min(1),
  worldId: z.string().min(1),
  sceneId: z.string().min(1),
  type: WorldEventTypeSchema,
  actor: WorldActorRefSchema,
  characterId: z.string().optional(),
  payload: z.record(z.unknown()),
  canonRecordId: z.string().optional(),
  createdAt: z.string(),
});

// --- Context Envelope ---

export const CanonSummaryEntrySchema = z.object({
  recordId: z.string().min(1),
  summary: z.string().min(1),
  acceptedAt: z.string(),
});

export const CareLoopHintSchema = z.object({
  trigger: z.string().min(1),
  suggestion: z.string().min(1),
  realityBridge: z.string().min(1),
});

export const WorldRecallResultSchema = z.object({
  canonMatches: z.array(
    z.object({
      anchor: z.string(),
      title: z.string(),
      summary: z.string(),
      confidence: z.number(),
    }),
  ),
  eventMatches: z.array(
    z.object({
      eventId: z.string(),
      summary: z.string(),
      createdAt: z.string(),
    }),
  ),
});

export const WorldContextEnvelopeSchema = z.object({
  world: WorldRecordSchema,
  scene: SceneRecordSchema,
  characters: z.array(CharacterRecordSchema),
  recentEvents: z.array(WorldEventEntrySchema),
  relationshipSnapshot: z.array(RelationshipBondSchema),
  canonSummary: z.array(CanonSummaryEntrySchema),
  recall: WorldRecallResultSchema,
  careLoopHint: CareLoopHintSchema.optional(),
});

// --- Inferred types ---

export type WorldStatus = z.infer<typeof WorldStatusSchema>;
export type SceneStatus = z.infer<typeof SceneStatusSchema>;
export type WorldMode = z.infer<typeof WorldModeSchema>;
export type WorldActorKind = z.infer<typeof WorldActorKindSchema>;
export type WorldActorRef = z.infer<typeof WorldActorRefSchema>;
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;
export type CharacterCoreIdentity = z.infer<typeof CharacterCoreIdentitySchema>;
export type CharacterInnerDrive = z.infer<typeof CharacterInnerDriveSchema>;
export type RelationshipBond = z.infer<typeof RelationshipBondSchema>;
export type CharacterRelationshipTension = z.infer<typeof CharacterRelationshipTensionSchema>;
export type CharacterVoiceAndImage = z.infer<typeof CharacterVoiceAndImageSchema>;
export type CharacterGrowthState = z.infer<typeof CharacterGrowthStateSchema>;
export type CharacterMaskOverlay = z.infer<typeof CharacterMaskOverlaySchema>;
export type WorldRecord = z.infer<typeof WorldRecordSchema>;
export type CharacterRecord = z.infer<typeof CharacterRecordSchema>;
export type SceneRecord = z.infer<typeof SceneRecordSchema>;
export type WorldAction = z.infer<typeof WorldActionSchema>;
export type WorldActionEnvelope = z.infer<typeof WorldActionEnvelopeSchema>;
export type CanonStatus = z.infer<typeof CanonStatusSchema>;
export type CanonPromotionRecord = z.infer<typeof CanonPromotionRecordSchema>;
export type WorldEventType = z.infer<typeof WorldEventTypeSchema>;
export type WorldEventEntry = z.infer<typeof WorldEventEntrySchema>;
export type CanonSummaryEntry = z.infer<typeof CanonSummaryEntrySchema>;
export type CareLoopHint = z.infer<typeof CareLoopHintSchema>;
export type WorldRecallResult = z.infer<typeof WorldRecallResultSchema>;
export type WorldContextEnvelope = z.infer<typeof WorldContextEnvelopeSchema>;
