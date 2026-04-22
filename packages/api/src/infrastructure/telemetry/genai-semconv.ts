/**
 * F152: GenAI Semantic Convention isolation layer.
 *
 * OTel GenAI Semantic Conventions are still Development-stage.
 * All internal code references these constants; upstream renames
 * only affect this file.
 */

// --- Stable attributes ---
export const GENAI_SYSTEM = 'gen_ai.system';
export const GENAI_MODEL = 'gen_ai.request.model';

// --- Development-stage attributes (may rename) ---
export const GENAI_TOKENS_INPUT = 'gen_ai.usage.input_tokens';
export const GENAI_TOKENS_OUTPUT = 'gen_ai.usage.output_tokens';

// --- Custom Cat Cafe attributes ---
export const AGENT_ID = 'agent.id';
export const OPERATION_NAME = 'operation.name';
export const STATUS = 'status';
export const STREAM_ERROR_PATH = 'cat_cafe.stream_error.path';
export const TRIGGER = 'trigger';

// --- Tool use span attributes ---
export const TOOL_NAME = 'tool.name';
export const TOOL_INPUT_KEYS = 'tool.input_keys';
export const TOOL_CATEGORY = 'tool.category';

// --- Routing decision span attributes ---
export const ROUTING_STRATEGY = 'cat_cafe.routing.strategy';
export const ROUTING_TARGET_CATS = 'cat_cafe.routing.target_cats';
export const ROUTING_INTENT = 'cat_cafe.routing.intent';
