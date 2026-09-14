import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The prose parts of the system prompt, as markdown documents.
 *
 * What the agent is told about how to behave used to be string literals inside
 * buildSystemPrompt. That is a poor home for prose: it is hard to read at the
 * width a TypeScript literal allows, it turns a change of voice into a code
 * diff, and it puts the agent's manners in the same file as its tool loop.
 * These are documents, so they live as documents, and rewriting how the agent
 * talks is an edit to one file that a non-programmer can make.
 *
 * The frontmatter follows Anthropic's SKILL.md convention -- a name and a
 * description and nothing else. For the three documents that are skills
 * (see skills/builtin.ts) the description is exactly what the model reads: it
 * says when to load the body, and the body arrives only when the model asks
 * skill_load for it. So a skill's description is a trigger, not a summary.
 *
 * For the rest, the description never reaches the model. It is there for
 * whoever opens the file next.
 *
 * Two things to know before adding a document here. It is read once, at module
 * load, so the process refuses to start rather than quietly serving a turn
 * with half its instructions. And where the body is placed in buildSystemPrompt
 * decides whether it can be cached: these are static, so they belong in the
 * prefix, above anything that changes between turns.
 */

/**
 * Where the .md files sit at runtime.
 *
 * The server apps run tsx against src directly rather than a build output, and
 * deployment is a git checkout, so the documents are always beside this file.
 * If a bundling step is ever added for the server, the .md files have to be
 * copied into it -- a bundler will not follow a readFileSync.
 */
const DOCUMENTS_DIR = fileURLToPath(new URL('.', import.meta.url));

export interface PromptDocument {
  /** Matches the filename. Names the document in errors and tests. */
  name: string;
  /** What the document covers, for the next person to open it. Never sent to the model. */
  description: string;
  /** Everything below the frontmatter. The only part the model sees. */
  body: string;
}

/** Leading `---` block, up to the closing `---` on its own line. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Read one document, or refuse to start.
 *
 * Every failure here throws. The alternative is an agent that boots fine and
 * has silently lost its voice, which nothing would catch until a student
 * noticed the replies had gone strange.
 *
 * `dir` is a seam for tests, which need to feed it documents that are wrong in
 * specific ways without leaving those documents next to the real ones.
 */
