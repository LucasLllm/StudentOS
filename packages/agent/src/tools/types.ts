import type { z } from 'zod';
import type { MemoryStore } from '../memory/types.js';
import type { PlanStore } from '../plan/types.js';
import type { Vault } from '../vault/vault.js';
import type { ScopeGroup } from './google/scopes.js';
import type { AudioTranscriber } from './transcribe.js';
import type { YoutubeMetadataSource, YoutubeTranscriptSource } from './web/youtube.js';

/**
 * Something an agent can do in the world.
 *
 * Tools are declared with a Zod schema so the handler gets a parsed, validated
 * input rather than whatever JSON the model produced. The registry converts the
 * schema to JSON Schema at the provider boundary -- tool authors never write
 * JSON Schema by hand.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Stable identifier. Referenced by skills, so renaming one breaks them. */
  id: string;
  /** Shown to the model. Say WHEN to call it, not just what it does. */
  description: string;
  /**
   * OAuth scopes this tool's API calls actually need.
   *
   * Registration is gated on these, so a student whose school granted only
   * some scopes loses exactly the tools that would have 403'd -- and keeps
   * the rest. Without this, a partial grant either breaks the whole
   * integration or leaves tools that fail every time they are called.
   */
  requiredScopes?: readonly string[];
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export interface ToolContext {
  userId: string;
  agentId: string;
  /**
   * The agent's own history, for looking past the recency window.
   *
   * Optional so a deployment without a store still builds; memory_search
   * reports its absence rather than returning nothing found, which would be
   * indistinguishable from a genuine miss.
   */
  memory?: MemoryStore;
  /**
   * ContextoVault: this student's school, as linked notes.
   *
   * Optional because a student who has not connected anything has no vault,
   * and that is an ordinary state rather than a broken one.
   */
  vault?: Vault;
  /**
   * Present only for tools that need Google APIs, and only once the student has
   * granted the relevant scope group. Undefined means "not connected" -- a tool
   * should return a clear, student-readable message rather than throwing.
   */
  google?: GoogleTokenProvider;
  /**
   * Turns audio into text. Absent when transcription is not configured, which
   * a tool must report rather than treat as a broken file.
   */
  transcriber?: AudioTranscriber;
  /** Looks up YouTube video metadata. Absent when not configured. */
  youtube?: YoutubeMetadataSource;
  /** Fetches YouTube transcripts. Absent when no transcript key is set. */
  youtubeTranscripts?: YoutubeTranscriptSource;
  /**
   * Fetch through a residential IP. Absent when no proxy is configured.
   *
   * For hosts that serve a bot wall to datacenters -- not YouTube-specific,
   * which is why it is a plain fetch rather than a per-site interface.
   */
  residentialFetch?: typeof globalThis.fetch;
  /**
   * The most recent map of a school portal, pushed up by a linked desktop
   * companion. Absent when the student has linked no device -- which a tool
   * must report as "not connected yet", not as an error.
   */
  portals?: PortalSnapshotSource;
  /**
   * Where plan_update reads and writes this agent's plan.
   *
   * Optional so a deployment without one still builds; plan_update reports
   * its absence rather than pretending to save, which the model would have
   * no way to tell from a real save.
   */
  plans?: PlanStore;
  /** The transcript seq of the current turn's user item, for plan_update's stamp. */
  turnSeq?: number;
  signal?: AbortSignal;
}

/** One page of a portal, and the JSON its own front-end fetched to render it. */
export interface PortalPage {
  url: string;
  title: string;
  /** What the page actually says. Present for sites that render on the server. */
  text?: string;
  components: {
    url: string;
    status: number;
    method: string;
    shape: unknown;
    empty: boolean | null;
  }[];
}

export interface PortalSnapshot {
  portalId: string;
  origin: string;
  capturedAt: string;
  /** True when only shapes were captured, so there are no values to read. */
  redacted: boolean;
  /** The portal asked for a sign-in, so this snapshot holds nothing usable. */
  needsLogin?: boolean;
  pages: PortalPage[];
}

