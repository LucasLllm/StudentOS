/**
 * The per-chat plan the model maintains across a conversation.
 *
 * A student's goal for a chat rarely fits in one turn, and nothing before this
 * gave the model a place to keep track of it between turns beyond whatever it
 * happened to write in prose. The plan is that place: a short list of steps,
 * one of them in progress at a time, recited back at the end of every turn's
 * context so the model does not lose the thread across a long conversation.
 */

export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  step: string;
  status: PlanStatus;
}

export interface AgentPlan {
  steps: PlanStep[];
  /** The transcript seq of the user item of the turn that last wrote it. */
  updatedAtSeq: number;
}

export interface PlanStore {
  read(agentId: string): Promise<AgentPlan | null>;
  save(agentId: string, plan: AgentPlan): Promise<void>;
}
