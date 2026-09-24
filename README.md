# Contexto

Students build their own personal AI agents — not agents a school builds for them to consume. The
GUI is non-technical: you describe what you want your agent to do, connect your calendar and
coursework, and it accumulates memory and skills over time rather than starting cold every session.
The design is loosely inspired by Nous Research's Hermes Agent (persistent memory, self-improvement,
skill-building) without the terminal.

Students can bring their own OpenAI or Anthropic API key. Those who don't get a free tier we fund on
a cheap model, with a per-student token allowance.

> Runs at **contextoagent.ai**.

## Status

Working, but unverified against a live database or a real model — everything typechecks and builds,
nothing has run end to end yet.

Built: auth with Google sign-in, agent creation and chat with persistent memory, the BYO-key layer,
and incremental Google authorisation with working Calendar and Classroom tools.

Not built: the skill learning loop, streamed responses, lecture transcription, the Mac shell. Each
carries a `TODO` explaining what still has to be decided.

## Stack

|                        |                 | Why                                                                                       |
| ---------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| **pnpm**               | package manager | Workspaces, plus strict `node_modules` that catches phantom dependencies                  |
| **Vite + React**       | `apps/web`      | A plain SPA — not Next.js — so the same bundle can be wrapped in a desktop shell later    |
| **Hono**               | `apps/api`      | Small, TS-first; `hono/client` gives the web app a typed API client with no codegen       |
| **Postgres + Drizzle** | `packages/db`   | SQL-first, no engine binary, and `pgvector` is available if memory ever needs it          |
| **Better Auth**        | auth            | Self-hosted into our own Postgres, and issues bearer tokens (which the Mac app will need) |

## Layout

```
apps/
  web       Vite + React SPA
  api       Hono server, Better Auth, route definitions
  worker    background jobs (memory summarisation)
packages/
  shared    zod schemas + types shared with the browser
  db        Drizzle schema and migrations
  llm       BYO keys, encryption, provider resolution, quota
  agent     memory, skills, tool calling
```

## Running locally

Requires Node 22+, pnpm, and Docker (for Postgres).

```bash
corepack enable pnpm
pnpm install

cp .env.example .env
openssl rand -base64 32   # -> AUTH_SECRET
openssl rand -base64 32   # -> MASTER_ENCRYPTION_KEY
# then add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (see .env.example)

pnpm db:up                # start Postgres
pnpm db:generate          # generate the initial migration
pnpm db:migrate           # apply it

pnpm dev                  # api on :3000, web on :5173
```

`pnpm -w run typecheck`, `lint`, `format`, `test` — CI runs all of these on push.

### Tests

```bash
createdb contexto_test          # or: docker exec contexto-postgres createdb -U studentos contexto_test
pnpm -w run test
```

Integration tests run against a real Postgres, not a mock. Everything worth testing in them _is_
database behaviour — foreign keys, unique constraints, and queries scoped by user id — and a mocked
query builder would happily pass a cross-user access test that the real database would too.

The suite is weighted toward the places a silent bug would be expensive rather than toward coverage:
AES-GCM round-tripping and IV uniqueness, quota cost arithmetic, partial-scope detection, Telegram
group-chat rejection, and cross-user isolation on every agent route. That last group is verified by
mutation — deleting the `userId` scoping from the ownership query fails exactly those four tests and
nothing else.

## Two things that will bite you

**Google Classroom is gated by school admins, and so is sign-in.** Any Google Workspace for Education
user designated as **under 18** is blocked from _any_ third-party app their admin hasn't configured —
not just from Classroom data, but from Sign in with Google entirely. They see a "request access"
prompt and get `access_not_configured` or `admin_policy_enforced`. This does not reproduce when you
test with a personal Gmail account.

Consequences: for high-school students on school accounts, a school agreement is a **prerequisite**,
not a growth channel. University students on personal accounts are generally fine, which is why v1
targets university first. The full write-up is in
`packages/agent/src/tools/google/scopes.ts` — read it before building the Classroom integration.

**Losing `MASTER_ENCRYPTION_KEY` is unrecoverable.** Every stored student API key becomes permanently
undecryptable. Back it up somewhere other than the droplet.

## Messaging gateway

Students can message their agent from Telegram and get an answer whether or not the web app is
open. A Telegram turn is the same `runAgentTurn` as a browser turn — same tools, same quota, same
transcript — so a conversation started on a phone continues on a laptop.

`packages/channels` owns a `Channel` interface; Discord, SMS, and WhatsApp become adapters without
the agent layer learning a message arrived from somewhere new.

