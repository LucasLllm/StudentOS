import { z } from 'zod';
import type { PortalPage, PortalSnapshot, Tool } from './types.js';
import { unavailable } from './types.js';
import { untrustedNote } from '../untrusted.js';

export const MAX_CHARS = 14_000;

/**
 * How long to stay with a refresh before giving up on it.
 *
 * Long enough for a computer that is awake to sign in and read a site, short
 * enough that a shut one does not hold the conversation open. Past this the
 * honest answer is that their machine is not there.
 */
export const REFRESH_WAIT_MS = 75_000;

/**
 * Portal content is UNTRUSTED in the same way mail and web pages are.
 *
 * Most of it is written by teachers, which is not the same as safe. An
 * announcement is free text authored by someone other than the student, read
 * by an agent that can also turn work in and send mail.
 */
const UNTRUSTED_NOTE = untrustedNote(
  'Portal content below was written by the school, not by the student.',
);

const readPortalInput = z.object({
  portalId: z
    .string()
    .optional()
    .describe("Which portal, e.g. 'veracross'. Omit to read every connected portal."),
});

/** Trim a snapshot so a large portal cannot crowd out the conversation. */
export function condense(pages: PortalPage[], budget = MAX_CHARS) {
  const kept: unknown[] = [];
  let used = 0;
  let dropped = 0;

  for (const page of pages) {
    const withData = page.components.filter((c) => c.empty !== true && c.shape !== null);
    const text = page.text?.trim();

    /*
     * A page counts if it has JSON or if it has words.
     *
     * Only sites built on an API leave components behind; a server-rendered
     * portal has none, and judging it by components alone threw away every
     * page it had. Both kinds of site have to arrive here intact.
     */
    if (withData.length === 0 && !text) {
      dropped += 1;
      continue;
    }
    const entry = {
      page: page.title || page.url,
      url: page.url,
      ...(text ? { text } : {}),
      ...(withData.length > 0
        ? { data: withData.map((c) => ({ from: c.url, content: c.shape })) }
        : {}),
    };
    const size = JSON.stringify(entry).length;
    if (used + size > budget) {
      dropped += 1;
      continue;
    }
    kept.push(entry);
    used += size;
  }
  return { kept, dropped };
}

/**
 * Read what a linked computer found in the student's school portal.
 *
 * Needs no Google scope: this data did not come from Google. It arrives from
 * the student's own machine, which read the portal using the login they
 * completed themselves.
 */
export const readSchoolPortal: Tool<z.infer<typeof readPortalInput>, unknown> = {
  id: 'portal_read',
  description:
    "Read the student's school portal — Veracross, Mozaik, or similar — for coursework, " +
    'grades, announcements and calendar entries that are NOT in Google Classroom. Use this ' +
    'when the student asks about school information you cannot find in Classroom. The data ' +
    'comes from a snapshot taken by their own computer, so mention how recent it is when it ' +
    'matters.',
  inputSchema: readPortalInput,

  async execute({ portalId }, ctx) {
    if (!ctx.portals) {
      return unavailable(
        'No computer is linked yet, so I cannot see your school portal. You can link one in ' +
          'Settings, under Devices.',
      );
    }

    const snapshots = await ctx.portals.latest(ctx.userId);
    const wanted = portalId ? snapshots.filter((s) => s.portalId === portalId) : snapshots;

    if (wanted.length === 0) {
      return unavailable(
        portalId
          ? `Nothing has been captured from "${portalId}" yet.`
          : 'No portal has been captured yet. Run a sync from the linked computer.',
      );
    }

    return {
      note: UNTRUSTED_NOTE,
      portals: wanted.map((snapshot: PortalSnapshot) => {
        const { kept, dropped } = condense(snapshot.pages);
        return {
          portalId: snapshot.portalId,
          capturedAt: snapshot.capturedAt,
          /*
           * A shapes-only snapshot has had every value stripped, so it can
           * describe the portal's structure but answer no question about the
           * student. Saying so stops the model reporting "string<date>" as a
           * due date.
           */
          ...(snapshot.redacted
            ? {
                warning:
                  'This snapshot recorded only the SHAPE of the portal, not its contents. ' +
                  'You cannot answer questions about actual coursework from it. Tell the ' +
                  'student to re-sync without the shapes-only option.',
              }
            : {}),
          /*
           * An expired session and an out-of-term portal produce identical
           * data -- nothing -- so the distinction has to be carried, not
           * inferred. Told the wrong one, the model sends a student to
           * re-authenticate in August, or tells them in October that term has
           * not started.
           */
          ...(snapshot.needsLogin
            ? {
                warning:
                  'That site asked for a sign-in, so this snapshot holds nothing. Do NOT tell ' +
                  'the student they have no coursework, and do NOT tell them to sign in by hand ' +
                  '-- there is no manual sign-in. Use portal_refresh: their computer has their ' +
                  'saved username and password and will sign in itself. Only if that also comes ' +
                  'back needing a sign-in should they check the saved one in the app, under ' +
                  'Settings, Connections, Sites.',
              }
            : kept.length === 0
              ? {
                  warning:
                    'Every page came back empty, but the sign-in was still valid — so there is ' +
                    'genuinely nothing in the portal yet. Usually the school year has not started.',
                }
              : {}),
          pages: kept,
          ...(dropped > 0 ? { pagesOmitted: dropped } : {}),
        };
      }),
    };
  },
};