export function loadPromptDocument(name: string, dir = DOCUMENTS_DIR): PromptDocument {
  const path = `${dir}${name}.md`;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Prompt document ${name}.md is missing from ${dir}`, { cause });
  }

  const frontmatter = FRONTMATTER.exec(raw);
  if (!frontmatter?.[1]) {
    throw new Error(
      `Prompt document ${name}.md needs a --- frontmatter block with name and description`,
    );
  }

  const fields = new Map<string, string>();
  for (const line of frontmatter[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const declaredName = fields.get('name');
  const description = fields.get('description');
  const body = raw.slice(frontmatter[0].length).trim();

  // A name that has drifted from its filename means one of the two is a lie,
  // and the loader is the only place that can still tell.
  if (declaredName !== name) {
    throw new Error(
      `Prompt document ${name}.md declares name "${declaredName ?? ''}", which is not its filename`,
    );
  }
  if (!description) {
    throw new Error(`Prompt document ${name}.md has no description`);
  }
  if (!body) {
    throw new Error(`Prompt document ${name}.md has frontmatter but no body`);
  }

  return { name, description, body };
}

/**
 * How the agent talks to the student.
 *
 * Always loaded. The behaviour it replaces is the model's default register --
 * headings, bullets and LaTeX -- none of which anything in this product
 * renders, so a student saw the asterisks and the backslashes themselves. If a
 * markdown or maths renderer is ever added to both the web app and Telegram,
 * the formatting sections of this document are what should be revisited.
 */
export const RESPONDING = loadPromptDocument('responding');

/**
 * How to summarise the older part of a long conversation.
 *
 * Read by the compaction call between turns, never by a turn itself: it
 * describes what that call should write about a stretch of conversation a
 * later turn will no longer see.
 */
export const COMPACTION = loadPromptDocument('compaction');

/**
 * What an episode is, when to make one, and how to link it.
 *
 * Loaded by every pass that writes into ContextoVault -- mail import,
 * Classroom import, conversation rollup -- and, on demand, by a turn in which
 * the student has said something worth keeping. One definition rather than one
 * per writer, because three writers with three ideas of what an episode is
 * produce a vault with three shapes in it.
 */
export const VAULT_WRITING = loadPromptDocument('vault-writing');

/**
 * How to write the document describing a student's school life.
 *
 * Read by the pass that runs after a vault is built. Not loaded on a turn --
 * what it produces is, which is why its rules about judgement are the
 * strictest in this directory.
 */
export const USER_DOC = loadPromptDocument('user-doc');

/**
 * How to find things in ContextoVault and what its links mean.
 *
 * The counterpart to VAULT_WRITING and deliberately a separate document: an
 * agent answering a student needs to know how to traverse the graph and when a
 * copy is the wrong source, and none of the rules about creating notes. A
 * skill, loaded on demand: it used to ride on every turn, and most turns are
 * not about the vault.
 */
export const VAULT_READING = loadPromptDocument('vault-reading');

/**
 * When and how to use the student's own browser.
 *
 * A skill, loaded on demand. What stays in the prompt for everyone is the one
 * sentence that has to: the agent CAN get at sites behind a login and must
 * never say otherwise. Everything else about portals, refreshing, browsing and
 * where a sign-in lives is here.
 */
export const BROWSER = loadPromptDocument('browser');

/*
 * The twenty general skills.
 *
 * Each is a skill, loaded on demand, named for the job rather than the
 * artefact: feedback rather than draft-feedback, practice rather than
 * exam-prep. Every description ends by naming the skills it is not, because
 * with this many the "not for" clause is what keeps neighbours apart. Grouped
 * as the catalog groups them, and listed in the prompt in this order.
 */

// Learning: understanding things and getting better at them.
/** Explaining or teaching a concept the student wants to understand. */
export const TUTORING = loadPromptDocument('tutoring');
/** Understanding or digesting one specific source, with notes as the output. */
export const READING = loadPromptDocument('reading');
/** Getting through one specific exercise with them, attempt first. */
export const PROBLEM_SOLVING = loadPromptDocument('problem-solving');
/** Testing themselves: quizzes, flashcards, a study guide, an error log. */
export const PRACTICE = loadPromptDocument('practice');
/** Feedback on anything the student made, against the brief. */
export const FEEDBACK = loadPromptDocument('feedback');
/** How to study rather than what: methods, focus, exam technique. */
export const STUDY_SKILLS = loadPromptDocument('study-skills');

// Making: producing a piece of work.
/** Producing a piece of writing with them, from first idea to final draft. */
export const WRITING = loadPromptDocument('writing');
/** Finding, judging and citing information, from sources actually opened. */
export const RESEARCH = loadPromptDocument('research');
/** Anything shown to an audience: slides, a talk, a poster, a video. */
export const PRESENTING = loadPromptDocument('presenting');
/** Numbers and results: lab data, a survey, a spreadsheet, a graph. */
export const DATA = loadPromptDocument('data');
/** Coming up with ideas: diverge first, judge later. */
export const BRAINSTORMING = loadPromptDocument('brainstorming');

// Organising: the admin side, where every source is visible at once.
/** What is due and when, across Classroom, mail, the portal and the vault. */
export const PLANNING = loadPromptDocument('planning');
/** Where they stand: grades so far, what is missing, what a target needs. */
export const PROGRESS = loadPromptDocument('progress');
/** A message to a person, or the inbox sorted; sent only when told. */
export const COMMUNICATION = loadPromptDocument('communication');
/** How their school works: forms, permissions, policies, procedures. */
export const ADMIN = loadPromptDocument('admin');
/** A project done with other people: division, deadlines, the awkward talk. */
export const GROUP_WORK = loadPromptDocument('group-work');
/** Handing work in: the checklist, the right file, the turn-in, the confirmation. */
export const SUBMITTING = loadPromptDocument('submitting');

// Life: the parts of being a student that are not a course.
/** Applying for anything: requirements, deadlines, essays, references. */
export const APPLICATIONS = loadPromptDocument('applications');
/** Choosing: courses, a major, drop or keep, which offer. */
export const DECISIONS = loadPromptDocument('decisions');
/** When they are not okay: listen first, know the limits, point to real help. */
export const WELLBEING = loadPromptDocument('wellbeing');

/**
 * How one bundle of evidence becomes at most one claim.
 *
 * Read by the proposing half of the interpretation pass. Its most load-bearing
 * paragraph is the one telling the model that declining scores as well as
 * answering: every wrong fact this vault has stored came from a pass that was
 * asked for a name and therefore produced one.
 */
/**
 * How to write the page describing one of a student's classes.
 *
 * Never loaded on a turn -- what it produces is, when a question turns out to
 * be about that subject. Its hardest rule is the one about expiry: a page
 * rewritten when a course changes must not contain anything that is wrong when
 * the week does.
 */
export const CLASS_DOC = loadPromptDocument('class-doc');

/**
 * How to write the page describing one person in a student's school life.
 *
 * The record that outlasts the course. When a class ends everything in it goes
 * -- the room, the work, the mail -- and the teacher does not: they may teach
 * this student again, and in five years this page may be the only thing left
 * saying who taught them Grade 8 science.
 */
export const PERSON_DOC = loadPromptDocument('person-doc');

/**
 * How to research a school on the open web and write down what survives.
 *
 * The only pass in this product that reads anything outside the student's own
 * account, and the only one allowed to search. What it establishes about the
 * academic calendar is read back by the pass that decides which of their
 * classes are current, so its instruction to decline rather than guess a date
 * is load-bearing rather than good manners.
 */
export const SCHOOL_DOC = loadPromptDocument('school-doc');

/**
 * What survives a conversation once it is over.
 *
 * Replaces the per-agent conversation profile, and differs from it in the one
 * way that matters: this page is the student's, not one agent's, so something
 * they said in one conversation is known in the next. Its most load-bearing
 * paragraph is the one forbidding a verdict on them -- a characterisation
 * written down once is read on every future turn and becomes how they are
 * treated.
 */
export const CHATS_DOC = loadPromptDocument('chats-doc');
