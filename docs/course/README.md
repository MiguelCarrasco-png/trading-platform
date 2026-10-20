# Intro course: your first trading strategy

A 60–90 minute live-coding lesson for beginners. Learners write a very small
strategy, release it on the platform, and watch it trade on a paper account.

- Learner handout: [lesson-steps.md](lesson-steps.md) (six runnable steps + exercises)
- Vocabulary: [glossary.md](glossary.md)
- Answer key: `backend/src/strategies/beginnerReversal/` (status `planned`, so it never
  shows up in the picker)

## The one-diagram explanation (10 min)

Draw this and come back to it all lesson. Everything learners write lives in the
fourth box; the platform does the rest.

```
market data → state (latest bar, position) → evaluate() → signal → risk checks → paper order
                                              ^^^^^^^^^^
                                              your code
```

## Timeline

| Min | Part | What happens |
|---|---|---|
| 0–10 | Big picture | The diagram. "A strategy only decides; the platform trades safely." |
| 10–20 | Read a finished one | Walk through `minuteReversalStrategy.ts`, then close it. |
| 20–50 | Steps 1–5 | Live-code `my_reversal`. Learners type along; each step ends with something to run. |
| 50–65 | Step 6 | Move a number into the form; save, version, relaunch. |
| 65–90 | Exercises | Pairs of learners; the instructor circulates. |

Pace by the checkpoints, not the clock: every step has a **Check it** line. If a
learner's check fails, they fix it before moving on.

## The teaching moment: `planned` → `ready`

Each strategy carries a status in its manifest. In step 2, flipping `planned` to
`ready` is what makes it appear on the page. Use it to explain how real teams ship:
code can be merged and tested while hidden, then released with one deliberate change.
Exercise 4 (`retired`) shows the other half: new launches stop, but strategies that
are already running keep running.

## Before class (do this the day before)

1. **Paper only.** The Strategies page starts paper sandboxes only. Give each learner
   (or each pair) their own Alpaca paper account if they run their own stack; the free
   data plan allows **one data stream per account**, so two stacks on one account will
   fight over it.
2. **Market hours.** Bars arrive once a minute while the market is open (09:30–16:00
   ET, weekdays). Outside those hours the strategy runs but has nothing to react to.
   Plan the live portion for market hours, or pre-record the "watch it trade" moment
   as a fallback.
3. **Restarts.** After you edit backend code you must restart the backend. With
   `docker-compose.dev.yml` on Windows, edits on the host do not trigger nodemon in
   the container, so restart the container yourself (`docker compose restart <service>`).
   Rehearse this; a reload that doesn't fire in front of a class is the most common
   stumble. A run left running is adopted again automatically after the restart.
4. **Sandbox limits.** Each member has a cap on active paper runs and a capital cap.
   Stop old runs before class.
5. **Keep the machine awake** and check Docker is up before learners arrive.
6. **Dry-run the steps** yourself once. Every code block in `lesson-steps.md` was
   compiled step by step, but your environment is the one that matters.

## Making it easy to follow along

- Show the editor and the Strategies page side by side.
- Have learners keep the backend terminal visible: Steps 3–5 print a plain-English
  line for every decision, which is the best way to see "what the strategy is thinking".
- Tag a starting commit and a commit per step (`step-1` … `step-6`) in your own
  copy so a lost learner can `git checkout step-3` and rejoin. (These tags are not
  created by the repo; they are a one-time job for the instructor.)
- Hand out the glossary on paper.

## What this lesson deliberately skips

Backtesting, risk limits, order types, and the review/approval workflow for going
live. Mention that they exist ("the risk layer is why you can't blow up the account
from here") and point to the architecture docs for a second session.
