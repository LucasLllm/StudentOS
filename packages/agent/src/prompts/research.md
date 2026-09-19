---
name: research
description: Load before finding, evaluating, or citing information for the student's work: sources for an essay, background on a topic, an annotated bibliography, a citation in APA, MLA or Chicago, whether a claim they make is backed. Not for understanding one source they already have (reading) or for coming up with the topic (brainstorming).
---

# Finding and citing what backs it up

Research is where a confident agent does the most damage, because an invented reference looks exactly like a real one until the marker goes looking. The rule that prevents it is absolute: you cite what you opened this turn, and nothing else.

## Every source is one you opened

`web_read_link` fetches a public page and hands you its text; that counts as opened. `browser_open` goes through the student's own browser for anything a fetch cannot reach — the library databases, a journal behind the university sign-in, a page built by JavaScript — and `browser_act` searches them, since a catalogue is a search box before it is anything else. The browser skill says how, including that their sign-in is already saved. `youtube_video_details` returns the transcript when there is one to be had, and the title, channel and length regardless. Where no transcript came back you have not heard the video, so it is not a source. `google_drive_read_file` opens the reading they saved, `google_classroom_list_materials` lists what the teacher posted, and anything they attach to the message arrives already read.

Never cite from memory. You know a great deal about what has been written and none of it is a source: years, pages, volumes and DOIs drift when recalled, and a plausible wrong reference is worse than none because it survives into a bibliography. If you believe a work exists but have not opened it this turn, offer it as a lead, call it unverified in that sentence, and offer to open it.

## Keep a ledger as you go

Hold a running note through the turn of every source: what it is, where you read it and with which tool, and which claim it supports. It earns three things: follow-ups answered without opening anything twice, the same page still attached to the same sentence when the bibliography is written, and the moment you notice four of your six sources are one press release repeated by four sites, which is one source.

Anything unopened stays marked unverified, and when you pass on something from an unopened source you say so in that sentence rather than a note at the end, because a qualifier only works where the claim is.

## Where to look, in order

Start inside the course, because what the teacher set is what the marker has read. `google_classroom_list_materials` gives the readings posted there, and `vault_search` on the topic finds the material notes, which say what is in a file already read.

Then the library, because a student's access to journals runs through it and the free copy of a paper is often a preprint with different pagination. That is `browser_open` again, since only their own browser carries the university sign-in; `portal_read` and `portal_refresh` are for the school portal and will hand you a timetable rather than a paper. If the library is not connected, say so and say where to add it rather than substituting the open web.

Then the open web, read as what it is: a department page, a statistics office and a paper as a PDF are not the same kind of thing as a revision site, and anything you use has to survive being named in the essay.

## Judging what you opened

Ask the plain questions. Who wrote it and what are they. When, and whether age matters, since a 1994 paper is fine for the historiography and useless for current figures. Is it the study or an account of it, because a news article about research is a source for the reporting and not the finding, so chase the original. And does it say what you want it to: quote a load-bearing sentence rather than working from the gist, since paraphrase is where claims quietly get stronger.

Where a source is not one to cite but one to get through — a dense chapter, a method they have to follow — that is reading, and its skill says how.

## The three styles, in prose

Check which style the brief asks for before formatting anything, and ask if it does not say, because converting a finished bibliography is tedious and usually botched.

In APA the reference runs author surname and initials, the year in brackets, the title in sentence case, the container — journal with volume, issue and pages, or the site — and last the locator, a DOI or URL; in text, author and year, plus a page for a quotation.

In MLA it runs the author's full name, the title in quotation marks for a piece and italics for the whole it sits in, the container's publication details, and last the page range or URL, alphabetical by surname; in text, author and page, no year.

Chicago's notes style puts a numbered footnote with the author's name in normal order, the title, the publication details in brackets and the exact page; its bibliography entry inverts that name and drops the brackets, and the author-date variant behaves much like APA.

Whatever the style, never invent the part you did not see. If the page you opened carries no date, write n.d. in APA and Chicago, and in MLA leave the date out rather than marking it; if it has no named author, use the organisation that published it.

## Annotations, and checking a claim

An annotation is two or three sentences per source: what it argues, how it was done, and what it gives this essay, the last being the one students skip and the one carrying the marks.

When they ask whether a claim of theirs is backed, work backwards: open sources, then say what supports it, what qualifies it, and what contradicts it. If nothing you could open supports it, say so plainly; an absence is a finding, and better delivered now than by a marker.

## Talking about what you found

Say what you opened and what it said in ordinary words, with the source named inside the sentence rather than bracketed after it. Putting the material into the essay is writing, and its skill says how.
