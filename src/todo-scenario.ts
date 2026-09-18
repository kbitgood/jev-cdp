import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentSnapshot } from "./agent";
import { closeChromeTarget } from "./cdp";
import {
  addedTodoNames,
  completedFilterIsSelected,
  todoIsCompleted,
  visibleTodoNames,
} from "./todo-verifier";

interface Options {
  runs: number;
  maxSteps: number;
  guardSteps: number;
  cdpUrl: string;
  visible: boolean;
  artifacts: string;
}

interface Assertion {
  name: string;
  passed: boolean;
  details: string;
}

interface StageRecord {
  name: string;
  goal: string;
  result: ReturnType<typeof serializableSnapshot>;
  attempts?: ReturnType<typeof serializableSnapshot>[];
  assertions: Assertion[];
}

function usage(): never {
  console.error("bun run scenario:todo -- [--runs 3] [--max-steps 6] [--guard-steps 2] [--visible] [--artifacts artifacts]");
  process.exit(1);
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    runs: 3,
    maxSteps: 6,
    guardSteps: 2,
    cdpUrl: process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222",
    visible: false,
    artifacts: "artifacts",
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = () => args[++index] ?? usage();
    if (argument === "--runs") options.runs = Number(value());
    else if (argument === "--max-steps") options.maxSteps = Number(value());
    else if (argument === "--guard-steps") options.guardSteps = Number(value());
    else if (argument === "--cdp") options.cdpUrl = value();
    else if (argument === "--artifacts") options.artifacts = value();
    else if (argument === "--visible") options.visible = true;
    else if (argument === "--help" || argument === "-h") usage();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const [name, value] of [["runs", options.runs], ["maxSteps", options.maxSteps], ["guardSteps", options.guardSteps]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return options;
}

function serializableSnapshot(snapshot: AgentSnapshot) {
  return { ...snapshot, page: { ...snapshot.page, screenshot: undefined } };
}

function assertion(name: string, passed: boolean, details: string): Assertion {
  return { name, passed, details };
}

function average(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

async function sourceIdentity() {
  const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const statusProcess = Bun.spawn(["git", "status", "--short"], { stdout: "pipe", stderr: "ignore" });
  const [revision, status] = await Promise.all([
    new Response(revisionProcess.stdout).text(),
    new Response(statusProcess.stdout).text(),
  ]);
  return { revision: revision.trim(), dirty: Boolean(status.trim()), status: status.trim().split("\n").filter(Boolean) };
}

async function writeFrame(snapshot: AgentSnapshot, framesDir: string, counter: { value: number }): Promise<void> {
  if (!snapshot.page.screenshot) return;
  const name = `${String(counter.value++).padStart(4, "0")}.jpg`;
  await Bun.write(join(framesDir, name), Buffer.from(snapshot.page.screenshot, "base64"));
}

async function renderVideo(framesDir: string, output: string): Promise<void> {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required to render scenario recordings");
  const process = Bun.spawn([
    ffmpeg, "-y", "-framerate", "1", "-pattern_type", "glob", "-i", join(framesDir, "*.jpg"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", output,
  ], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(`ffmpeg failed: ${stderr.slice(-800)}`);
}

async function runStage(
  name: string,
  goal: string,
  create: Parameters<typeof Agent.create>[0],
  framesDir: string,
  frameCounter: { value: number },
  verifier?: (snapshot: AgentSnapshot) => boolean,
): Promise<{ agent: Agent; snapshot: AgentSnapshot; verified: boolean }> {
  const agent = await Agent.create({ ...create, goal, screenshots: true, keepOpen: true });
  let snapshot = agent.snapshot();
  let verified = verifier?.(snapshot) ?? false;
  await writeFrame(snapshot, framesDir, frameCounter);
  while (!verified && !["done", "blocked", "budget_exhausted"].includes(snapshot.status)) {
    snapshot = await agent.tick();
    await writeFrame(snapshot, framesDir, frameCounter);
    verified = verifier?.(snapshot) ?? false;
    console.log(`  ${name}: ${snapshot.history.length}/${snapshot.maxSteps} actions, ${snapshot.status}`);
  }
  return { agent, snapshot, verified };
}

async function runAttachedVerifiedStage(
  name: string,
  goals: string[],
  create: Parameters<typeof Agent.create>[0],
  framesDir: string,
  frameCounter: { value: number },
  verifier: (snapshot: AgentSnapshot) => boolean,
) {
  const attempts: ReturnType<typeof serializableSnapshot>[] = [];
  let latest: Awaited<ReturnType<typeof runStage>> | undefined;
  for (const goal of goals) {
    latest = await runStage(name, goal, create, framesDir, frameCounter, verifier);
    attempts.push(serializableSnapshot(latest.snapshot));
    if (latest.verified) return { ...latest, attempts };
    await latest.agent.close();
    console.log(`  ${name}: verifier rejected ${latest.snapshot.status}; retrying with a more explicit goal`);
  }
  return { ...latest!, attempts };
}

async function cleanRun(
  index: number,
  options: Options,
  baseUrl: string,
  suiteDir: string,
): Promise<{ passed: boolean; stages: StageRecord[]; video: string }> {
  const runDir = join(suiteDir, `run-${String(index).padStart(2, "0")}`);
  const framesDir = join(runDir, "frames");
  await mkdir(framesDir, { recursive: true });
  const frameCounter = { value: 0 };
  const stages: StageRecord[] = [];
  let targetId: string | undefined;
  let generated = "";
  let agent: Agent | undefined;
  const url = `${baseUrl}/?run=${crypto.randomUUID()}`;
  try {
    const first = await runStage("add", "Add exactly one new todo written from Han Solo's perspective. Finish when that new todo is visible.", {
      url, goal: "", cdpUrl: options.cdpUrl, maxSteps: options.maxSteps, visible: options.visible,
    }, framesDir, frameCounter, (snapshot) => addedTodoNames(
      ["Review the release notes", "Run the browser smoke test", "Share the QA summary"],
      visibleTodoNames(snapshot.page),
    ).length === 1);
    agent = first.agent;
    targetId = agent.targetId;
    const before = ["Review the release notes", "Run the browser smoke test", "Share the QA summary"];
    const additions = addedTodoNames(before, visibleTodoNames(first.snapshot.page));
    generated = additions.length === 1 ? additions[0]! : "";
    const firstAssertions = [
      assertion("stage verifier stopped the run", first.verified, `agent_status=${first.snapshot.status}`),
      assertion("exactly one todo was added", additions.length === 1, `added=${JSON.stringify(additions)}`),
      assertion("generated todo is visible", Boolean(generated) && visibleTodoNames(first.snapshot.page).includes(generated), `todo=${generated || "missing"}`),
    ];
    stages.push({ name: "add", goal: first.snapshot.goal, result: serializableSnapshot(first.snapshot), assertions: firstAssertions });
    await agent.close(); agent = undefined;
    if (firstAssertions.some((item) => !item.passed)) throw new Error("Add-stage verifier failed");

    const second = await runAttachedVerifiedStage("complete", [
      `Click the control labeled \"Mark ${generated} as done\".`,
      `The todo \"${generated}\" is visibly active, so the task is not done. CLICK its round toggle whose accessible label is \"Mark ${generated} as done\".`,
      `Execute one CLICK on the element labeled \"Mark ${generated} as done\". Do not select DONE before that click.`,
    ], {
      targetId, goal: "", cdpUrl: options.cdpUrl, maxSteps: options.maxSteps, visible: options.visible,
    }, framesDir, frameCounter, (snapshot) => todoIsCompleted(snapshot.page, generated));
    agent = second.agent;
    const secondAssertions = [
      assertion("stage verifier stopped the run", second.verified, `agent_status=${second.snapshot.status}`),
      assertion("generated todo is completed", todoIsCompleted(second.snapshot.page, generated), `todo=${generated}`),
    ];
    stages.push({ name: "complete", goal: second.snapshot.goal, result: serializableSnapshot(second.snapshot), attempts: second.attempts, assertions: secondAssertions });
    await agent.close(); agent = undefined;
    if (secondAssertions.some((item) => !item.passed)) throw new Error("Complete-stage verifier failed");

    const third = await runAttachedVerifiedStage("filter", [
      "Click the filter button labeled \"Completed\".",
      "The Completed filter is not selected, so the task is not done. CLICK the button labeled \"Completed\".",
      "Execute one CLICK on the button labeled \"Completed\". Do not select DONE before that click.",
    ], {
      targetId, goal: "", cdpUrl: options.cdpUrl, maxSteps: options.maxSteps, visible: options.visible,
    }, framesDir, frameCounter, (snapshot) => completedFilterIsSelected(snapshot.page)
      && visibleTodoNames(snapshot.page).includes(generated)
      && todoIsCompleted(snapshot.page, generated));
    agent = third.agent;
    const visible = visibleTodoNames(third.snapshot.page);
    const thirdAssertions = [
      assertion("stage verifier stopped the run", third.verified, `agent_status=${third.snapshot.status}`),
      assertion("completed filter is selected", completedFilterIsSelected(third.snapshot.page), "aria-pressed=true"),
      assertion("generated completed todo is visible", visible.includes(generated) && todoIsCompleted(third.snapshot.page, generated), `visible=${JSON.stringify(visible)}`),
    ];
    stages.push({ name: "filter", goal: third.snapshot.goal, result: serializableSnapshot(third.snapshot), attempts: third.attempts, assertions: thirdAssertions });
    await agent.close(); agent = undefined;
    const passed = stages.every((stage) => stage.assertions.every((item) => item.passed));
    await Bun.write(join(runDir, "trace.json"), `${JSON.stringify({ index, url, generated, passed, stages }, null, 2)}\n`);
    const video = join(runDir, "recording.mp4");
    await renderVideo(framesDir, video);
    return { passed, stages, video };
  } finally {
    await agent?.close();
    if (targetId) await closeChromeTarget(options.cdpUrl, targetId).catch(() => undefined);
  }
}

async function guardRun(options: Options, baseUrl: string, suiteDir: string) {
  const runDir = join(suiteDir, "guard-step-budget");
  const framesDir = join(runDir, "frames");
  await mkdir(framesDir, { recursive: true });
  const frameCounter = { value: 0 };
  const goal = "Add 20 distinct new todos, one at a time. Do not finish until all 20 are visible.";
  let agent: Agent | undefined;
  let targetId: string | undefined;
  try {
    const run = await runStage("guard", goal, {
      url: `${baseUrl}/?run=${crypto.randomUUID()}`, goal: "", cdpUrl: options.cdpUrl,
      maxSteps: options.guardSteps, visible: options.visible,
    }, framesDir, frameCounter);
    agent = run.agent;
    targetId = agent.targetId;
    const assertions = [
      assertion("run stopped at the step budget", run.snapshot.status === "budget_exhausted", `status=${run.snapshot.status}`),
      assertion("executed action count equals budget", run.snapshot.history.length === options.guardSteps, `actions=${run.snapshot.history.length}`),
    ];
    const passed = assertions.every((item) => item.passed);
    await Bun.write(join(runDir, "trace.json"), `${JSON.stringify({ goal, passed, assertions, result: serializableSnapshot(run.snapshot) }, null, 2)}\n`);
    const video = join(runDir, "recording.mp4");
    await renderVideo(framesDir, video);
    return { passed, assertions, result: serializableSnapshot(run.snapshot), video };
  } finally {
    await agent?.close();
    if (targetId) await closeChromeTarget(options.cdpUrl, targetId).catch(() => undefined);
  }
}

const options = parseArgs(Bun.argv.slice(2));
const fixture = await Bun.file(new URL("../fixture/index.html", import.meta.url)).text();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(fixture, { headers: { "content-type": "text/html" } }) });
const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const suiteDir = join(options.artifacts, stamp);
await mkdir(suiteDir, { recursive: true });
const startedAt = new Date().toISOString();
const baseUrl = `http://${server.hostname}:${server.port}`;
const runs: Awaited<ReturnType<typeof cleanRun>>[] = [];
try {
  for (let index = 1; index <= options.runs; index++) {
    console.log(`Clean run ${index}/${options.runs}`);
    runs.push(await cleanRun(index, options, baseUrl, suiteDir));
  }
  console.log("Step-budget guard run");
  const guard = await guardRun(options, baseUrl, suiteDir);
  const histories = runs.flatMap((run) => run.stages.flatMap((stage) => stage.result.history));
  const textCalls = runs.flatMap((run) => run.stages.flatMap((stage) => stage.result.textCalls));
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    source: await sourceIdentity(),
    models: { browser: process.env.TYPESAFE_MODEL ?? "jev-latest", text: process.env.TEXT_MODEL ?? "gpt-5.6-luna", reasoning: process.env.TEXT_MODEL_REASONING ?? "low" },
    configuration: options,
    passed: runs.length === options.runs && runs.every((run) => run.passed) && guard.passed,
    cleanRuns: runs.map((run, index) => ({ index: index + 1, passed: run.passed, video: run.video })),
    guard: { passed: guard.passed, assertions: guard.assertions, video: guard.video },
    metrics: {
      browserDecisionCount: histories.length,
      averageBrowserDecisionLatencyMs: average(histories.map((entry) => entry.latency_ms)),
      textHelperCount: textCalls.length,
      averageTextHelperLatencyMs: average(textCalls.map((entry) => entry.latency_ms)),
      textHelperUsage: "Codex subscription CLI does not return token usage in this integration",
    },
  };
  await Bun.write(join(suiteDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.passed ? 0 : 2;
} finally {
  server.stop(true);
}
