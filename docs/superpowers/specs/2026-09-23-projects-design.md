# Projects: chats that share a context

## The problem

Every chat starts from the same place: the student, their vault, and nothing about the piece of work they are in the middle of. A student writing a CAS proposal across a week of chats re-explains the proposal, re-attaches the same three documents and re-states the same goal in each one. Chats cannot build on each other, and the documents a piece of work depends on have no home.

ChatGPT and Claude both answer this with Projects: a folder of chats that share instructions, files and, lately, memory. This is that feature, with one thing neither does: the agent gathers the project's context itself, from the vault, Drive and Gmail, instead of waiting for the student to upload it.

## What the others do

- **Claude** loads all project knowledge into context while it fits, and past an unpublished threshold (reported around 73K tokens) switches to RAG, a `project_knowledge_search` tool. Users report fragmentary answers in RAG mode: the model sees chunks and nothing tells it what else exists. Project memory is a separate summary per project. The name and description are never shown to the model.
- **ChatGPT** retrieves over project files (hybrid keyword and embedding search, 800-token chunks in the API equivalent). Project-only memory lets chats in a project reference each other and nothing outside it. Drive added to a project is searched live, not synced.
- Neither gathers sources on its own.

## Decisions

1. **A project is a row, and a project chat is an ordinary chat with a `projectId`.** Everything a chat already does (transcript, compaction, plan, tools, attachments) works unchanged inside a project. Project chats are left out of the sidebar's chat list and listed on the project page instead.
2. **The goal is the instructions.** "What's the goal?" at creation is stored as `projects.instructions` and given to the model, editable later. Unlike Claude, which hides the description, what a student writes about their project is exactly what the agent needs.
3. **Context is a set of vault notes, isolated to the project.** A `project_sources` row points at a vault note. Material brought in through the project (upload, a Drive file picked, text typed in) is written by the existing parsers under `projects/<projectId>/` in the vault and is _owned_: it is deleted with the project, and the ordinary `vault_search` and `vault_open` never see that folder, so normal chats never see project material. Notes from the wider vault are _linked_, not copied: one row, no duplication, and removing one from Context deletes only the row.
4. **The agent adds to Context itself, and nothing marks it.** At creation a background sweep gathers what is relevant; during chats the agent adds what it uses. Items look the same however they arrived, and every one can be removed.
5. **Hybrid context, chosen by tokens.** Small projects carry their Context in full, cached; large ones carry a manifest and read on demand. Detail below.
6. **The project block is frozen per chat.** The Responses API caches the system prompt as a whole blob: one changed byte drops `cached_tokens` to zero (see `buildTurnContext`). So the project block is rendered once when a chat starts, stored on the chat, and replayed byte-for-byte. What changes during the chat rides in `<turn_context>`.
7. **Project memory is per project.** Project chats feed a rolling project memory and do not feed the global writers (`chats.md`, the page about the student), so nothing learned in a project leaks into ordinary chats.

## Data

New file `packages/db/src/schema/projects.ts`, exported from `schema/index.ts`, one migration.

**`projects`**: `id` uuid, `userId` (fk `user.id`, cascade), `name`, `instructions` text default `''`, `memory` text default `''`, `memoryUpdatedAt` nullable, `gatheredAt` nullable (when the creation sweep finished, null while it runs), `createdAt`, `updatedAt`. Index on `userId`.

**`agents`** gains `projectId` uuid nullable (fk `projects.id`, cascade) and `projectContext` text nullable, the frozen project block for that chat.

**`project_sources`**: `id`, `projectId` (fk, cascade), `noteName` (vault note slug, including the `projects/<id>/` prefix for owned notes), `owned` boolean, `kind` (`document | pdf | image | text | drive | email`), `tokens` integer, `addedAt`. Unique on (`projectId`, `noteName`).

Deleting a project cascades its chats and source rows, and removes `projects/<id>/` from the vault. Linked notes elsewhere in the vault are untouched.

## API

`apps/api/src/routes/projects.ts`, mounted beside `agents`, schemas in `packages/shared/src/project.ts`. Every route checks the project belongs to the session user; an unknown or foreign id is a 404.

- `GET /projects`: name, updatedAt; newest first.
- `POST /projects` `{ name, instructions }`: creates it and starts the sweep without awaiting it.
- `GET /projects/:id`, `PATCH /projects/:id` `{ name?, instructions? }`, `DELETE /projects/:id`.
- `GET /projects/:id/chats`: title, last message preview, updatedAt.
- `GET /projects/:id/sources`: name, kind, description, preview (first ~400 characters of text, or the image URL), addedAt.
- `POST /projects/:id/sources/upload` (multipart), `/text` `{ title, body }`, `/drive` `{ fileId }`: ingest as owned notes.
- `DELETE /projects/:id/sources/:sourceId`: removes the row; for an owned note, the note too.
- `GET /projects/:id/sources/:sourceId`: full text for the viewer.
- `POST /agents` accepts an optional `projectId`.

`updatedAt` on a project is bumped by any change to it, its sources or its chats.

## What the model sees

### The project block

Rendered by one pure function, `renderProjectBlock(project, sources, notes)`, when a project chat is created, and stored in `agents.projectContext`. It goes into tier 2 of `buildSystemPrompt`, after the universal tier and after `purpose`:

