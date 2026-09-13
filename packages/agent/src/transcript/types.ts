import type { ProviderPayload, ToolCall } from '@contexto/llm';

/**
 * The per-chat transcript the model replays every turn.
 *
 * Storing a tagged union of what actually happened -- rather than pre-shaped
 * provider messages -- lets one record serve two jobs: rendering to whichever
 * wire format the current provider needs, and rendering to a human transcript
 * view. Losing that separation would mean re-deriving one from the other.
 */
export type TranscriptPayload =
  | {
      kind: 'user';
      content: string;
      attachments?: { name: string; body: string }[];
      images?: string[];
    }
  | {
      kind: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      reasoningSummary?: string;
      /** The request this reply answered: what the budget estimate anchors on. */
      usage?: { inputTokens: number; cachedInputTokens: number };
    }
  | {
      kind: 'tool_result';
      toolCallId: string;
      toolName: string;
      content: string;
      truncated?: boolean;
    }
  | { kind: 'compaction'; summary: string; coversThroughSeq: number }
  | { kind: 'tool_results_cleared'; throughSeq: number };

export interface TranscriptItem {
  id: string;
  agentId: string;
  seq: number;
  turnId: string;
  payload: TranscriptPayload;
  providerPayload?: ProviderPayload;
  tokenEstimate: number;
  createdAt: Date;
}

export interface AppendTranscriptInput {
  agentId: string;
  turnId: string;
  payload: TranscriptPayload;
  providerPayload?: ProviderPayload;
}

export interface TranscriptStore {
  /**
   * What the model should see: the latest compaction item first (if any),
   * then every item after the point it covers, oldest first.
   */
  load(agentId: string): Promise<TranscriptItem[]>;
  /** All in one transaction, in order; returns the stored items with their seq. */
  append(items: AppendTranscriptInput[]): Promise<TranscriptItem[]>;
  count(agentId: string): Promise<number>;
}

/** chars / 4: the estimate every provider's tokenizer lands within a third of. */
export function estimateTokens(
  payload: TranscriptPayload,
  providerPayload?: ProviderPayload,
): number {
  const chars =
    JSON.stringify(payload).length + (providerPayload ? JSON.stringify(providerPayload).length : 0);
  return Math.ceil(chars / 4);
}
