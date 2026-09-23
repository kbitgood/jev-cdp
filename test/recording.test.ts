import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser";

test("records URL changes and new-tab notices at zero and one-second pauses in 720p", async () => {
  const chrome = Bun.which("chromium") ?? Bun.which("google-chrome") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!Bun.which("ffmpeg") || !Bun.which("ffprobe") || !(await Bun.file(chrome).exists())) return;
  const directory = await mkdtemp(join(tmpdir(), "jev-cdp-browser-recording-"));
  const output = join(directory, "recording.mp4");
  const screenshot = join(directory, "final.jpg");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(path === "/new" ? "<h1>New tab</h1>" : '<a href="/new" target="_blank">Open new tab</a>',
      { headers: { "content-type": "text/html" } });
  } });
  const process = Bun.spawn([chrome, "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${directory}`], { stdout: "ignore", stderr: "ignore" });
  let browser: Browser | undefined;
  try {
    let port = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]!; break; }
      catch { await Bun.sleep(50); }
    }
    expect(port).not.toBe("");
    browser = await Browser.open({ cdpUrl: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${server.port}/`, recordingPath: output,
      screenshotPath: screenshot, interactionPauses: 0 });
    const page = await browser.observe();
    expect({ width: page.w, height: page.h }).toEqual({ width: 1506, height: 800 });
    await browser.act(page.actions.find(action => action.label === "Open new tab")!, page);
    const next = await browser.observe();
    expect(next.url).toEndWith("/new");
    await browser.close();
    browser = undefined;
    expect((await Bun.file(output).size)).toBeGreaterThan(0);
    const decoded = Bun.spawnSync([Bun.which("ffmpeg")!, "-v", "error", "-i", output, "-f", "null", "-"], { stdout: "pipe", stderr: "pipe" });
    expect(decoded.exitCode).toBe(0);
    expect(decoded.stderr.toString()).toBe("");
    for (const file of [output, screenshot]) {
      const probe = Bun.spawnSync([Bun.which("ffprobe")!, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
        "-of", "csv=p=0", file], { stdout: "pipe", stderr: "pipe" });
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.toString().trim().replace(/,+$/, "")).toBe("1280,720");
    }
    const noticePixel = (file: string, still = false) => Bun.spawnSync([Bun.which("ffmpeg")!, "-v", "error", "-i", file,
      "-vf", "crop=1:1:358:35:exact=1", ...(still ? ["-frames:v", "1"] : ["-vsync", "0"]),
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe", stderr: "pipe" });
    const isBlue = (pixels: Uint8Array, offset: number) => pixels[offset + 2]! > pixels[offset]! + 70;
    const videoPixel = noticePixel(output);
    expect(videoPixel.exitCode).toBe(0);
    expect(Array.from({ length: videoPixel.stdout.length / 3 }, (_, index) => isBlue(videoPixel.stdout, index * 3)).filter(Boolean)).toHaveLength(1);
    const screenshotPixel = noticePixel(screenshot, true);
    expect(screenshotPixel.exitCode).toBe(0);
    expect(isBlue(screenshotPixel.stdout, 0)).toBe(true);
    const heldVideo = join(directory, "one-second-notice.mp4");
    browser = await Browser.open({ cdpUrl: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${server.port}/`,
      recordingPath: heldVideo, interactionPauses: 1_000 });
    const heldPage = await browser.observe();
    await browser.act(heldPage.actions.find(action => action.label === "Open new tab")!, heldPage);
    const switchStarted = performance.now();
    expect((await browser.observe()).url).toEndWith("/new");
    expect(performance.now() - switchStarted).toBeGreaterThanOrEqual(950);
    await browser.close();
    browser = undefined;
    const heldPixels = noticePixel(heldVideo);
    expect(heldPixels.exitCode).toBe(0);
    const blueFrames = Array.from({ length: heldPixels.stdout.length / 3 }, (_, index) => isBlue(heldPixels.stdout, index * 3));
    const firstBlue = blueFrames.indexOf(true);
    const firstAfter = blueFrames.findIndex((blue, index) => index > firstBlue && !blue);
    expect(firstBlue).toBeGreaterThanOrEqual(0);
    expect(firstAfter).toBeGreaterThan(firstBlue);
    const frameTimes = Bun.spawnSync([Bun.which("ffprobe")!, "-v", "error", "-select_streams", "v:0",
      "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", heldVideo], { stdout: "pipe", stderr: "pipe" });
    const times = frameTimes.stdout.toString().trim().split("\n").map(line => Number.parseFloat(line));
    expect(times[firstAfter]! - times[firstBlue]!).toBeGreaterThanOrEqual(0.96);
    const screenshotOnly = join(directory, "screenshot-only.jpg");
    browser = await Browser.open({ cdpUrl: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${server.port}/`, screenshotPath: screenshotOnly });
    await browser.evaluate("history.pushState({}, '', '/changed')");
    expect((await browser.observe()).url).toEndWith("/changed");
    await browser.close();
    browser = undefined;
    const stillProbe = Bun.spawnSync([Bun.which("ffprobe")!, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
      "-of", "csv=p=0", screenshotOnly], { stdout: "pipe", stderr: "pipe" });
    expect(stillProbe.stdout.toString().trim().replace(/,+$/, "")).toBe("1280,720");
    const urlChangeVideo = join(directory, "url-change.mp4");
    browser = await Browser.open({ cdpUrl: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${server.port}/`, recordingPath: urlChangeVideo });
    await browser.evaluate("history.pushState({}, '', '/changed')");
    await browser.close();
    browser = undefined;
    const headers = Bun.spawnSync([Bun.which("ffmpeg")!, "-v", "error", "-i", urlChangeVideo,
      "-vf", "crop=1280:40:0:0", "-vsync", "0", "-f", "framemd5", "-"], { stdout: "pipe", stderr: "pipe" });
    expect(headers.exitCode).toBe(0);
    const hashes = headers.stdout.toString().split("\n").filter(line => line && !line.startsWith("#"))
      .map(line => line.split(",").at(-1)!.trim());
    expect(new Set(hashes).size).toBeGreaterThanOrEqual(2);
  } finally {
    await browser?.close().catch(() => undefined);
    process.kill();
    await process.exited;
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
