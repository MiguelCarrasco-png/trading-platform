/**
 * runtime/bench.ts
 *
 * Entry point for the latency benchmark CLI (src/bench/cli.ts). Runs in its
 * own process — never inside a trading runtime — so a replay's simulated
 * clock can never reach live order flow.
 *
 * Per-event logging would distort the measurements, so the log level defaults
 * to "warn" here. It is set before any module that reads the environment is
 * loaded; an explicit LOG_LEVEL still wins.
 *
 * Usage: npm run bench -- <command> [options]      (compiled: node dist/runtime/bench.js ...)
 */

process.env.LOG_LEVEL ??= "warn";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { main } = require("../bench/cli") as typeof import("../bench/cli");

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
