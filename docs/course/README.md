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

1. **Run it locally, in sim.** Each learner (or pair) runs their own stack: `npm run dev:stack`
   ([local development](../guides/local-development.md)), or the
   [no-Docker path](../guides/local-development-no-docker.md) on a locked-down laptop. The
   paper runner starts with `EXECUTION_TARGET=sim`, which fills orders in a local book and
   needs **no Alpaca account**. Nobody shares the club account, and nobody fights over
   Alpaca's one-data-stream-per-account limit.
2. **Seed the market data.** With no keys the runner replays cached 1-minute bars (default:
   the last five days). Run `npm run data:pull` once per machine. The replay runs at real
   speed by default (one bar per minute), which is too slow for a lesson: set
   `REPLAY_SPEED=60` (or higher) in `backend/.env`, and `REPLAY_FROM`/`REPLAY_TO` to pick a
   day with plenty of movement. This also makes the lesson work outside market hours.
   Learners with their own free Alpaca data key can add `LOCAL_STREAM_DATA=1` to trade the live
   IEX stream instead (market hours only).
3. **Restarts.** After you edit backend code you must restart the backend. With the Docker
   stack on Windows, edits on the host may not trigger nodemon in the container, so be ready
   to restart the container yourself (`docker compose restart <service>`). Rehearse this; a
   reload that doesn't fire in front of a class is the most common stumble. A run left
   running is adopted again automatically after the restart.
4. **Sandbox limits.** Each member has a cap on active sandbox runs and a capital cap. Stop old
   runs before class.
5. **Check Docker is up** (and the machine stays awake) before learners arrive.
6. **Dry-run the steps** yourself once, on the replay settings you will teach with. Every code
   block in `lesson-steps.md` was compiled step by step, but your environment is the one that
   matters.

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
