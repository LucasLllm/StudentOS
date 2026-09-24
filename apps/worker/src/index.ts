/**
 * Background jobs.
 *
 * Runs as a separate process from the API because these are long, periodic, and
 * must not compete with request latency. On the droplet this is a second
 * systemd unit pointed at the same database.
 *
 * Currently registers one job and does nothing useful -- the summariser it
 * calls is a skeleton. It exists now so that when memory summarisation becomes
 * real there is somewhere obvious to put it.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inArray, eq } from 'drizzle-orm';
import { agents, createDatabase, projects } from '@contexto/db';
import { CredentialVault, EnvMasterKeyProvider, LlmRegistry, QuotaService } from '@contexto/llm';
import {
  PostgresMemoryStore,
  PostgresProfileStore,
  Vault,
  importConversation,
  collectExchanges,
  updateChatsDoc,
  updateProjectMemory,
  writeUserDoc,
} from '@contexto/agent';
import { groupByStudent } from './grouping.js';

/**
 * Everything the jobs share, built once.
 *
 * Deliberately not imported from apps/api: the worker is a separate process
 * with a separate lifetime, and reaching into another app's context would tie
 * a background job's startup to an HTTP server's.
 */
function loadDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function buildContext() {
  loadDotEnv();

  const url = process.env.DATABASE_URL;
  const masterKeyValue = process.env.MASTER_ENCRYPTION_KEY;
  if (!url || !masterKeyValue) {
    throw new Error('Worker needs DATABASE_URL and MASTER_ENCRYPTION_KEY');
  }

  const db = createDatabase({ url });
  const vault = new CredentialVault(db, new EnvMasterKeyProvider(masterKeyValue));
  const quotaCap = process.env.PLATFORM_MONTHLY_TOKEN_QUOTA;
  const quota = new QuotaService(db, quotaCap ? Number(quotaCap) : undefined);

  return {
    db,
    // Absent when the deployment has no vaults, in which case conversations
    // simply are not recorded there and nothing else changes.
    vaultRoot: process.env.VAULT_ROOT,
    memory: new PostgresMemoryStore(db),
    profiles: new PostgresProfileStore(db),
    llm: new LlmRegistry({
      vault,
      quota,
      ...(process.env.PLATFORM_OPENAI_API_KEY
        ? { platformApiKey: process.env.PLATFORM_OPENAI_API_KEY }
        : {}),
    }),
  };
}

let shared: ReturnType<typeof buildContext> | undefined;
function context(): ReturnType<typeof buildContext> {
  shared ??= buildContext();
  return shared;
}

const MINUTE = 60_000;

/**
 * Agents per pass.
 *
 * A query returning every agent works right up until it very suddenly does
 * not, and a pass that runs long holds a model call open per agent.
 */
const BATCH_SIZE = 50;

/**
 * How long an agent must have been silent before its profile is rewritten.
 *
 * The profile sits in the cached part of the system prompt, so a rewrite
 * between one turn and the next costs that conversation its cache for every
 * remaining turn. Fifteen minutes is comfortably longer than a pause for
 * thought and comfortably shorter than the hourly cadence, so an ordinary
 * conversation is written up on the next wake rather than the one after.
 */
const QUIET_FOR = 15 * MINUTE;

interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

