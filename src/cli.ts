#!/usr/bin/env bun

import packageJson from "../package.json" with { type: "json" };
import { Agent } from "./agent";
import { WaitTimeoutError } from "./browser";
import { listChromeTargets } from "./cdp";
import { checkRecordingEncoder } from "./ffmpeg";
import { actionSpace } from "./model";
import type { FrameState, HistoryEntry, PageState } from "./types";

const NAME = "jev-cdp";
const TITLE = "Jev CDP";
const VERSION = packageJson.version;
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

interface RunOptions {
  url?: string;
  goal?: string;
  targetId?: string;
  cdpUrl: string;
  maxSteps: number;
  interactionPauses: number;
  waitBudgetMs: number;
  visible: boolean;
  keepOpen: boolean;
  recordingPath?: string;
  screenshotPath?: string;
  finalState: boolean;
  fieldValues: Record<string, string>;
  sensitiveFieldLabels: string[];
  freshContext: boolean;
}

interface CommonOptions {
  cdpUrl: string;
  json: boolean;
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
  required: boolean;
}

class CliError extends Error {
  constructor(message: string, readonly showHint = true) {
    super(message);
  }
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function nextValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError(`${option} requires a value`);
  return value;
}

function generalHelp(): string {
  return `${TITLE} ${VERSION}
A small Jev-powered bridge to Chrome through the Chrome DevTools Protocol.

Usage:
  ${NAME} run --url <url> --goal <goal> [options]
  ${NAME} run --tab <target-id> --goal <goal> [options]
  ${NAME} tabs [--cdp <url>] [--json]
  ${NAME} doctor [--cdp <url>] [--json]
  ${NAME} help [command]
  ${NAME} version

Commands:
  run       Execute one bounded browser goal.
  tabs      List open Chrome page targets available through CDP.
  doctor    Check credentials, Chrome CDP, and optional helpers.
  help      Show general help or help for one command.
  version   Print the installed version.

Quick start:
  TYPESAFE_API_KEY=... ${NAME} run \\
    --url https://example.com \\
    --goal 'Open the More information link.' \\
    --max-steps 4 \\
    --final-state

Run '${NAME} help run' for all run options and examples.`;
}

function runHelp(): string {
  return `${TITLE} ${VERSION} — run
Execute one bounded Jev browser goal against a new or already-open Chrome tab.

Usage:
  ${NAME} run --url <url> --goal <goal> [options]
  ${NAME} run --tab <target-id> --goal <goal> [options]

Target:
  --url <url>                    URL to open, or URL to navigate an attached tab to.
  --tab <target-id>              Attach to an exact target returned by '${NAME} tabs'.
  --fresh-context                Create an isolated Chrome context with fresh storage.
  --cdp <url>                    Chrome DevTools endpoint.
                                 [env: CHROME_CDP_URL]
                                 [default: ${DEFAULT_CDP_URL}]

Goal control:
  --goal <text>                  One bounded browser goal. Required.
  --max-steps <number>           Maximum executed browser actions.
                                 [env: JEV_MAX_STEPS] [default: 12]
  --wait-budget-ms <number>      Total wall-clock budget for page and frame readiness.
                                 [default: 15000]

Browser behavior:
  --visible                      Activate the controlled tab.
                                 [env: JEV_BROWSER_VISIBLE=1]
  --keep-open                    Leave a runner-created tab or context open.
                                 [env: JEV_BROWSER_KEEP_OPEN=1]
  --interaction-pauses <ms>      Pause after page loads and before clicks. Jev decisions
                                 run during page pauses, so only remaining time is waited.

Known field values:
  --field-value <label=value>    Type an exact non-secret value when that accessible
                                 field label is selected. May be repeated.
  --field-value-env <label=env>  Read a sensitive value from an environment variable.
                                 May be repeated; the value is never sent to Jev.

Evidence and output:
  --recording <file.mp4>         Record the complete goal with an animated cursor.
                                 Requires FFmpeg.
  --screenshot <file.jpg>        Save the final browser viewport.
  --final-state                  Add the final semantic page state to stdout JSON.
  -h, --help                     Show this help and exit.

Output:
  Stdout is JSON Lines: one object per executed action, then one result object.
  Each action includes new console errors observed during that step. The result
  includes initial errors and all errors observed during the run.
  Errors and diagnostics use stderr.

Exit codes:
  0  Jev reported the goal complete.
  1  Invalid configuration or runtime failure.
  2  Jev was blocked or the wait budget timed out.
  3  The maximum browser-step budget was exhausted.

Examples:
  ${NAME} run --url https://example.com --goal 'Open the documentation.' --max-steps 4

  ${NAME} run --tab TARGET_ID --goal 'Submit the prepared form.' --final-state

  LOGIN_PASSWORD=... ${NAME} run \\
    --fresh-context \\
    --url https://example.test/login \\
    --goal 'Log in with the provided Username and Password.' \\
    --field-value 'Username=Admin' \\
    --field-value-env 'Password=LOGIN_PASSWORD'`;
}

