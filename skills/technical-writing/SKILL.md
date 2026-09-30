---
name: technical-writing
description: How to write docs, SPECs, READMEs, runbooks, PR descriptions and commit messages that a tired engineer understands on the first read. Pick the document's mode, write to the reader, one idea per sentence, nothing that reads two ways. Use when writing or reviewing any document; pair with unslop.
---

# Technical writing

Three rules come first:

- Cut every word that does no work.
- Use the short, everyday word, and the real name from the code: the actual file, flag, command or symbol.
- When a rule makes a sentence worse, fix the sentence another way or leave it alone. The rules serve the reader.

## Pick the mode first

One document does one job. Decide which:

- **Tutorial** (learning by doing): says what the reader will build, and every step shows a visible result ("you
  should see…"). Minimal explanation, with a link for more.
- **How-to** (steps to a goal): solves one task for someone competent. Action only, forks allowed ("If you use Neon,
  do x"). Title it with the task: "Add a secret for the browser".
- **Reference** (facts to look up): describes, completely and without opinion: options, limits, errors, defaults.
  Mirrors the structure of the thing it describes.
- **Explanation** (why): one topic, with context, trade-offs and history. Opinion belongs here and nowhere else.

Don't mix them. Split the document and link the parts.

## Write to the reader

- "You", present tense. Commands for instructions: "Run `./install.sh --check`."
- Say who does what: "the daemon restarts the seat", not "the seat is restarted".
- The condition goes before the instruction: "To add a seat, run…".
- Common case first, exceptions after.
- Never "simply", "just", "easy" or "quickly" in a procedure.
- Headings state the point, in sentence case. Numbered lists for sequences, bullets for the rest.
- Links say where they go. Never "click here".
- Every command, path and count must be true at the commit that lands it.

## One thing per sentence

- One instruction per sentence. Split instructions over about 20 words, other sentences over about 25.
- Keep "the" and "a". "Remove backup file" reads two ways.
- One word per action, used the same way throughout.
- Put a warning before the step it guards.

## No sentence open to two readings

- Keep "only" and "not" next to the word they change.
- Make every "it", "this" and "they" point at one obvious thing. Repeat the noun when in doubt.
- Break long noun strings: "the proto import budget check script" becomes "the script that checks the proto-import
  budget".
- Periods instead of semicolons and dashes. No slashes ("a, b, or both"). No idioms or Latin abbreviations.

## PR descriptions and commit messages

A PR body is a briefing a reviewer reads in under a minute: what changed, why, how it was tested, and what the reviewer
should look at. Link logs; don't paste them. A commit subject says what the commit does.

## Vary the rhythm

Text that follows every rule can still read as machine-made: every sentence the same length, no view, nothing specific.
Mix short and longer sentences. In an explanation, say what you make of the trade-offs. Prefer the specific ("a column
rename fails the build") over the sterile ("schema changes can cause issues").

Then run the `unslop` skill over the result.

---
Adapted from `technical-writing` in [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan
(v0.15.5, commit fae2c6e, 2026-09-29), MIT licence; the licence text is in `LICENSE` beside this file. pstack's
version credits Diátaxis (diataxis.fr), the Google developer documentation style guide, ASD-STE100 Simplified Technical
English, and Kohl's Global English Style Guide. Changes: condensed, examples changed to ours, the tabs-for-indent and
unslop-editing rules dropped.
