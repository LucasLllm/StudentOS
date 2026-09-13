# Smarter harness: reasoning, context retention, goal persistence

## The problem

The agent feels less capable than the same class of model prompted directly. It reasons poorly across steps, forgets what was said earlier in the same chat, and loses the original goal after many turns. The model stays `gpt-5.6-luna`. What changes is the harness around it, modelled on Claude Code, OpenAI Codex/ChatGPT and Hermes Agent.

## What the harness did

- A turn sent the system prompt and one user message. The model never saw the conversation. Continuity was the eight most recent `Student: … / Agent: …` memory rows pasted into `<turn_context>` as a quoted note. Tool results, skill bodies and the model's own reasoning vanished at the end of every turn. The summaries tier was never written.
- The OpenAI adapter replayed assistant text and `function_call` items but never the `reasoning` items, so the model re-derived its plan from nothing on every tool round-trip, at `xhigh` effort, and again on every turn. OpenAI measured Tau-bench Retail 73.9% to 78.2% from replaying reasoning items alone; the gpt-5.6 family renders reasoning from every earlier turn by default, but only if the items are replayed.
- No plan, no compaction, no token budget. Attachments were re-sent whole every turn. Tools ran serially and a tool that threw killed the turn.
- The quota counted every token at full weight, so cached input (a tenth of the price) and output (six times the price) were both counted as one.

## Decisions

1. **The model sees the transcript.** Every item a turn produces is stored per chat and replayed on the next turn: the student's message, the assistant's text with its opaque provider items (reasoning, tool calls), each tool result, and later the compaction summaries and clearing watermarks. Rows are never rewritten, so the replayed prefix is byte-identical from one turn to the next and prefix caching holds.
2. **Reasoning persists.** The provider's raw output items ride on the assistant message as an opaque payload tagged by wire format, and the same format replays them verbatim. A different format (a student switching keys) falls back to text plus tool-call reconstruction. OpenAI: `include: ['reasoning.encrypted_content']`, `store: false`, `reasoning.context: 'all_turns'`. Anthropic: adaptive thinking and thinking blocks replayed with their signatures.
3. **Effort by call.** The agent turn stays at `xhigh`. Titles run without reasoning, compaction and vault writers at `medium`. Every call sets `max_output_tokens`.
4. **Context has a budget, and the cheapest cut comes first.** When the estimated transcript passes 40k tokens, tool results older than the last five are replaced by a short stub naming the tool and how to fetch it again (the call and its arguments stay). When it passes 80k, everything before the fourth-last student turn is summarised by a text-only call and replaced by that summary. Both are recorded as items, so they happen once and stay put.
5. **Our own summary, structured for handoff.** The summary opens with the student's most recent unfulfilled message quoted verbatim (a reverse signal cancels earlier work), then task overview, every student message (verbatim when short), current state in past tense, discoveries including what failed, next steps, context to preserve (preferences, promises, files by name, safety instructions word for word), and verbatim quotes of where things left off. A later compaction updates the earlier summary rather than starting over. It is re-injected as a user-role message with a prefix explaining that another model produced it. A failed summariser call skips compaction for that turn and never fails the student's turn.
6. **The goal lives in a plan, recited at the end of context.** A `plan_update` tool keeps two to five milestones with exactly one in progress, for work that spans steps or turns and never for a question answerable in one go. The plan is rendered as the last section of `<turn_context>` every turn. If a step is in progress and the plan has not changed for three turns, a one-line nudge asks the model to update or ignore it.
7. **The system prompt says how to work.** A new always-loaded document: keep going until the thing is actually done; ask once when the answer genuinely depends on the student, otherwise assume and say so; at most two lookups before answering unless asked to research; independent tool calls together; keep a plan for multi-step work; the chat may open with a handoff summary and cleared tool results, so there is no reason to wrap up early. Contradictions between existing prompts are removed, because a reasoning model spends tokens reconciling them.
8. **Quota measures cost.** Usage is summed as cost-equivalent tokens (recorded cost divided by the uncached input price), so cached input and reasoning-heavy output count for what they cost. The monthly constant is re-based to keep roughly the same number of typical turns.
9. **A multi-turn eval is the bar.** Scripted conversations of twenty to thirty turns through the real loop check that a fact from turn one is recalled at turn twenty, that a goal set at turn one survives distractions, and that a tool result from turn three is recalled at turn eighteen, each with and without forced compaction, plus the cache-hit ratio.

## What stays

The three-tier cached system prompt with volatile content in the user message; skills on demand; the vault page about the student; per-exchange memory rows and `memory_search`, which now cover what compaction has summarised away; the activity feed.

## Out of scope

Cross-chat goals and deadlines in vault memory; OpenAI's server-side compaction; reasoning summaries in the interface; streaming; an external judge of goal completion.