const jobs: Job[] = [
  {
    name: 'chats-page',
    // Hourly is a guess. The right cadence depends on how fast episodic memory
    // actually accumulates, which you will not know until real students use it.
    intervalMs: 60 * MINUTE,
    async run() {
      const ctx = context();
      const stale = await ctx.profiles.stale(BATCH_SIZE, QUIET_FOR);
      if (stale.length === 0) return;

      // Grouped by student, because the page is theirs. See groupByStudent.
      const byStudent = groupByStudent(stale);

      let changed = 0;
      let recorded = 0;
      for (const [userId, agentIds] of byStudent) {
        try {
          /*
           * Billed to the agent's owner, not to a shared key.
           *
           * The registry resolves per user, so a student on their own API key
           * pays for their own summarisation and a platform-tier student is
           * metered against their own quota. On a shared key this cost is
           * invisible until it is the largest line on the bill.
           */
          const llm = await ctx.llm.resolve(userId);

          const bursts = [];
          for (const agentId of agentIds) {
            bursts.push({
              agentId,
              ...(await collectExchanges(
                { memory: ctx.memory, profiles: ctx.profiles },
                { agentId, userId },
              )),
            });
          }

          /*
           * Project chats are written up into their project, not the student's
           * pages. What was settled in a project belongs to it; carrying it into
           * the page every ordinary chat reads would undo what keeping projects
           * apart is for. They are taken out of every write below.
           */
          const inProject = await projectsOf(
            ctx.db,
            bursts.map((burst) => burst.agentId),
          );
          /*
           * On its own, so a project whose memory cannot be written this pass
           * costs only that project. The watermarks above have already moved:
           * letting this throw would skip every ordinary write below for this
           * student and lose those exchanges for good.
           */
          try {
            await writeProjectMemories(
              ctx.db,
              llm,
              userId,
              bursts.filter((burst) => inProject.has(burst.agentId)),
              inProject,
            );
          } catch (error) {
            console.error(`Project memory update failed for student ${userId}`, error);
          }
          const ordinary = bursts.filter((burst) => !inProject.has(burst.agentId));

          const exchanges = ordinary.flatMap((burst) => burst.exchanges);
          if (exchanges.length === 0) continue;

          if (ctx.vaultRoot) {
            const vault = new Vault(ctx.vaultRoot, userId);
            const knownBefore = ordinary
              .map((burst) => burst.knownBefore)
              .filter((known): known is string => known !== undefined);

            const written = await updateChatsDoc(
              { llm },
              { vault, exchanges, userId, ...(knownBefore.length > 0 ? { knownBefore } : {}) },
            );

            if (written.changed) {
              changed += 1;
              /*
               * And the page that describes them, because it is written from
               * this one.
               *
               * Otherwise something a student said this morning waits for the
               * six-hourly vault build to reach the page the agent actually
               * carries. Only when the chats page moved, which is the unusual
               * case -- most conversations teach nothing durable.
               *
               * Safe here and nowhere else: this job runs only once a student
               * has been quiet, so the page it rewrites is not the one being
               * read mid-conversation. Rewriting it during one would change the
               * system prompt under a live turn and cost the whole cached
               * prefix for the rest of that conversation.
               */
              await writeUserDoc({ llm }, { vault, userId });
            }
          }

          /*
           * The same burst, written into the vault as an episode.
           *
           * A conversation is not a row anywhere -- it is the exchanges
           * between one quiet period and the next, which the profile pass has
           * already worked out. Recording it here puts the student's own words
           * on the same timeline as their school, which is the only reason the
           * vault holds more than one source.
           *
           * Only for a vault that already exists: an agent whose student has
           * imported nothing gets a profile and no episodes, rather than a
           * vault containing conversations and no school.
           */
          if (ctx.vaultRoot) {
            const vault = new Vault(ctx.vaultRoot, userId);
            if (await vault.has()) {
              for (const burst of ordinary) {
                if (burst.exchanges.length === 0 || !burst.newestId) continue;
                const written = await importConversation(
                  { llm },
                  {
                    vault,
                    exchanges: burst.exchanges,
                    conversationId: burst.newestId,
                    occurred: burst.occurred ?? new Date().toISOString(),
                    userId,
                    agentId: burst.agentId,
                  },
                );
                recorded += written.written;
              }
            }
          }
        } catch (error) {
          // One student's expired key must not stop every other student's
          // memory from being written.
          console.error(`Chats page update failed for student ${userId}`, error);
        }
      }

      console.log(
        `Chats: ${stale.length} agents checked across ${byStudent.size} students, ` +
          `${changed} pages rewritten, ${recorded} conversations recorded`,
      );
    },
  },
];

type Db = ReturnType<typeof buildContext>['db'];

/** Which of these chats belong to a project, and to which. */
async function projectsOf(db: Db, agentIds: string[]): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({ id: agents.id, projectId: agents.projectId })
    .from(agents)
    .where(inArray(agents.id, agentIds));
  return new Map(rows.flatMap((row) => (row.projectId ? [[row.id, row.projectId] as const] : [])));
}

/**
 * Fold what project chats settled into each project's memory.
 *
 * Once per project per pass, with every quiet chat of that project together,
 * so two chats that went quiet in the same hour cost one call rather than two.
 * Only between conversations: the memory is read into a chat's frozen block
 * when it starts, and a chat already open keeps the one it was given.
 */
async function writeProjectMemories(
  db: Db,
  llm: Parameters<typeof updateProjectMemory>[0]['llm'],
  userId: string,
  bursts: { agentId: string; exchanges: string[] }[],
  inProject: Map<string, string>,
): Promise<void> {
  const byProject = new Map<string, string[]>();
  for (const burst of bursts) {
    const projectId = inProject.get(burst.agentId);
    if (!projectId || burst.exchanges.length === 0) continue;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), ...burst.exchanges]);
  }

  for (const [projectId, exchanges] of byProject) {
    try {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project || project.userId !== userId) continue;
      const memory = await updateProjectMemory(
        { llm },
        {
          name: project.name,
          instructions: project.instructions,
          memory: project.memory,
          exchanges,
          userId,
        },
      );
      if (memory !== null) {
        await db
          .update(projects)
          .set({ memory, memoryUpdatedAt: new Date() })
          .where(eq(projects.id, projectId));
      }
    } catch (error) {
      console.error(`Project memory update failed for project ${projectId}`, error);
    }
  }
}

async function runJob(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (error) {
    // Never let one job's failure kill the process -- the others still need
    // to run, and a crash loop on the droplet is silent until someone looks.
    console.error(`Job "${job.name}" failed`, error);
  }
}

function start(): void {
  console.log(`Worker started with ${jobs.length} job(s)`);

  for (const job of jobs) {
    void runJob(job);
    setInterval(() => void runJob(job), job.intervalMs);
  }
}

start();
