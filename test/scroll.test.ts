import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, StalePageError } from "../src/browser";
import { actionEvent } from "../src/cli";
import type { HistoryEntry } from "../src/types";

const chrome = Bun.env.CHROME_PATH ??
  Bun.which("chromium") ?? Bun.which("google-chrome") ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test.skipIf(!(await Bun.file(chrome).exists()))(
  "scrolls fixed panels with locked zero-height roots, including inside an iframe",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "jev-cdp-scroll-"));
    const panelHtml = `<!doctype html>
      <style>
        html,body { margin:0; height:0; overflow:hidden }
        #panel {
          position:fixed; left:80px; top:80px;
          width:340px; height:260px; overflow-y:auto;
        }
        #content {
          height:700px; display:flex;
          flex-direction:column; justify-content:space-between;
        }
      </style>
      <section id="panel" aria-label="Settings">
        <div id="content">
          <input aria-label="Top">
          <input aria-label="Bottom">
        </div>
      </section>`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const html = new URL(request.url).pathname === "/frame"
          ? `<iframe src="/panel" style="position:fixed;left:500px;top:100px;
              width:500px;height:500px;border:0"></iframe>`
          : panelHtml;
        return new Response(html, {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const child = Bun.spawn([
      chrome, "--headless=new", "--no-sandbox",
      "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    ], { stdout: "ignore", stderr: "ignore" });
    let browser: Browser | undefined;

    try {
      let port = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          port = (await readFile(
            join(profile, "DevToolsActivePort"), "utf8",
          )).split("\n")[0]!;
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      expect(port).not.toBe("");

      const waitUntil = async (expression: string) => {
        for (let attempt = 0; attempt < 80; attempt++) {
          if (await browser!.evaluate<boolean>(expression)) return;
          await Bun.sleep(25);
        }
        throw new Error(`Scroll did not settle: ${expression}`);
      };

      for (const embedded of [false, true]) {
        browser = await Browser.open({
          cdpUrl: `http://127.0.0.1:${port}`,
          url: `http://127.0.0.1:${server.port}/${embedded ? "frame" : "panel"}`,
          waitBudgetMs: 5_000,
        });
        const doc = embedded
          ? "document.querySelector('iframe').contentDocument"
          : "document";
        const panel = `(${doc}).getElementById('panel')`;
        const initial = await browser.waitForSemanticReady(await browser.observe());
        const down = initial.actions.find(action =>
          action.kind === "scroll" && typeof action.node === "number" &&
          action.delta! > 0 && Boolean(action.frameId) === embedded
        )!;
        expect(down).toBeDefined();
        expect(initial.actions.some(action =>
          action.kind === "scroll" && action.delta! < 0
        )).toBe(false);
        expect(await browser.evaluate<number>(`(${doc}).body.getBoundingClientRect().height`))
          .toBe(0);

        await browser.evaluate(`${panel}.scrollTop = 1`);
        expect(await browser.fresh(initial, down)).toBe(false);
        const staleError = await browser.act(down, initial).catch(error => error);
        expect(staleError).toBeInstanceOf(StalePageError);
        await browser.evaluate(`${panel}.scrollTop = 0`);

        const uncovered = await browser.observe();
        const currentDown = uncovered.actions.find(action =>
          action.kind === "scroll" && action.delta! > 0
        )!;
        const cover = '<div id="cover" style="position:fixed;inset:0;z-index:999"></div>';
        await browser.evaluate(
          `(${doc}).body.insertAdjacentHTML("beforeend", ${JSON.stringify(cover)})`,
        );
        const coveredError = await browser.act(currentDown, uncovered).catch(error => error);
        expect(coveredError).toBeInstanceOf(StalePageError);
        const covered = await browser.observe();
        expect(covered.actions.some(action => action.kind === "scroll")).toBe(false);
        await browser.evaluate(`(${doc}).getElementById('cover').remove()`);

        const before = await browser.observe();
        const result = await browser.act(before.actions.find(action =>
          action.kind === "scroll" && action.delta! > 0
        )!, before);
        expect(result.scrollPoint).toEqual({
          x: embedded ? 750 : 250,
          y: embedded ? 310 : 210,
        });
        await waitUntil(
          `${panel}.scrollTop === ${panel}.scrollHeight - ${panel}.clientHeight`,
        );
        expect(await browser.fresh(before)).toBe(false);
        expect(await browser.evaluate<number>("scrollY")).toBe(0);
        expect(await browser.evaluate<number>(`(${doc}).defaultView.scrollY`)).toBe(0);

        const bottom = await browser.observe();
        expect(bottom.actions.some(action =>
          action.kind === "scroll" && action.delta! > 0
        )).toBe(false);
        expect(bottom.actions.some(action =>
          action.kind === "fill" && action.label === "Bottom" && action.clickable
        )).toBe(true);
        await browser.act(bottom.actions.find(action =>
          action.kind === "scroll" && action.delta! < 0
        )!, bottom);
        await waitUntil(`${panel}.scrollTop === 0`);
        const top = await browser.observe();
        expect(top.actions.some(action =>
          action.kind === "scroll" && action.delta! < 0
        )).toBe(false);
        expect(top.actions.some(action =>
          action.kind === "fill" && action.label === "Top" && action.clickable
        )).toBe(true);
        await browser.close();
        browser = undefined;
      }

      browser = await Browser.open({
        cdpUrl: `http://127.0.0.1:${port}`,
        url: `http://127.0.0.1:${server.port}/panel`,
      });
      await browser.evaluate(`
        document.body.style.cssText = "height:auto;overflow:auto";
        document.documentElement.style.overflow = "auto";
        document.body.innerHTML = '<div style="height:3000px">Page</div>';
      `);
      const page = await browser.observe();
      const result = await browser.act(
        page.actions.find(action => action.id === "scroll_down")!, page,
      );
      expect(result.scrollPoint).toEqual({ x: 550, y: 650 });
      await waitUntil("scrollY > 0");
    } finally {
      await browser?.close().catch(() => undefined);
      child.kill();
      await child.exited;
      server.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  },
  30_000,
);

test("scroll action JSON reports actual coordinates and supports older histories", () => {
  const entry = {
    kind: "scroll", delta_y: 560, scroll_point: { x: 250, y: 210 },
  } as HistoryEntry;
  expect(actionEvent(entry, 1).action).toMatchObject({
    deltaY: 560, point: { x: 250, y: 210 },
  });
  delete entry.scroll_point;
  expect(actionEvent(entry, 1).action).toMatchObject({
    deltaY: 560, point: { x: 550, y: 650 },
  });
});
