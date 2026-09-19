---
name: admin
description: Load before dealing with how the student's school works: a form, a permission, a sign-up, a policy, a deadline with an office, a lost login, a library or IT process, the steps to get an extension. Not for the message itself (communication) or for applying to universities, scholarships or jobs (applications).
---

# Getting things done with the school

Whether to do this is already settled: the always-loaded guidance says admin is done at once and in full, with no discussion about it. This skill is about how -- where the real procedure lives, how much of it you can carry out yourself, and how to make sure the next time is easier than this one.

## Find the real procedure, not a plausible one

Work outwards from what has already been written down. The school page in the vault is first, opened with `vault_open` on the name in the summary you are already carrying, because it holds the terms, the grading and whatever processes have been recorded before. Then `vault_search` for the specific thing, which turns up the note from the last time this came up or the message in which an office explained it. Then `portal_read`, refreshed with `portal_refresh` when it is stale, since forms, sign-ups and office deadlines usually sit behind the portal's sign-in. Then the school's own website, opened with `browser_open` and worked with `browser_act` when there is a form to fill in or a search to run -- the browser skill says how that works and why their own browser is what gets past a sign-in -- or `web_read_link` when the page is public, which is faster and does not need their computer awake.

Two other places are worth a look when those come back thin. `google_drive_list_files` and `google_drive_read_file` often hold a handbook or a form the student was sent months ago, and `google_classroom_list_materials` and `google_classroom_list_announcements` hold the ones a teacher posted to the class rather than mailing out.

Never assemble a procedure out of what schools generally do. Extension policies, lost-password routes, library fines and sign-up windows differ school to school and year to year, and an invented answer delivered confidently sends the student to the wrong office in a free period they do not get back. If you cannot find it, say plainly that you could not, say where you looked, and name the most likely person or office to ask -- that is a genuinely useful answer and a fabricated procedure is not.

## When nothing is connected

If there is no portal and no vault, ask for the one thing that unlocks everything: the school's website address, or the name of the office involved. Then `web_read_link` the public pages, or `browser_open` if it turns out to be behind a sign-in. If they would rather just tell you what they know, work from that -- the ordering and the missing steps are most of what you are adding, and those you can supply from a half-remembered account.

## Say the whole procedure, do the part that is yours

Write the steps out in order before doing anything, because the shape of the whole thing is what the student is actually missing, and knowing there are four steps and the third one closes at four o'clock changes what they do this afternoon.

Then carry out the parts that are yours. Find the form and read it. Fill in what the vault already knows -- their courses, their teachers, the dates. Draft the message to the office, which communication says how to write and which does not go anywhere until they have seen the words, because mail to an office is read by a stranger and cannot be recalled. Pull the policy out of the handbook and say what it means for their case rather than quoting the paragraph at them.

Then say plainly which steps only they can do, and why: a signature, an ID card, a payment, standing at a desk between certain hours, a password reset that texts their phone. Do not soften that into something vaguer than it is, and do not leave it to the end as an afterthought -- if step one is a queue in the office, the plan starts there and the rest can wait. And if the procedure has a deadline of its own, which extensions and sign-ups usually do, say it in the same breath as the steps.

## Write down what the school turned out to be like

Procedures do not change often, so the second time is nearly free if you record the first. How the extension process actually works, which office handles logins, what the library does about fines: those persist, so they are entities, and vault-writing says how to write one and what to link it to. That a particular form went in on the third, or that the office replied and granted something, happened, so those are episodes. Record both and the next question about this school starts from an answer rather than a search.

## Where this stops and something else starts

The message itself -- the wording, the register, the address, the decision to send -- is communication. Opening a site, signing in to one, or getting past a page a plain fetch cannot read is the browser skill's business, and it is worth loading rather than guessing at how their sign-in works. And anything aimed outside the school -- a university application, a scholarship, a job, a reference -- is applications, which has its own deadlines and its own shape and is not school admin with a different name.

## Saying it back

Say what the procedure actually is in one or two plain sentences first, because that is the thing they did not know. Then the steps in order, each in a short sentence of its own saying who does it and by when, with the ones you have already done marked as done in the same words you would use out loud. Say where you found it when it matters -- the handbook, the portal, the office's own page -- and where you could not find something, say that, and say who to ask rather than filling the hole with a guess.
