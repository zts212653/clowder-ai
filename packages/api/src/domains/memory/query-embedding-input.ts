// Qwen's released retrieval configuration assigns this prompt to queries and
// an empty prompt to documents. Apply it at the query boundary, never indexing.
// https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/main/config_sentence_transformers.json
const QWEN3_QUERY_PROMPT =
  'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';

const qwen3Embedding = /^(?:Qwen|mlx-community)\/Qwen3-Embedding-(?:0\.6B|4B|8B)(?:-[\w.-]+)?$/i;

export function queryEmbeddingInput(query: string, modelId: string): string {
  return qwen3Embedding.test(modelId) ? QWEN3_QUERY_PROMPT + query : query;
}