Reactive only. The agent never messages first — see the design note in
`docs/specs/2026-08-13-telegram-gateway.md` for why proactive polling costs roughly 7× reactive to
mostly conclude there is nothing to do, and why the eventual answer is event-driven.

### Setting it up

Optional. Leave both variables unset and the gateway disables itself — the route 404s and the
Settings panel hides.

Add to `.env`:

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
```

1. Message `@BotFather` → `/newbot` → copy the token.
2. `openssl rand -hex 32` for the webhook secret. It's required whenever the token is set — the API
   refuses to boot otherwise, because a webhook without it is a public unauthenticated endpoint that
   runs agent turns.
3. Register the webhook. Needs a **public HTTPS URL**, so either deploy first or use a tunnel:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://YOUR_DOMAIN/api/channels/telegram/webhook",
       "secret_token":"YOUR_WEBHOOK_SECRET",
       "allowed_updates":["message"]}'
```

Then Settings → Telegram → pick an agent → send the bot `/link CODE`.

Linking is code-based on purpose. The webhook is public and anyone can message the bot, so identity
is proven by a short-lived code visible only inside an authenticated session — never inferred from a
username or phone number. Unlinked senders get instructions for `/start` and `/link` and are ignored
otherwise, so no agent and no inference spend is reachable without proving account ownership.

## BYO-LLM layer

`packages/llm` is isolated so that who pays for inference is one decision in one place.

- Providers implement a single `LlmProvider` interface. Call sites only ever touch `LlmRegistry`.
  Adding a hosted, school-funded, or self-hosted tier is a new class plus a registry rule — no call
  site changes.
- Student keys are encrypted with AES-256-GCM before storage. The master key comes from a
  `MasterKeyProvider`; today that reads an env var, and swapping in a KMS means one new
  implementation. `key_version` on each row makes rotation incremental. The upgrade path to envelope
  encryption is documented in `packages/llm/src/crypto/master-key.ts`.
- Plaintext keys are returned by exactly one function and never reach a response body or a log.
- The platform tier is metered and quota-gated; BYOK is metered but never gated, since the student is
  paying the provider directly.

The platform model is one constant: `PLATFORM_MODEL` in `packages/llm/src/config.ts`. It's currently
GPT-6 Luna ($0.10 / $0.50 per million tokens, 1.05M context). Cached-prefix tokens are metered
separately because prompt caching, not model choice, is the main lever on what the free tier costs.

## Agent core

- **Memory** — an append-only episodic table plus periodic summaries. No vector store: recency plus
  summaries is genuinely sufficient at this scale, and if it stops being, `pgvector` is a migration
  in the database we already run, behind the existing `MemoryStore` interface.
- **Skills** — versioned, named, editable procedures with `origin: 'builtin' | 'learned'`. Storage is
  ready; the learning loop is not built. The open questions (what earns promotion, how a stale skill
  gets revised, how skills are forgotten) are in `packages/agent/src/skills/registry.ts`. Three
  built-in skills -- reading the vault, writing to it, and using the student's browser -- ship as
  prompt documents in `packages/agent/src/prompts/`; the prompt names each with a one-line trigger
  and the agent loads the body through `skill_load` when a turn needs it.
- **Tools** — Zod-schema'd, converted to JSON Schema at the provider boundary. Calendar and Classroom
  are stubs behind a `GoogleTokenProvider` seam.

## Roadmap

- **Streamed responses** — a turn is currently a spinner until it completes. Needs the OpenAI adapter
  to reassemble fragmented tool-call deltas; it is a provider-layer fix, not a route-layer one.
- **Skill learning loop** — the Hermes-style bet, and its own design problem.
- **`packages/transcription`** — lecture capture: voice-to-transcript with speaker diarisation,
  contextualised against the student's calendar and coursework rather than standalone. Needs a
  deliberate vendor decision (self-hosted Whisper vs. a paid diarisation API) that hasn't been made.
- **`apps/desktop`** — Mac app. The SPA build and bearer-token auth already accommodate it; it needs
  an Electron shell, an OAuth deep-link handler, and an Apple Developer account for notarisation.

## Deployment

Target is a DigitalOcean droplet: Postgres, the API, and the worker as systemd units, with the web
build served statically. A stable public HTTPS origin is required — Google OAuth redirect URIs and
(later) Calendar push notifications both need one, which is why this doesn't run from a home Mac Mini.

The Mac Mini is reserved for self-hosted Whisper when transcription lands.
