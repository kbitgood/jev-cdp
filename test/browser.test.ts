import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import { Browser } from "../src/browser";
import { actionSpace } from "../src/model";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("semantic frame readiness, duplicate links, overlays, and redirected popup", async () => {
  if (!(await Bun.file(chrome).exists())) return;
  const child = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/slow") await Bun.sleep(700);
    if (path === "/async") return new Response('<p>Loading class</p><script>setTimeout(() => { document.body.innerHTML = \'<a href="/class">Class</a>\' }, 600)</script>', { headers: { "content-type": "text/html" } });
    if (path === "/nested-parent") return new Response('<iframe src="/nested" style="width:400px;height:200px"></iframe>', { headers: { "content-type": "text/html" } });
    if (path === "/nested") return new Response('<a href="/class">Deep class</a>', { headers: { "content-type": "text/html" } });
    return new Response('<a href="/class">Class</a>', { headers: { "content-type": "text/html" } });
  } });
  let parentPort = 0;
  const parent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/redirect") return Response.redirect(`http://127.0.0.1:${parentPort}/destination`, 302);
    if (path === "/destination") return new Response("<h1>Destination</h1>", { headers: { "content-type": "text/html" } });
    if (path === "/popup") return new Response('<a href="/redirect" target="_blank">Open class</a>', { headers: { "content-type": "text/html" } });
    if (path === "/async-parent") return new Response(`<iframe title="Lesson" src="http://127.0.0.1:${child.port}/async" style="width:600px;height:300px"></iframe>`, { headers: { "content-type": "text/html" } });
    if (path === "/nested-case") return new Response(`<iframe title="Lesson" src="http://127.0.0.1:${child.port}/nested-parent" style="width:600px;height:300px"></iframe>`, { headers: { "content-type": "text/html" } });
    if (path === "/overlay") return new Response('<a id="covered" href="/class" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Class</a><div style="position:absolute;left:20px;top:20px;width:120px;height:40px;background:yellow">Overlay</div>', { headers: { "content-type": "text/html" } });
    return new Response(`<a href="/class">Class</a><p>Loading class</p><iframe title="Lesson" src="http://127.0.0.1:${child.port}/slow" style="width:600px;height:300px"></iframe>`, { headers: { "content-type": "text/html" } });
  } });
  parentPort = parent.port ?? 0;
  const profile = await mkdtemp(join(tmpdir(), "jev-cdp-browser-test-"));
  const process = Bun.spawn([chrome, "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`], { stdout: "ignore", stderr: "ignore" });
  let agent: Agent | undefined;
  let browser: Browser | undefined;
  try {
    let port = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!; break; }
      catch { await Bun.sleep(50); }
    }
    expect(port).not.toBe("");
    const cdpUrl = `http://127.0.0.1:${port}`;
    agent = await Agent.create({ cdpUrl, url: `http://127.0.0.1:${parent.port}/`, goal: "Open the class in the lesson", maxSteps: 1, waitBudgetMs: 5_000 });
    const state = agent.snapshot();
    expect(state.status).toBe("ready");
    expect(state.history).toHaveLength(0);
    expect(state.page.actions.some(action => action.kind === "wait")).toBe(false);
    expect(state.page.frames).toHaveLength(2);
    expect(state.page.frames[1]?.url).toContain(`/slow`);
    expect(state.page.frames[1]?.loading).toBe(false);
    const classes = state.elements.filter(element => element.label === "Class");
    expect(classes).toHaveLength(2);
    expect(classes[0]?.frameId).toBeNull();
    expect(classes[1]?.frameId).not.toBeNull();
    expect(classes[1]?.bounds).toBeTruthy();
    expect(actionSpace(state.page.actions).elements.filter(element => element.label === "Class")).toHaveLength(2);
    await agent.close(); agent = undefined;

    browser = await Browser.open({ cdpUrl, url: `http://127.0.0.1:${parent.port}/nested-case`, waitBudgetMs: 5_000 });
    const nested = await browser.waitForSemanticReady(await browser.observe());
    expect(nested.frames).toHaveLength(3);
    expect(nested.actions.some(action => action.label === "Deep class" && action.frameId === nested.frames[2]?.id)).toBe(true);
    expect(await browser.fresh(nested)).toBe(true);
    await browser.close(); browser = undefined;

    agent = await Agent.create({ cdpUrl, url: `http://127.0.0.1:${parent.port}/async-parent`, goal: "Open class", maxSteps: 1, waitBudgetMs: 2_000 });
    expect(agent.snapshot().status).toBe("ready");
    expect(agent.snapshot().history).toHaveLength(0);
    expect(agent.snapshot().elements.some(element => element.label === "Class" && element.frameId)).toBe(true);
    await agent.close(); agent = undefined;

    agent = await Agent.create({ cdpUrl, url: `http://127.0.0.1:${parent.port}/async-parent`, goal: "Open class", maxSteps: 1, waitBudgetMs: 150 });
    expect(agent.snapshot().status).toBe("wait_timeout");
    expect(agent.snapshot().history).toHaveLength(0);
    expect(agent.snapshot().waitTimeout?.pendingCondition).toBe("embedded content loading");
    expect(agent.snapshot().page.frames).toHaveLength(2);
    await agent.close(); agent = undefined;

    const timedRun = Bun.spawn([Bun.which("bun")!, "src/cli.ts", "run", "--cdp", cdpUrl,
      "--url", `http://127.0.0.1:${parent.port}/async-parent`, "--goal", "Open class",
      "--max-steps", "1", "--wait-budget-ms", "150"],
    { cwd: import.meta.dir.replace(/\/test$/, ""), stdout: "pipe", stderr: "pipe" });
    const [timedOutput, timedExit] = await Promise.all([new Response(timedRun.stdout).text(), timedRun.exited]);
    expect(timedExit).toBe(2);
    const timedResult = JSON.parse(timedOutput.trim());
    expect(timedResult.status).toBe("wait_timeout");
    expect(timedResult.budget.used).toBe(0);
    expect(timedResult.finalState.frameTree[0].children).toHaveLength(1);

    browser = await Browser.open({ cdpUrl, url: `http://127.0.0.1:${parent.port}/overlay`, waitBudgetMs: 5_000 });
    const overlay = await browser.observe();
    const covered = overlay.actions.find(action => action.node && action.label === "Class");
    expect(covered?.clickable).toBe(false);
    expect(covered?.coveredBy?.text).toContain("Overlay");
    await browser.close(); browser = undefined;

    browser = await Browser.open({ cdpUrl, url: `http://127.0.0.1:${parent.port}/popup`, waitBudgetMs: 5_000 });
    const before = await browser.observe();
    const open = before.actions.find(action => action.kind === "click" && action.label === "Open class")!;
    await browser.act(open, before);
    const after = await browser.waitForSemanticReady(await browser.observe());
    expect(after.transitions.some(transition => transition.kind === "new_tab" && transition.control === "Open class"
      && transition.targetId === browser!.targetId && transition.destinationUrl.endsWith("/destination") && transition.settled)).toBe(true);
    expect(after.transitions.some(transition => transition.kind === "redirect" && transition.control === "Open class"
      && transition.fromUrl.endsWith("/redirect") && transition.destinationUrl.endsWith("/destination") && transition.settled)).toBe(true);
  } finally {
    await browser?.close();
    await agent?.close();
    process.kill();
    await process.exited;
    child.stop(true); parent.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}, 30_000);
