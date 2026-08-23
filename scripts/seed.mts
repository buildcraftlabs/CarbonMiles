/**
 * Seed harness entry point.
 *
 *   pnpm db:seed                       # run every module in registry order
 *   pnpm db:seed --dry-run             # report the delta, write nothing
 *   pnpm db:seed --only=states,cities  # run a subset, still in registry order
 *   pnpm db:seed --list                # show the registry
 *
 * Re-running is safe and expected: modules diff against what is already in the
 * database and apply only the delta.
 */
import { db, sql } from "../src/db/client";
import { SEED_MODULES, formatReport, runSeed } from "../src/db/seed";

type Args = { only: string[]; dryRun: boolean; list: boolean; help: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { only: [], dryRun: false, list: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--only=")) {
      args.only.push(
        ...arg
          .slice("--only=".length)
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      );
    } else {
      throw new Error(`Unrecognised argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `Usage: pnpm db:seed [--dry-run] [--only=a,b] [--list]`;

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.list) {
    console.log("Seed modules, in registry order:\n");
    for (const seedModule of SEED_MODULES) {
      console.log(`  ${seedModule.name.padEnd(18)} ${seedModule.description}`);
    }
    return 0;
  }

  const startedAt = performance.now();
  try {
    const report = await runSeed(db, SEED_MODULES, {
      only: args.only,
      dryRun: args.dryRun,
    });
    console.log(`\n${formatReport(report)}\n`);
    console.log(`Done in ${Math.round(performance.now() - startedAt)}ms.`);
    return 0;
  } catch (error) {
    console.error(`\nSeed failed — the transaction was rolled back, nothing was written.`);
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

const code = await main();
await sql.end();
process.exit(code);
