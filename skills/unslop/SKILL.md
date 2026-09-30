---
name: unslop
description: Remove AI writing tells (filler, hype, hedging stacks, chatbot phrases, decorative formatting) from any text before it is posted. Use on every PR description, SPEC, issue comment, queue body and message to the owner or a client; reviewers flag slop in PR text.
---

# Unslop

Before you post text anywhere, scan it for the patterns below and rewrite. Keep the meaning and the intended tone.
This applies to PR descriptions, commit messages, SPECs, issue and PR comments (including handbacks to a client),
queue bodies and every message to the owner.

## Content

1. **Empty -ing phrases.** "highlighting…", "ensuring…", "showcasing…", "reflecting…". Delete them, or say the concrete
   thing.
2. **Vague attributions.** "Experts believe", "it is widely known". Name the source or delete.
3. **Generic conclusions.** "This lays a solid foundation", "the future looks bright". State the next step or the fact.
4. **Says how it feels, not what it does.** "The flow feels much smoother" becomes "the save takes one click instead of
   three". If a sentence could appear unchanged in another project's text, it says nothing about this one. Cut it.

## Words

5. **AI vocabulary.** additionally, crucial, delve, enhance, fostering, garner, intricate, landscape, pivotal, robust,
   seamless, showcase, testament, underscore, vibrant. Use the plain word.
6. **Fancy verbs for "is" and "has".** "serves as", "stands as", "boasts", "features".
7. **Plain word over the long one.** use, not utilize or leverage. help, not facilitate. many, not numerous. if, not in
   the event that.
8. **Abstract metaphor nouns.** substrate, vector, surface (as in "API surface"), harness (as a metaphor), north star,
   flywheel, paradigm. Say the concrete thing.
9. **Filler.** "In order to" becomes "to". "Due to the fact that" becomes "because". "It is important to note that" goes.
10. **Hedging stacks.** "could potentially possibly" becomes "may". If you know, say it. If you don't, say what you
    didn't check.
11. **Adverbs propping up weak verbs.** "significantly improves" becomes the measured change.

## Shape

12. **"Not just X, but Y"** and forced groups of three. State the point with the real number of items.
13. **Synonym cycling.** Call one thing by one name throughout.
14. **Em dashes.** Use a period or a comma instead.
15. **Bold everywhere, emoji in headings, Title Case Headings.** Sentence-case headings, no decorative emoji, bold only
    for a real label.
16. **Bold-label bullets that restate themselves.** "**Performance:** performance improved" becomes a sentence.
17. **Over-compression.** Arrows, dropped articles and verbless fragments make the reader decode. "Parser rejects bad
    date → exit 2" becomes "The parser rejects a bad date and exits with code 2."
18. **Passive voice that hides who acts.** "The file is parsed" becomes "the loader parses the file".

## Chat habits

19. **Chatbot phrases.** "I hope this helps", "Let me know if…", "Great question", "Certainly!", "You're absolutely
    right". Remove them.
20. **Sycophancy or drama.** "Found the smoking gun!" Report the finding.

## Check before posting

Read it once as the receiver: can they act on each sentence? Cut what they can't. For documents and long PR text, also
use the `technical-writing` skill.

---
Adapted from `unslop` in [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (v0.15.5, commit
fae2c6e, 2026-09-29), MIT licence; the licence text is in `LICENSE` beside this file. Changes: renumbered and
condensed, a few words added to the vocabulary list, and scoped to the text our seats post.
