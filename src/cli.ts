import { Agent } from "./agent";
import { listChromeTargets } from "./cdp";

interface CliOptions {
  url?: string;
  goal?: string;
  targetId?: string;
  cdpUrl: string;
  maxSteps: number;
  visible: boolean;
  keepOpen: boolean;
  listTabs: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function usage(): never {
  console.error(`Usage:
  bun run run -- --url <url> --goal <goal> [--max-steps 12] [--visible] [--keep-open]
  bun run run -- --tab <target-id> --goal <goal> [--url <optional-navigation-url>]
  bun run run -- --list-tabs [--cdp http://127.0.0.1:9222]`);
  process.exit(1);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    cdpUrl: process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222",
    maxSteps: Number(process.env.JEV_MAX_STEPS ?? "12"),
    visible: enabled(process.env.JEV_BROWSER_VISIBLE),
    keepOpen: enabled(process.env.JEV_BROWSER_KEEP_OPEN),
    listTabs: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = () => args[++index] ?? usage();
    if (argument === "--url") options.url = value();
    else if (argument === "--goal") options.goal = value();
    else if (argument === "--tab") options.targetId = value();
    else if (argument === "--cdp") options.cdpUrl = value();
    else if (argument === "--max-steps") options.maxSteps = Number(value());
    else if (argument === "--visible") options.visible = true;
    else if (argument === "--keep-open") options.keepOpen = true;
    else if (argument === "--list-tabs") options.listTabs = true;
    else if (argument === "--help" || argument === "-h") usage();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArgs(Bun.argv.slice(2));

if (options.listTabs) {
  const pages = (await listChromeTargets(options.cdpUrl)).filter((target) => target.type === "page");
  for (const page of pages) console.log(`${page.id}\t${page.title}\t${page.url}`);
  process.exit(0);
}

if (!options.goal || (!options.url && !options.targetId)) usage();

let agent: Agent | undefined;
try {
  agent = await Agent.create({
    url: options.url,
    targetId: options.targetId,
    goal: options.goal,
    cdpUrl: options.cdpUrl,
    maxSteps: options.maxSteps,
    visible: options.visible,
    keepOpen: options.keepOpen,
  });
  const result = await agent.run((state) => {
    console.log(`${String(state.elapsedMs).padStart(5)} ms  ${state.history.length}/${state.maxSteps} actions  ${state.status}`);
  });
  console.log(result.page.url);
  console.log(JSON.stringify({
    status: result.status,
    actions: result.history.length,
    maxSteps: result.maxSteps,
    elapsedMs: result.elapsedMs,
    textCalls: result.textCalls.length,
  }));
  process.exitCode = result.status === "done" ? 0 : result.status === "budget_exhausted" ? 3 : 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await agent?.close();
}