const refreshInput = z.object({
  portalId: z.string().describe("Which site, e.g. 'veracross'. Use the id from portal_read."),
});

/**
 * Ask the student's computer to fetch a site again.
 *
 * Worth being precise with the model about what this does, because the shape
 * is unusual: it does not return data. The sign-in that gets past a login
 * lives on the student's own machine, so this leaves a request there and the
 * computer acts on it when it next checks -- within a minute if it is awake,
 * and not at all if it is shut.
 *
 * So the honest thing to tell a student is that fresher data is on its way,
 * while answering now from what is already here.
 */
export const refreshSchoolPortal: Tool<z.infer<typeof refreshInput>, unknown> = {
  id: 'portal_refresh',
  description:
    "Sign in to one of the student's sites and fetch it fresh. You CAN do this: their computer " +
    'holds the username and password they saved, and this makes it sign in and read the site ' +
    'again. Use it whenever they ask you to go and check a site, log in to one, or get up-to-date ' +
    'information, and whenever portal_read comes back empty or says the sign-in expired. ' +
    'It returns the site as it stands right now: it waits for the sign-in and the read to ' +
    'finish, then hands you the pages. By the time you are reading the result the work is done, ' +
    'so answer from it. If their computer is asleep it says so, and that is worth telling them ' +
    'plainly.',
  inputSchema: refreshInput,

  async execute({ portalId }, ctx) {
    if (!ctx.portals) {
      return unavailable(
        'No computer of theirs is linked, so there is nothing that can sign in. Tell them to ' +
          'open the Contexto Agent app and link this computer -- not that you are unable to do it.',
      );
    }

    const { alreadyPending, requestId } = await ctx.portals.requestRefresh(
      ctx.userId,
      portalId,
      // The agent id travels with the request so the browser it opens shows
      // in this conversation and nowhere else.
      ctx.agentId,
    );

    /*
     * Wait for it, rather than promising and stopping.
     *
     * Queuing and returning made the agent answer "that will be ready in a
     * minute" and end its turn, which is not doing the task -- it is
     * describing someone else doing it. The student asked for the
     * information. So this stays on the job until the computer reports back,
     * and only gives up when waiting has genuinely stopped being useful.
     */
    const waited = requestId
      ? await ctx.portals.awaitRefresh(requestId, REFRESH_WAIT_MS)
      : { finished: false };

    if (!waited.finished) {
      return {
        finished: false,
        note:
          `Their computer has not reported back on ${portalId} yet. It is most likely asleep or ` +
          'shut. Tell them plainly that it needs to be awake for you to read that site, and ' +
          'answer now from whatever you already have.',
      };
    }

    if (waited.outcome === 'needs_login') {
      return {
        finished: true,
        signedIn: false,
        note:
          `Their computer tried ${portalId} and the site would not accept the saved sign-in. ` +
          'Say so directly. They can fix it in the Contexto Agent app under Settings, ' +
          'Connections, Sites. Do not tell them to sign in by hand elsewhere -- there is no ' +
          'such thing here.',
      };
    }

    if (waited.outcome !== 'synced') {
      return {
        finished: true,
        signedIn: false,
        note: `Their computer could not read ${portalId} just now. Say so and offer to try again.`,
      };
    }

    /*
     * Hand back the data itself, not a receipt for it.
     *
     * The refresh exists to answer a question. Returning "done, now call
     * portal_read" spends another turn and gives the student a second pause
     * for no reason.
     */
    const snapshots = await ctx.portals.latest(ctx.userId);
    const fresh = snapshots.find((s) => s.portalId === portalId);
    if (!fresh) {
      return { finished: true, note: `Signed in to ${portalId}, but it returned nothing to read.` };
    }

    const { kept, dropped } = condense(fresh.pages);
    return {
      finished: true,
      signedIn: true,
      note:
        UNTRUSTED_NOTE +
        ` This is ${portalId} as it stands right now: you signed in and read it just now. ` +
        'Answer the question from what is here. It has already happened.',
      capturedAt: fresh.capturedAt,
      pages: kept,
      ...(dropped > 0 ? { pagesOmitted: dropped } : {}),
      ...(alreadyPending ? { note2: 'A refresh was already running; this is its result.' } : {}),
    };
  },
};
