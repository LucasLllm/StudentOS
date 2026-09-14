import {
  ADMIN,
  APPLICATIONS,
  BRAINSTORMING,
  BROWSER,
  COMMUNICATION,
  DATA,
  DECISIONS,
  FEEDBACK,
  GROUP_WORK,
  PLANNING,
  PRACTICE,
  PRESENTING,
  PROBLEM_SOLVING,
  PROGRESS,
  READING,
  RESEARCH,
  STUDY_SKILLS,
  SUBMITTING,
  TUTORING,
  VAULT_READING,
  VAULT_WRITING,
  WELLBEING,
  WRITING,
} from '../prompts/documents.js';
import type { PromptDocument } from '../prompts/documents.js';

/**
 * The skills every agent ships with.
 *
 * Not the Postgres table beside this file. That holds what an agent will one
 * day learn; these are documents in the repo, versioned by git, identical for
 * every student. What the two share is the shape the prompt needs: a name, a
 * line saying when to load it, and a body that is only ever loaded on demand.
 *
 * The prompt carries the first two. The body costs its tokens only on a turn
 * that asked for it -- which is the whole reason a skill is a skill rather
 * than a paragraph of the system prompt.
 */

/** What decides which skills a student has. Extend it before adding a rule. */
export interface SkillSituation {
  hasVault: boolean;
}

export interface BuiltinSkill extends PromptDocument {
  /**
   * Whether this student can use it.
   *
   * A skill about the vault is a lie to a student with no vault: it names
   * tools that answer "not available" and a trigger that can never be right.
   */
  available(situation: SkillSituation): boolean;
}

/**
 * The twenty general skills, in the order the prompt lists them.
 *
 * Universal, every one: each works for a student who has connected nothing,
 * by asking for what it cannot fetch, so none is gated. Gating would buy a
 * shorter block for some students at the price of a prompt that differs by
 * connection, and the block is in the cached prefix.
 */
const GENERAL: readonly PromptDocument[] = [
  // Learning
  TUTORING,
  READING,
  PROBLEM_SOLVING,
  PRACTICE,
  FEEDBACK,
  STUDY_SKILLS,
  // Making
  WRITING,
  RESEARCH,
  PRESENTING,
  DATA,
  BRAINSTORMING,
  // Organising
  PLANNING,
  PROGRESS,
  COMMUNICATION,
  ADMIN,
  GROUP_WORK,
  SUBMITTING,
  // Life
  APPLICATIONS,
  DECISIONS,
  WELLBEING,
];

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  // Universal first, so the block for a student without a vault is a prefix
  // of the block for a student with one.
  { ...BROWSER, available: () => true },
  ...GENERAL.map((skill) => ({ ...skill, available: () => true })),
  { ...VAULT_READING, available: ({ hasVault }) => hasVault },
  { ...VAULT_WRITING, available: ({ hasVault }) => hasVault },
];

export function availableSkills(situation: SkillSituation): BuiltinSkill[] {
  return BUILTIN_SKILLS.filter((skill) => skill.available(situation));
}

/**
 * The block the system prompt carries.
 *
 * A pure function of the situation and nothing else. It sits in the cached
 * prefix, so anything that varied between two students in the same situation
 * would cost every one of them the cache on every turn.
 */
export function skillsSection(situation: SkillSituation): string {
  return (
    'Skills:\n' +
    "Before you do any of the following, call skill_load with the skill's name and follow " +
    'what comes back. Load one only when the turn needs it: a question none of them covers ' +
    'needs none of them, and loading a skill for a question it does not cover is a wasted ' +
    'step the student waits through. Many turns need one; a question none of them covers ' +
    'needs none of them; load a second only when the work genuinely runs into what it ' +
    'covers.\n' +
    availableSkills(situation)
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join('\n')
  );
}