/**
 * One thing to do on the page the agent has open.
 *
 * Checked at the tool, where the model's call is parsed, and again on the
 * computer that carries it out; this is only the shape that travels between
 * the two.
 */
export interface BrowserAction {
  action: 'click' | 'type' | 'press' | 'select' | 'scroll' | 'back' | 'look' | 'sign_in';
  /** The number of the element, from the last reading of the page. */
  ref?: number;
  text?: string;
  submit?: boolean;
  key?: string;
  value?: string;
  direction?: 'down' | 'up' | 'top' | 'bottom';
}

export interface PortalSnapshotSource {
  /** Latest snapshot per portal, most recently captured first. */
  latest(userId: string): Promise<PortalSnapshot[]>;
  /**
   * Ask the student's own computer to fetch a site again.
   *
   * Queued, not performed. The sign-in that gets past a login lives on that
   * machine and never leaves it, so nothing here can fetch anything -- it can
   * only leave a note the device picks up.
   */
  requestRefresh(
    userId: string,
    portalId: string,
    agentId?: string,
  ): Promise<{ alreadyPending: boolean; requestId?: string }>;
  /**
   * Wait for a queued refresh to finish.
   *
   * The agent stays on the job rather than promising and stopping. Resolves
   * with what the computer made of it, or with waited:false when the wait ran
   * out -- a shut laptop is a real answer, just not the one hoped for.
   */
  awaitRefresh(
    requestId: string,
    timeoutMs: number,
  ): Promise<{ finished: boolean; outcome?: string | null }>;
  /**
   * Ask the student's computer to open one page and read it back.
   *
   * The same browser that signs into their sites, doing ordinary work. It
   * runs there rather than here because that machine has their sessions and a
   * real browser -- and because they can watch it.
   */
  requestBrowse(userId: string, url: string, agentId?: string): Promise<{ requestId?: string }>;
  /**
   * Ask the student's computer to do one thing on the page it has open.
   *
   * The same browser, the same view the student is watching, one step on: a
   * click, some typing, a choice from a list. What comes back is the page as
   * it stands afterwards, read the way a browse reads it.
   */
  requestAction(
    userId: string,
    action: BrowserAction,
    agentId?: string,
  ): Promise<{ requestId?: string }>;
  /** What a finished request returned, if it returned anything. */
  resultOf(requestId: string): Promise<unknown>;
}

/**
 * Supplies a fresh Google access token, refreshing as needed.
 *
 * This is the seam OAuth plugs into. Nothing in the tool layer knows how tokens
 * are obtained, stored, or refreshed -- it asks for a token and gets one, or
 * gets null when the scope was never granted.
 *
 * TODO(oauth): implement in apps/api over Better Auth's `account` table, which
 * already stores refreshToken and accessTokenExpiresAt.
 */
export interface GoogleTokenProvider {
  /**
   * Derived from ScopeGroup rather than listed, so adding a group cannot
   * leave this signature behind -- 'identity' is excluded because it is
   * granted at sign-in and no tool asks for it.
   */
  getAccessToken(scopeGroup: Exclude<ScopeGroup, 'identity'>): Promise<string | null>;

  /**
   * Whether one specific scope was granted.
   *
   * Registration already gates on required scopes, so this is for tools whose
   * BEHAVIOUR changes with an optional scope rather than their availability --
   * reading one picked file versus searching a whole Drive.
   */
  hasScope(scope: string): boolean;
}

/** Returned when a tool cannot run for a reason the student can act on. */
export interface ToolUnavailable {
  unavailable: true;
  reason: string;
  /**
   * The HTTP status behind it, when there was one.
   *
   * `reason` is written for a student; a caller deciding whether to throw away
   * stored state needs to tell "this token is dead" from "Google wobbled", and
   * only the status and Google's own message say which.
   */
  status?: number;
  /** What the upstream API said, unedited. Not for showing to a student. */
  message?: string;
}

export function unavailable(
  reason: string,
  extra?: { status?: number; message?: string },
): ToolUnavailable {
  return {
    unavailable: true,
    reason,
    ...(extra?.status === undefined ? {} : { status: extra.status }),
    ...(extra?.message === undefined ? {} : { message: extra.message }),
  };
}
