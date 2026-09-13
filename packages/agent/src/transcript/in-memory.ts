import { randomUUID } from 'node:crypto';
import { estimateTokens } from './types.js';
import type { AppendTranscriptInput, TranscriptItem, TranscriptStore } from './types.js';

/**
 * A transcript store that lives only in process memory.
 *
 * Tests and evals need the exact load/append/count semantics the Postgres
 * store gives students, without a database to set up or tear down. Keeping
 * this a faithful copy of that logic -- not a simplification of it -- is what
 * lets a test written against this store stand in for the real one.
 */
export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly itemsByAgent = new Map<string, TranscriptItem[]>();
  private seq = 0;

  async load(agentId: string): Promise<TranscriptItem[]> {
    const items = this.itemsByAgent.get(agentId) ?? [];
    const compaction = [...items].reverse().find((item) => item.payload.kind === 'compaction');
    // A copy, never the list itself: a caller that loads the history and then
    // appends to it -- which is exactly what a turn does -- would otherwise
    // watch its own writes appear in what it had already read, and no database
    // behaves that way.
    if (!compaction || compaction.payload.kind !== 'compaction') return [...items];

    const coversThroughSeq = compaction.payload.coversThroughSeq;
    return [
      compaction,
      ...items.filter((item) => item.seq > coversThroughSeq && item.payload.kind !== 'compaction'),
    ];
  }

  async append(inputs: AppendTranscriptInput[]): Promise<TranscriptItem[]> {
    const stored = inputs.map((input) => {
      const item: TranscriptItem = {
        id: randomUUID(),
        agentId: input.agentId,
        seq: ++this.seq,
        turnId: input.turnId,
        payload: input.payload,
        ...(input.providerPayload ? { providerPayload: input.providerPayload } : {}),
        tokenEstimate: estimateTokens(input.payload, input.providerPayload),
        createdAt: new Date(),
      };
      const existing = this.itemsByAgent.get(input.agentId) ?? [];
      existing.push(item);
      this.itemsByAgent.set(input.agentId, existing);
      return item;
    });

    return stored.sort((a, b) => a.seq - b.seq);
  }

  async count(agentId: string): Promise<number> {
    return (this.itemsByAgent.get(agentId) ?? []).length;
  }
}