1. The project name and instructions.
2. The project memory, if any (capped at ~1.5K tokens).
3. The manifest: one line per Context item, `name (kind): description`, about 30 tokens each.
4. If the Context totals **20K tokens or less** (sum of `project_sources.tokens`), the full text of every item, each under its name. Above that, a line saying Context is large and to use `project_search` and `project_open`.

The block is re-rendered only when the transcript is compacted, because the cache is lost at that point anyway. A small project costs roughly 5–25K cached tokens a turn, a tenth of the uncached price after the first turn. A large one costs about 3K whatever its size, plus what the agent chooses to open.

Why a manifest in both modes: the failure users report with Claude's RAG mode is the model reasoning from fragments with no idea what else exists. With every item named and described, the model opens the whole document it needs instead of guessing from a chunk.

### What changed since the chat started

`buildTurnContext` gets a project section when the Context differs from the frozen block: "Added to Context since this chat started: `name (kind): description`" and "Removed from Context: `name`". A source added in one chat is visible at once in another open chat, and neither chat's cache breaks.

### Tools

Registered only for project chats, in `packages/agent/src/tools/project.ts`:

- **`project_search(query)`**: the existing term-match ranking (`rankByTermMatches`) over this project's notes only; returns passages with note names.
- **`project_open(name, part?)`**: a note's full text. Notes over ~4K tokens come in numbered parts, and the result says how many there are. Refuses a note not in this project's Context.
- **`project_add(ref)`**: `ref` is a vault note name, a Drive file id or a Gmail message id. A vault note is linked; a Drive file or a message not yet in the vault is imported through the existing collectors into `projects/<id>/` and owned. Returns what was added. Idempotent.

`vault_search`, `vault_open`, the Drive and the Gmail tools stay available in project chats, so the agent can look outside the project. A short prompt section, present only in project chats, says: this chat belongs to a project; its Context is below; when you use something from outside the project that the project will need again, add it with `project_add`. Adding is an explicit call so that what the agent merely glanced at does not accumulate.

### The creation sweep

Runs after `POST /projects` returns, in the API process, and sets `gatheredAt` when done (success or failure):

1. One low-effort call turns the name and instructions into 3–5 search queries.
2. Each query runs against the vault (term match), Gmail search, and Drive (whatever the student's scopes allow).
3. One low-effort call, given titles and short snippets only, picks up to 8 items that belong to the project.
4. Each is added exactly as `project_add` would.

Two small calls in total. A failed call ends the sweep with whatever was added; it never fails project creation. With nothing connected and an empty vault, it adds nothing.

### Project memory

When a project chat goes idle, the existing memory job, instead of feeding `chats.md` and the page about the student, makes one medium-effort call that merges the new exchanges into `projects.memory`: decisions, facts, preferences, what is done and what is not, rewritten whole and capped at ~1.5K tokens. The next chat in the project starts with it.

## Screens

All in the existing CSS variables in `index.css`, inline SVG icons, both themes, phone width.

- **Sidebar**: a "Projects" row with a folder icon under "New". Project chats are not in the chat list.
- **Routes**: `{ name: 'projects' }` at `/projects`, `{ name: 'project'; projectId }` at `/projects/:id`. A project chat keeps `/chats/:id` and shows "← project name" above the conversation.
- **Projects list**: "Projects" heading; a search field (filters by name, client side) and a New button on the right; a Name / Modified table with a folder icon per row and "Today", "Yesterday" or a date. An empty state with a create button.
- **New project modal**: "New project"; "Project name" and "What's the goal?"; Cancel and Create. Create opens the project page.
- **Project page**: "← Projects"; folder icon and name; a "…" menu with Rename, Edit goal and Delete (confirmed). The chat composer, extracted from the chat screen and shared rather than copied, with placeholder "New chat in <name>" and the same `+` attach menu; sending creates a project chat and opens it. Tabs **Chats** and **Context**.
  - **Chats**: title, one-line preview of the last message, date; newest first.
  - **Context**: "+ Add context"; a grid of preview cards (image thumbnail, or a miniature page of the note's first lines, with name and "PDF · Sep 7"); Newest/Oldest sort and a kind filter (All, Documents, Images, Email). A card opens a read-only viewer; hover or long-press shows Remove. While `gatheredAt` is null, a "Gathering context…" row sits at the top and the tab polls.
- **Add context modal**: a drop zone, then three tiles: Upload, Google Drive (the existing Picker wrapper, `lib/picker.ts`) and Text (title and body). A card shows "Processing…" until the parser returns.

## Testing

- Unit: router parse/print round trip for the new routes; `renderProjectBlock` (the 20K boundary, the manifest, byte-identical output for the same input); the turn-context diff; the three tools, including `project_open` refusing a note outside the project; the sweep with failing model calls.
- Integration against Postgres: the projects and sources routes, cascade on delete, another user's project is a 404, `POST /agents` with a `projectId` the user does not own is rejected.
- Isolation: an ordinary chat's `vault_search` never returns a note under `projects/`; a project chat's exchanges do not reach `chats.md`.
- React: sidebar row, list and search, the modal, the tabs, the Context grid and Remove.

## What stays

The three-tier system prompt and the volatile turn context; the transcript, compaction and plan; the upload parsers and vault; the per-student vault page; every existing tool.

## Out of scope

Sharing projects with other students; moving an existing chat into a project; Slack and "add from library"; embeddings and semantic search (the manifest makes keyword search plus whole-document reads enough to start; the embedding column already planned in `memory/store.ts` is the upgrade); re-syncing a Drive source when the file changes; a model or effort picker in the composer.
