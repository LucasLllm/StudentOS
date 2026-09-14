import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS, availableSkills, skillsSection } from './builtin.js';

/**
 * The twenty general skills, in the order the prompt lists them.
 *
 * Grouped as the catalog groups them: learning, making, organising, life.
 * The order is the prompt's order, so it is fixed here rather than left to
 * whatever the registry happens to do.
 */
const GENERAL = [
  'tutoring',
  'reading',
  'problem-solving',
  'practice',
  'feedback',
  'study-skills',
  'writing',
  'research',
  'presenting',
  'data',
  'brainstorming',
  'planning',
  'progress',
  'communication',
  'admin',
  'group-work',
  'submitting',
  'applications',
  'decisions',
  'wellbeing',
];

/**
 * What the prompt says about skills, and which ones a student gets.
 *
 * The block is in the cached prefix, so the property that matters is that it
 * is a pure function of the situation: two students with a vault get the same
 * bytes, and a student without one carries nothing about it.
 */
describe('the built-in skills', () => {
  it('are the browser, the twenty general ones, and the two vault ones', () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual([
      'browser',
      ...GENERAL,
      'vault-reading',
      'vault-writing',
    ]);
  });

  it('offers everything but the vault skills to a student with no vault', () => {
    expect(availableSkills({ hasVault: false }).map((s) => s.name)).toEqual([
      'browser',
      ...GENERAL,
    ]);
  });

  it('offers the vault skills only with a vault', () => {
    expect(availableSkills({ hasVault: true }).map((s) => s.name)).toEqual([
      'browser',
      ...GENERAL,
      'vault-reading',
      'vault-writing',
    ]);
  });

  it('gives every skill a one-line trigger that also says what it is not for', () => {
    // The description is the only thing the model chooses on, and with
    // twenty-three of them the "not for" clause is what keeps neighbours apart.
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.description, skill.name).not.toContain('\n');
      expect(skill.description, skill.name).toMatch(/^Load /);
      expect(skill.description, skill.name).toMatch(/\bNot (for|needed)\b/);
    }
  });

  it('names no skill twice', () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the skills block', () => {
  it('names the tool that loads one', () => {
    expect(skillsSection({ hasVault: true })).toContain('skill_load');
  });

  it('lists each available skill with its trigger, and nothing of its body', () => {
    const block = skillsSection({ hasVault: true });
    for (const skill of BUILTIN_SKILLS) {
      expect(block).toContain(`- ${skill.name}: ${skill.description}`);
      expect(block).not.toContain(skill.body.slice(0, 200));
    }
  });

  it('says nothing about the vault to a student without one', () => {
    const block = skillsSection({ hasVault: false });
    expect(block).not.toContain('vault-reading');
    expect(block).not.toContain('vault-writing');
  });

  it('tells the model a turn none of them covers needs none of them', () => {
    // The other half of the goal. A list of skills with no permission to
    // ignore it reads as "load something".
    expect(skillsSection({ hasVault: true })).toMatch(/needs none of them/i);
  });

  it('says many turns need one rather than most, so it does not contradict "needs none"', () => {
    // "Most turns need one" reads as an expectation to load something on
    // nearly every turn, which fights the sentence right before it that says
    // a question none of them covers needs none of them.
    const block = skillsSection({ hasVault: true });
    expect(block).toMatch(/many turns need one/i);
    expect(block).not.toContain('Most turns need one');
  });

  it('is byte-identical for the same situation', () => {
    expect(skillsSection({ hasVault: true })).toBe(skillsSection({ hasVault: true }));
  });
});