function tabsHelp(): string {
  return `${TITLE} ${VERSION} — tabs
List open Chrome page targets exposed by a Chrome DevTools endpoint.

Usage:
  ${NAME} tabs [--cdp <url>] [--json]

Options:
  --cdp <url>  Chrome DevTools endpoint. [default: ${DEFAULT_CDP_URL}]
  --json       Emit a JSON array instead of tab-separated rows.
  -h, --help   Show this help and exit.`;
}

function doctorHelp(): string {
  return `${TITLE} ${VERSION} — doctor
Check whether this machine is ready to run Jev CDP.

Usage:
  ${NAME} doctor [--cdp <url>] [--json]

Options:
  --cdp <url>  Chrome DevTools endpoint. [default: ${DEFAULT_CDP_URL}]
  --json       Emit a machine-readable diagnostic report.
  -h, --help   Show this help and exit.

The TypeSafe key and Chrome CDP connection are required. FFmpeg is required only
for --recording. A text helper is needed only when an exact --field-value is not supplied.`;
}

function commandHelp(command: string | undefined): string {
  if (!command) return generalHelp();
  if (command === "run") return runHelp();
  if (command === "tabs") return tabsHelp();
  if (command === "doctor") return doctorHelp();
  if (command === "help") return generalHelp();
  if (command === "version") return `${NAME} ${VERSION}`;
  throw new CliError(`Unknown help topic: ${command}`);
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CliError(`${option} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value: string, option: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new CliError(`${option} must be a non-negative integer in milliseconds`);
  }
  return Number(value);
}

function addFieldValue(options: RunOptions, assignment: string, fromEnvironment: boolean): void {
  const separator = assignment.indexOf("=");
  if (separator < 1 || !assignment.slice(separator + 1)) {
    throw new CliError(`${fromEnvironment ? "--field-value-env" : "--field-value"} must be 'Accessible label=${fromEnvironment ? "ENVIRONMENT_VARIABLE" : "Exact value"}'`);
  }
  const label = assignment.slice(0, separator);
  if (Object.hasOwn(options.fieldValues, label)) throw new CliError(`Duplicate field-value label: ${label}`);
  if (fromEnvironment) {
    const environmentName = assignment.slice(separator + 1);
    const supplied = process.env[environmentName];
    if (!supplied) throw new CliError(`Environment variable is missing or empty: ${environmentName}`);
    options.fieldValues[label] = supplied;
    options.sensitiveFieldLabels.push(label);
  } else {
    options.fieldValues[label] = assignment.slice(separator + 1);
  }
}

function parseRunOptions(args: string[]): RunOptions {
  const options: RunOptions = {
    cdpUrl: process.env.CHROME_CDP_URL ?? DEFAULT_CDP_URL,
    maxSteps: parsePositiveInteger(process.env.JEV_MAX_STEPS ?? "12", "JEV_MAX_STEPS"),
    interactionPauses: 0,
    waitBudgetMs: 15_000,
    visible: enabled(process.env.JEV_BROWSER_VISIBLE),
    keepOpen: enabled(process.env.JEV_BROWSER_KEEP_OPEN),
    finalState: false,
    fieldValues: {},
    sensitiveFieldLabels: [],
    freshContext: enabled(process.env.JEV_BROWSER_FRESH_CONTEXT),
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--url") options.url = nextValue(args, index++, argument);
    else if (argument === "--goal") options.goal = nextValue(args, index++, argument);
    else if (argument === "--tab") options.targetId = nextValue(args, index++, argument);
    else if (argument === "--cdp") options.cdpUrl = nextValue(args, index++, argument);
    else if (argument === "--max-steps") options.maxSteps = parsePositiveInteger(nextValue(args, index++, argument), argument);
    else if (argument === "--interaction-pauses") options.interactionPauses = parseNonNegativeInteger(nextValue(args, index++, argument), argument);
    else if (argument === "--wait-budget-ms") options.waitBudgetMs = parsePositiveInteger(nextValue(args, index++, argument), argument);
    else if (argument === "--recording") options.recordingPath = nextValue(args, index++, argument);
    else if (argument === "--screenshot") options.screenshotPath = nextValue(args, index++, argument);
    else if (argument === "--field-value") addFieldValue(options, nextValue(args, index++, argument), false);
    else if (argument === "--field-value-env") addFieldValue(options, nextValue(args, index++, argument), true);
    else if (argument === "--final-state") options.finalState = true;
    else if (argument === "--fresh-context") options.freshContext = true;
    else if (argument === "--visible") options.visible = true;
    else if (argument === "--keep-open") options.keepOpen = true;
    else if (argument === "--help" || argument === "-h") throw new CliError(runHelp(), false);
    else throw new CliError(`Unknown run option: ${argument}`);
  }

  if (!options.goal) throw new CliError("--goal is required");
  if (!options.url && !options.targetId) throw new CliError("--url or --tab is required");
  if (options.freshContext && options.targetId) throw new CliError("--fresh-context cannot be combined with --tab");
  return options;
}

function parseCommonOptions(args: string[], help: () => string): CommonOptions {
  const options: CommonOptions = {
    cdpUrl: process.env.CHROME_CDP_URL ?? DEFAULT_CDP_URL,
    json: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--cdp") options.cdpUrl = nextValue(args, index++, argument);
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") throw new CliError(help(), false);
    else throw new CliError(`Unknown option: ${argument}`);
  }
  return options;
}

export function actionEvent(entry: HistoryEntry, maxSteps: number) {
  return {
    type: "action",
    status: "executed",
    step: entry.step,
    elapsedMs: entry.executed_ms,
    budget: { used: entry.step, max: maxSteps, remaining: maxSteps - entry.step },
    page: { before: entry.from_url, after: entry.url, changed: entry.page_changed, viewport: entry.viewport },
    tab: { before: entry.from_target_id, after: entry.target_id },
    consoleErrors: entry.consoleErrors,
    action: {
      kind: entry.kind,
      label: entry.action,
      element: entry.element,
      ...(entry.kind === "fill" ? { text: entry.text, redacted: entry.redacted } : {}),
      ...(entry.kind === "select" ? { optionValue: entry.value } : {}),
      ...(entry.kind === "scroll" ? { deltaY: entry.delta_y, point: { x: 550, y: 650 } } : {}),
      ...(entry.kind === "wait" ? { durationMs: 100 } : {}),
    },
  };
}

function semanticState(page: PageState, elements: ReturnType<Agent["snapshot"]>["elements"]) {
  const frameTree = (parentId: string | null): Array<FrameState & { children: unknown[] }> =>
    page.frames.filter(frame => frame.parentId === parentId)
      .map(frame => ({ ...frame, children: frameTree(frame.id) }));
  return { url: page.url, title: page.title, text: page.text,
    viewport: { width: page.w, height: page.h }, scroll: page.scroll,
    elements, frameTree: frameTree(null), transitions: page.transitions,
    omittedActions: page.omitted_actions };
}

async function runGoal(args: string[]): Promise<number> {
  const options = parseRunOptions(args);
  let agent: Agent | undefined;
  let reportedActions = 0;
  try {
    agent = await Agent.create({
      url: options.url,
      targetId: options.targetId,
      goal: options.goal!,
      cdpUrl: options.cdpUrl,
      maxSteps: options.maxSteps,
      interactionPauses: options.interactionPauses,
      waitBudgetMs: options.waitBudgetMs,
      visible: options.visible,
      keepOpen: options.keepOpen,
      recordingPath: options.recordingPath,
      screenshotPath: options.screenshotPath,
      fieldValues: options.fieldValues,
      sensitiveFieldLabels: options.sensitiveFieldLabels,
      freshContext: options.freshContext,
    });
    await agent.run((state) => {
      const action = state.history.length > reportedActions ? state.history.at(-1) : undefined;
      reportedActions = state.history.length;
      if (action) console.log(JSON.stringify(actionEvent(action, state.maxSteps)));
    });
    await agent.close();
    const result = agent.snapshot();
    console.log(JSON.stringify({
      type: "result",
      status: result.status,
      targetId: agent.targetId,
      url: result.page.url,
      actions: result.history.length,
      maxSteps: result.maxSteps,
      budget: { used: result.history.length, max: result.maxSteps, remaining: result.maxSteps - result.history.length },
      elapsedMs: result.elapsedMs,
      textCalls: result.textCalls.length,
      initialConsoleErrors: result.initialConsoleErrors,
      consoleErrors: result.consoleErrors,
      ...(result.waitTimeout ? { waitTimeout: result.waitTimeout } : {}),
      ...(options.recordingPath ? { recording: options.recordingPath } : {}),
      ...(options.screenshotPath ? { screenshot: options.screenshotPath } : {}),
      ...(options.finalState || result.status === "wait_timeout" ? {
        finalState: semanticState(result.page, result.elements),
      } : {}),
    }));
    return result.status === "done" ? 0 : result.status === "budget_exhausted" ? 3 : 2;
  } catch (error) {
    const state = agent?.snapshot();
    for (const action of state?.history.slice(reportedActions) ?? []) {
      console.log(JSON.stringify(actionEvent(action, options.maxSteps)));
    }
    console.log(JSON.stringify({
      type: "result",
      status: error instanceof WaitTimeoutError ? "wait_timeout" : "error",
      targetId: agent?.targetId ?? null,
      url: state?.page.url ?? (error instanceof WaitTimeoutError ? error.state?.url ?? null : null),
      actions: state?.history.length ?? 0,
      maxSteps: options.maxSteps,
      budget: { used: state?.history.length ?? 0, max: options.maxSteps, remaining: options.maxSteps - (state?.history.length ?? 0) },
      elapsedMs: state?.elapsedMs ?? 0,
      initialConsoleErrors: state?.initialConsoleErrors ?? [],
      consoleErrors: state?.consoleErrors ?? [],
      ...(error instanceof WaitTimeoutError ? { waitTimeout: { elapsedMs: error.elapsedMs, pendingCondition: error.pendingCondition } } : {}),
      ...(state ? { finalState: semanticState(state.page, state.elements) } :
        error instanceof WaitTimeoutError && error.state ? { finalState: semanticState(error.state, actionSpace(error.state.actions).elements) } : {}),
    }));
    if (error instanceof WaitTimeoutError) return 2;
    throw error;
  } finally {
    await agent?.close();
  }
}

async function listTabs(args: string[]): Promise<number> {
  const options = parseCommonOptions(args, tabsHelp);
  const pages = (await listChromeTargets(options.cdpUrl)).filter((target) => target.type === "page");
  if (options.json) console.log(JSON.stringify(pages));
  else for (const page of pages) console.log(`${page.id}\t${page.title}\t${page.url}`);
  return 0;
}

async function inspectChrome(cdpUrl: string): Promise<{ browser: string; pages: number }> {
  const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const version = await response.json() as { Browser?: string; webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("browser WebSocket URL is missing");
  const targets = await listChromeTargets(cdpUrl);
  return { browser: version.Browser ?? "Chrome-compatible browser", pages: targets.filter((target) => target.type === "page").length };
}

async function doctor(args: string[]): Promise<number> {
  const options = parseCommonOptions(args, doctorHelp);
  const checks: DoctorCheck[] = [{ name: "runtime", status: "ok", detail: `Bun ${Bun.version}`, required: true }];
  checks.push(process.env.TYPESAFE_API_KEY
    ? { name: "typesafe", status: "ok", detail: "TYPESAFE_API_KEY is set", required: true }
    : { name: "typesafe", status: "error", detail: "TYPESAFE_API_KEY is not set", required: true });

  try {
    const chrome = await inspectChrome(options.cdpUrl);
    checks.push({ name: "chrome", status: "ok", detail: `${chrome.browser}; ${chrome.pages} page target(s) at ${options.cdpUrl}`, required: true });
  } catch (error) {
    checks.push({
      name: "chrome",
      status: "error",
      detail: `Cannot reach ${options.cdpUrl}: ${error instanceof Error ? error.message : String(error)}`,
      required: true,
    });
  }

  try {
    checks.push({ name: "recording", status: "ok", detail: await checkRecordingEncoder(), required: false });
  } catch (error) {
    checks.push({ name: "recording", status: "warning", detail: `${error instanceof Error ? error.message : String(error)}; --recording will be unavailable`, required: false });
  }

  if (process.env.TEXT_MODEL_PROVIDER === "api") {
    checks.push(process.env.TEXT_MODEL_API_KEY
      ? { name: "text-helper", status: "ok", detail: `API helper configured (${process.env.TEXT_MODEL ?? "deepseek-chat"})`, required: false }
      : { name: "text-helper", status: "warning", detail: "TEXT_MODEL_PROVIDER=api but TEXT_MODEL_API_KEY is not set", required: false });
  } else {
    const codex = Bun.which(process.env.CODEX_BIN ?? "codex");
    checks.push(codex
      ? { name: "text-helper", status: "ok", detail: `Codex found at ${codex} (${process.env.TEXT_MODEL ?? "gpt-5.6-luna"})`, required: false }
      : { name: "text-helper", status: "warning", detail: "Codex not found; provide every field value explicitly", required: false });
  }

  const ready = checks.every((check) => !check.required || check.status === "ok");
  if (options.json) console.log(JSON.stringify({ name: NAME, version: VERSION, ready, checks }));
  else {
    console.log(`${TITLE} ${VERSION} doctor`);
    for (const check of checks) {
      const marker = check.status === "ok" ? "ok" : check.status === "warning" ? "warn" : "fail";
      console.log(`[${marker}] ${check.name}: ${check.detail}`);
    }
    console.log(ready ? "Ready for a Jev CDP run." : `Not ready. Fix required checks, then run '${NAME} doctor' again.`);
  }
  return ready ? 0 : 1;
}

function resolveCommand(args: string[]): { command: string; rest: string[] } {
  const [first, ...rest] = args;
  if (!first) return { command: "help", rest: [] };
  if (first === "--help" || first === "-h") return { command: "help", rest: [] };
  if (first === "--version" || first === "-V") return { command: "version", rest: [] };
  if (first === "--list-tabs") return { command: "tabs", rest };
  if (first.startsWith("-")) return { command: "run", rest: args };
  return { command: first, rest };
}

export async function main(args = Bun.argv.slice(2)): Promise<number> {
  try {
    const { command, rest } = resolveCommand(args);
    if (command === "help") {
      console.log(commandHelp(rest[0]));
      return 0;
    }
    if (command === "version") {
      if (rest.length) throw new CliError("version does not accept arguments");
      console.log(`${NAME} ${VERSION}`);
      return 0;
    }
    if (command === "run") return await runGoal(rest);
    if (command === "tabs") return await listTabs(rest);
    if (command === "doctor") return await doctor(rest);
    throw new CliError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof CliError && !error.showHint) {
      console.log(error.message);
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Run '${NAME} --help' for usage.`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
