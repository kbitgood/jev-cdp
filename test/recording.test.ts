import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser";

test("records a browser screencast and produces a decodable MP4", async () => {
  const chrome = Bun.which("chromium") ?? Bun.which("google-chrome") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!Bun.which("ffmpeg") || !(await Bun.file(chrome).exists())) return;
  const directory = await mkdtemp(join(tmpdir(), "jev-cdp-browser-recording-"));
  const output = join(directory, "recording.mp4");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<h1>Recording test</h1>", { headers: { "content-type": "text/html" } }) });
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
    browser = await Browser.open({ cdpUrl: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${server.port}/`, recordingPath: output });
    await Bun.sleep(150);
    await browser.close();
    browser = undefined;
    expect((await Bun.file(output).size)).toBeGreaterThan(0);
    const decoded = Bun.spawnSync([Bun.which("ffmpeg")!, "-v", "error", "-i", output, "-f", "null", "-"], { stdout: "pipe", stderr: "pipe" });
    expect(decoded.exitCode).toBe(0);
    expect(decoded.stderr.toString()).toBe("");
  } finally {
    await browser?.close().catch(() => undefined);
    process.kill();
    await process.exited;
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
