/**
 * bench/cli.ts
 *
 * Dispatches `bench <command>`. See HELP below and docs/guides/latency-benchmark.md.
 *
 * Inputs:  argv after the script name.
 * Outputs: Exit code 0 on success, 1 on error, 2 on usage error.
 */

import { Args, ArgError } from "./args";
import { delayCommand, fixtureCommand, planTemplateCommand, replayCommand, reportCommand } from "./commands";
import { captureCommand } from "./capture";
import { paperCommand } from "./paperProbe";

export const HELP = `Latency benchmark (docs/guides/latency-benchmark.md)

Offline — no credentials, no network, no broker:
  fixture        Fixture correctness, synthetic processing benchmark, A/A overhead
                 [--symbols SPY,QQQ] [--duration-s 120] [--quote-rate 50] [--trade-rate 10]
                 [--burst 60000:5000:10|none] [--seed 42] [--skip-overhead] [--write-recording]
  replay         Processing benchmark over a recording
                 --recording <dir> [--symbols ..] [--preload-max-mb 512] [--overhead]
  delay          Strategy delay x cost sensitivity (predeclared plan)
                 --plan <file> (--recording <dir> | --synthetic) [--split development|evaluation|all]
                 [--confirm-evaluation-split] [--empirical-from <metrics.json>] [--empirical-metric name]
  plan-template  --write <file>
  report         --run <dir> [--compare <dir,dir>]

Common processing options (fixture, replay):
  --strategy none|null|quote_imbalance|minute_reversal|pairs_trading  --strategy-count 1
  --strategy-params '{"imbalanceThreshold":0.6}'  --sink null|sim  --journal-latency-ms 0
  --journal-fail-every 0  --invalid-data pass|quarantine  --pacing max|paced  --speed 1
  --replay-burst startMs:durationMs:multiplier  --warmup-frames 500  --repetitions 3
  --sample 0.01  --detail frame|stage  --deadline-ms 10  --out <artifacts base dir>

Live (credentials required):
  capture        Live shadow: one data stream, null order sink, recording
                 --symbols SPY,QQQ --duration-min 30 --confirm-stream-owner
                 [--feed env|iex|sip|test] [--no-record] [--max-record-mb 2048] [--min-free-mb 1024]
                 [--strategy ..] [--strategy-count 1] [--sample 0.01] [--detail frame|stage] [--progress-s 60]
  paper          Bounded Alpaca PAPER order probe (EXECUTION_TARGET=alpaca-paper)
                 --confirm-paper-orders --symbol SPY --max-orders 4 --max-notional-usd 1000
                 [--qty 1] [--min-interval-ms 6000] [--order-timeout-ms 15000] [--update-timeout-ms 30000]
                 [--allow-shared-account]
`;

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = new Args(argv);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 2;
  }
  if (!args.command || args.command === "help" || args.has("help")) {
    console.log(HELP);
    return args.command ? 0 : 2;
  }
  try {
    let out: string;
    switch (args.command) {
      case "fixture": out = await fixtureCommand(args); break;
      case "replay": out = await replayCommand(args); break;
      case "delay": out = await delayCommand(args); break;
      case "capture": out = await captureCommand(args); break;
      case "paper": out = await paperCommand(args); break;
      case "report": out = reportCommand(args); break;
      case "plan-template": out = planTemplateCommand(args); break;
      default:
        console.error(`Unknown command "${args.command}".\n\n${HELP}`);
        return 2;
    }
    console.log(`[bench] wrote ${out}`);
    return 0;
  } catch (err) {
    if (err instanceof ArgError) {
      console.error(`[bench] ${err.message}`);
      return 2;
    }
    console.error(`[bench] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return 1;
  }
}
