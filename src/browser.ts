import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CdpClient, listChromeTargets } from "./cdp";
import READ_STATE from "./snapshot.js" with { type: "text" };
import type { BrowserAction, JsonValue, PageState } from "./types";

const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;
const RECORDING_CURSOR_INIT = `(() => {
  if (window !== window.top) return;
  const mount = () => {
    if (!document.documentElement) return false;
    if (document.getElementById('__jev-recording-cursor')) return true;
    const cursor = document.createElement('div');
    cursor.id = '__jev-recording-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML = '<svg width="28" height="34" viewBox="0 0 28 34" xmlns="http://www.w3.org/2000/svg"><path d="M2 2v25l7-7 5 11 5-2-5-11h10z" fill="white" stroke="#111827" stroke-width="2.5" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {position:'fixed',left:'50vw',top:'50vh',width:'28px',height:'34px',zIndex:'2147483647',pointerEvents:'none',filter:'drop-shadow(0 2px 2px rgba(0,0,0,.35))',transition:'left 180ms cubic-bezier(.2,.8,.2,1), top 180ms cubic-bezier(.2,.8,.2,1)',transform:'translate(-3px,-3px)'});
    document.documentElement.append(cursor);
    return true;
  };
  if (!mount()) {
    const observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
    observer.observe(document, { childList: true });
  }
})()`;

export class StalePageError extends Error {}

export interface BrowserOptions {
  cdpUrl: string;
  url?: string;
  targetId?: string;
  visible?: boolean;
  keepOpen?: boolean;
  screenshots?: boolean;
  recordingPath?: string;
  screenshotPath?: string;
  freshContext?: boolean;
  interactionPauses?: number;
}

interface RecordingFrame {
  path: string;
  elapsedMs: number;
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function fingerprint(page: Pick<PageState, "url" | "text" | "actions" | "scroll">): string {
  return createHash("sha256")
    .update(stableStringify({ url: page.url, text: page.text, actions: page.actions, scroll: page.scroll }))
    .digest("hex");
}

export class Browser {
  readonly #cdp: CdpClient;
  readonly #sessionId: string;
  readonly #targetId: string;
  readonly #ownsTarget: boolean;
  readonly #keepOpen: boolean;
  readonly #screenshots: boolean;
  readonly #interactionPauses: number;
  readonly #browserContextId?: string;
  readonly #recordingPath?: string;
  readonly #screenshotPath?: string;
  #afterInput: BrowserAction | null = null;
  #closed = false;
  #recordingDirectory?: string;
  #recordingFrames: RecordingFrame[] = [];
  #recordingStartedAt = 0;
  #recordingSequence = 0;
  #recordingWrites: Promise<void> = Promise.resolve();
  #stopRecordingEvents?: () => void;
  #stopPageEvents: (() => void)[] = [];
  #mainFrameId?: string;
  #pageLoadPromise: Promise<void> | null = null;
  #resolvePageLoad?: () => void;
  #pauseUntil = 0;

  private constructor(
    cdp: CdpClient,
    sessionId: string,
    targetId: string,
    ownsTarget: boolean,
    browserContextId: string | undefined,
    options: BrowserOptions,
  ) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#ownsTarget = ownsTarget;
    this.#browserContextId = browserContextId;
    this.#keepOpen = options.keepOpen ?? false;
    this.#screenshots = options.screenshots ?? false;
    this.#interactionPauses = options.interactionPauses ?? 0;
    this.#recordingPath = options.recordingPath ? resolve(options.recordingPath) : undefined;
    this.#screenshotPath = options.screenshotPath ? resolve(options.screenshotPath) : undefined;
  }

  static async open(options: BrowserOptions): Promise<Browser> {
    const cdp = await CdpClient.connect(options.cdpUrl);
    let targetId = options.targetId;
    const ownsTarget = !targetId;
    let browserContextId: string | undefined;

    if (targetId && options.freshContext) {
      cdp.close();
      throw new Error("--fresh-context cannot be combined with --tab");
    }

    if (targetId) {
      const target = (await listChromeTargets(options.cdpUrl)).find((candidate) => candidate.id === targetId);
      if (!target || target.type !== "page") {
        cdp.close();
        throw new Error(`Chrome page target not found: ${targetId}`);
      }
    } else {
      if (!options.url) {
        cdp.close();
        throw new Error("--url is required when creating a new Chrome tab");
      }
      try {
        if (options.freshContext) {
          const context = await cdp.command<{ browserContextId: string }>("Target.createBrowserContext");
          browserContextId = context.browserContextId;
        }
        const created = await cdp.command<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
          background: !(options.visible ?? false),
          ...(browserContextId ? { browserContextId } : {}),
        });
        targetId = created.targetId;
      } catch (error) {
        if (browserContextId) await cdp.command("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
        cdp.close();
        throw error;
      }
    }

    if (options.visible) await cdp.command("Target.activateTarget", { targetId });
    const attached = await cdp.command<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const browser = new Browser(cdp, attached.sessionId, targetId, ownsTarget, browserContextId, options);

    try {
      await browser.call("Emulation.setDeviceMetricsOverride", {
        width: 1120,
        height: 780,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      await browser.watchPageLoads();
      if (options.url) await browser.call("Page.navigate", { url: options.url });
      await browser.waitForReady();
      browser.#pauseUntil = performance.now() + browser.#interactionPauses;
      await browser.startRecording();
      return browser;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  private call<T extends object = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.#cdp.command<T>(method, params, this.#sessionId, timeoutMs);
  }

  get targetId(): string {
    return this.#targetId;
  }

  private async watchPageLoads(): Promise<void> {
    if (!this.#interactionPauses) return;
    await this.call("Page.enable");
    const tree = await this.call<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    this.#mainFrameId = tree.frameTree.frame.id;
    const loading = (params: Record<string, unknown>) => {
      if (params.frameId !== this.#mainFrameId || this.#pageLoadPromise) return;
      this.#pageLoadPromise = new Promise<void>((resolve) => { this.#resolvePageLoad = resolve; });
    };
    const loaded = () => {
      if (!this.#pageLoadPromise) return;
      this.#pauseUntil = performance.now() + this.#interactionPauses;
      this.#resolvePageLoad?.();
      this.#resolvePageLoad = undefined;
      this.#pageLoadPromise = null;
    };
    this.#stopPageEvents.push(
      this.#cdp.on("Page.frameStartedLoading", this.#sessionId, loading),
      this.#cdp.on("Page.frameNavigated", this.#sessionId, (params) => {
        const frame = params.frame as { id?: string; parentId?: string } | undefined;
        if (frame && frame.id === this.#mainFrameId && !frame.parentId) loading({ frameId: frame.id });
      }),
      this.#cdp.on("Page.loadEventFired", this.#sessionId, loaded),
      this.#cdp.on("Page.frameStoppedLoading", this.#sessionId, (params) => {
        if (params.frameId === this.#mainFrameId) loaded();
      }),
      this.#cdp.on("Page.navigatedWithinDocument", this.#sessionId, (params) => {
        if (params.frameId === this.#mainFrameId) {
          this.#pauseUntil = performance.now() + this.#interactionPauses;
          void this.resetRecordingCursor().catch(() => undefined);
        }
      }),
    );
  }

  async waitForInteractionPause(): Promise<void> {
    if (!this.#interactionPauses) return;
    while (true) {
      const pageLoad = this.#pageLoadPromise;
      if (pageLoad) {
        await Promise.race([
          pageLoad,
          Bun.sleep(15_000).then(() => { throw new Error("Page did not finish loading within 15 seconds"); }),
        ]);
        continue;
      }
      const remaining = this.#pauseUntil - performance.now();
      if (remaining <= 0) return;
      await Bun.sleep(remaining);
    }
  }

  private async startRecording(): Promise<void> {
    if (!this.#recordingPath) return;
    if (!Bun.which("ffmpeg")) throw new Error("--recording requires ffmpeg on PATH");
    this.#recordingDirectory = await mkdtemp(join(tmpdir(), "jev-cdp-recording-"));
    await this.call("Page.enable");
    await this.call("Page.addScriptToEvaluateOnNewDocument", { source: RECORDING_CURSOR_INIT });
    const viewport = await this.evaluate<{ width: number; height: number }>(
      "({width: innerWidth, height: innerHeight})",
    );
    if (!viewport) throw new Error("Could not read the recording viewport");
    await this.animateCursor(viewport.width / 2, viewport.height / 2);
    const initial = await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const initialPath = join(this.#recordingDirectory, "000000.jpg");
    await Bun.write(initialPath, Buffer.from(initial.data, "base64"));
    this.#recordingFrames.push({ path: initialPath, elapsedMs: 0 });
    this.#recordingSequence = 1;
    this.#recordingStartedAt = performance.now();
    this.#stopRecordingEvents = this.#cdp.on("Page.screencastFrame", this.#sessionId, (params) => {
      const frame = params as unknown as ScreencastFrame;
      void this.call("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      const sequence = this.#recordingSequence++;
      const path = join(this.#recordingDirectory!, `${String(sequence).padStart(6, "0")}.jpg`);
      const elapsedMs = sequence ? performance.now() - this.#recordingStartedAt : 0;
      this.#recordingWrites = this.#recordingWrites.then(async () => {
        await Bun.write(path, Buffer.from(frame.data, "base64"));
        this.#recordingFrames.push({ path, elapsedMs });
      });
    });
    await this.call("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1120,
      maxHeight: 780,
      everyNthFrame: 3,
    });
  }

  private async finishRecording(): Promise<void> {
    if (!this.#recordingPath || !this.#recordingDirectory) return;
    try {
      await this.call("Page.stopScreencast");
    } finally {
      this.#stopRecordingEvents?.();
      this.#stopRecordingEvents = undefined;
    }
    await this.#recordingWrites;
    if (!this.#recordingFrames.length) throw new Error("Recording produced no browser frames");
    await mkdir(dirname(this.#recordingPath), { recursive: true });
    const finishedAt = performance.now() - this.#recordingStartedAt;
    const quoted = (path: string) => path.replaceAll("'", "'\\''");
    const lines = ["ffconcat version 1.0"];
    for (let index = 0; index < this.#recordingFrames.length; index++) {
      const frame = this.#recordingFrames[index]!;
      const next = this.#recordingFrames[index + 1];
      const duration = Math.max(0.04, ((next?.elapsedMs ?? finishedAt) - frame.elapsedMs) / 1000);
      lines.push(`file '${quoted(frame.path)}'`, `duration ${duration.toFixed(4)}`);
    }
    lines.push(`file '${quoted(this.#recordingFrames.at(-1)!.path)}'`);
    const manifest = join(this.#recordingDirectory, "frames.ffconcat");
    await Bun.write(manifest, `${lines.join("\n")}\n`);
    const process = Bun.spawn([
      Bun.which("ffmpeg")!, "-y", "-f", "concat", "-safe", "0", "-i", manifest,
      "-vsync", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      this.#recordingPath,
    ], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(process.stderr).text();
    if (await process.exited !== 0) throw new Error(`Could not render recording: ${stderr.slice(-800)}`);
    await rm(this.#recordingDirectory, { recursive: true, force: true });
    this.#recordingDirectory = undefined;
  }

  private async saveFinalScreenshot(): Promise<void> {
    if (!this.#screenshotPath) return;
    await mkdir(dirname(this.#screenshotPath), { recursive: true });
    if (this.#recordingDirectory) {
      await this.#recordingWrites;
      const finalFrame = this.#recordingFrames.at(-1);
      if (finalFrame) {
        await Bun.write(this.#screenshotPath, Bun.file(finalFrame.path));
        return;
      }
    }
    const capture = await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    await Bun.write(this.#screenshotPath, Buffer.from(capture.data, "base64"));
  }

  private async animateCursor(x: number, y: number, click = false): Promise<void> {
    if (!this.#recordingPath) return;
    await this.evaluate(RECORDING_CURSOR_INIT);
    await this.evaluate(`(point => {
      const cursor=document.getElementById('__jev-recording-cursor');
      if (!cursor) return;
      cursor.style.left=point.x+'px'; cursor.style.top=point.y+'px';
      if (point.click) cursor.animate([{transform:'translate(-3px,-3px) scale(1)'},{transform:'translate(-3px,-3px) scale(.72)'},{transform:'translate(-3px,-3px) scale(1)'}],{duration:260,easing:'ease-out'});
    })(${JSON.stringify({ x, y, click })})`);
    await Bun.sleep(click ? 80 : 200);
  }

  private async resetRecordingCursor(): Promise<void> {
    if (!this.#recordingPath) return;
    await this.evaluate(`${RECORDING_CURSOR_INIT}; (() => {
      const cursor = document.getElementById('__jev-recording-cursor');
      if (!cursor) return;
      cursor.style.transition = 'none';
      cursor.style.left = '50vw';
      cursor.style.top = '50vh';
      requestAnimationFrame(() => { cursor.style.transition = 'left 180ms cubic-bezier(.2,.8,.2,1), top 180ms cubic-bezier(.2,.8,.2,1)'; });
    })()`);
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        if (!this.#pageLoadPromise && await this.evaluate<string>("document.readyState") === "complete") return;
      } catch (error) {
        if (!(error instanceof StalePageError)) throw error;
      }
      await Bun.sleep(20);
    }
    throw new Error("Page did not finish loading within 15 seconds");
  }

  async evaluate<T>(expression: string, awaitPromise = false): Promise<T | undefined> {
    const response = await this.call<{
      result?: { value?: T };
      exceptionDetails?: object;
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, awaitPromise ? 15_000 : undefined);
    if (response.exceptionDetails) throw new StalePageError("Document changed during evaluation");
    return response.result?.value;
  }

  private async settleAfterInput(): Promise<void> {
    const action = this.#afterInput;
    this.#afterInput = null;
    if (!action) return;
    const expression = `(action => new Promise(resolve => {
      const field=window.__jevFast?.nodes.get(action.node);
      const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
      let frames=0, stopped=false;
      const finish=()=>{stopped=true;resolve()};
      setTimeout(finish,autocomplete ? 200 : 50);
      const ready=()=>{
        if (stopped) return;
        const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
          .split(/\s+/).filter(Boolean);
        const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
        const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
        if (++frames>=2 && (!autocomplete || options.some(e=>{
          const r=e.getBoundingClientRect();
          return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
            e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
        }))) finish();
        else requestAnimationFrame(ready);
      };
      requestAnimationFrame(ready);
    }))(${JSON.stringify(action)})`;
    try {
      await this.evaluate(expression, true);
    } catch (error) {
      if (!(error instanceof StalePageError)) throw error;
    }
  }

  async observe(screenshot = this.#screenshots): Promise<PageState> {
    await this.settleAfterInput();
    let info: Omit<PageState, "fingerprint"> | null | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        info = await this.evaluate<Omit<PageState, "fingerprint"> | null>(READ_STATE);
        if (info) break;
      } catch (error) {
        if (!(error instanceof StalePageError) || attempt === 9) throw error;
      }
      await Bun.sleep(20);
    }
    if (!info) throw new StalePageError("Document is navigating");
    const page: PageState = { ...info, fingerprint: fingerprint(info) };
    if (screenshot) {
      const capture = await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 72 });
      page.screenshot = capture.data;
    }
    return page;
  }

  async fresh(page: PageState, action?: BrowserAction): Promise<boolean> {
    if (action && (action.kind === "click" || action.kind === "select")) {
      if (typeof action.node !== "number") return false;
      const current = await this.evaluate<JsonValue>(`(() => {
        const c=window.__jevFast;
        return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null;
      })()`);
      return stableStringify(current) === stableStringify([page.page_key, page.guards[String(action.node)]]);
    }
    const marker = await this.evaluate<JsonValue>(MARKER);
    return stableStringify(marker) === stableStringify(page.marker);
  }

  async act(action: BrowserAction, page: PageState, text?: string): Promise<void> {
    if (!(await this.fresh(page, action))) throw new StalePageError("Page changed since this decision");
    if (action.kind === "wait") {
      await Bun.sleep(100);
      return;
    }
    if (action.kind === "scroll") {
      await this.animateCursor(550, 650);
      await this.call("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta ?? 0,
      });
      return;
    }
    if (typeof action.node !== "number") throw new Error("Invalid observed node");

    const target = await this.evaluate<{ x: number; y: number } | null>(`(action => {
      const e=window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
          !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
      if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
      const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
      if (!e.contains(document.elementFromPoint(x,y))) return null;
      if (action.kind==='select') {
        if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
            !o.disabled && !o.closest('optgroup[disabled]'))) return null;
        e.value=action.value;
        e.dispatchEvent(new Event('input',{bubbles:true}));
        e.dispatchEvent(new Event('change',{bubbles:true}));
      }
      return {x,y};
    })(${JSON.stringify(action)})`);
    if (!target) {
      if (action.kind === "select") throw new Error("Dropdown execution was not confirmed");
      throw new StalePageError("Target changed or is covered");
    }
    await this.animateCursor(target.x, target.y);
    if (action.kind !== "select") {
      if (action.kind === "click" && this.#interactionPauses > 0) {
        await this.call("Input.dispatchMouseEvent", {
          type: "mouseMoved", x: target.x, y: target.y,
        });
        await Bun.sleep(this.#interactionPauses);
      }
      for (const type of ["mousePressed", "mouseReleased"]) {
        await this.call("Input.dispatchMouseEvent", {
          type, x: target.x, y: target.y, button: "left", clickCount: 1,
        });
        if (type === "mousePressed") await this.animateCursor(target.x, target.y, true);
      }
      if (action.kind === "fill") {
        const modifiers = process.platform === "darwin" ? 4 : 2;
        await this.call("Input.dispatchKeyEvent", {
          type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"],
        });
        await this.call("Input.dispatchKeyEvent", {
          type: "keyUp", key: "a", code: "KeyA", modifiers,
        });
        await this.call("Input.insertText", { text: text ?? "" });
      }
    }
    this.#afterInput = action;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const stop of this.#stopPageEvents) stop();
    this.#stopPageEvents = [];
    let failure: unknown;
    try {
      if (this.#recordingPath) await Bun.sleep(400);
      await this.saveFinalScreenshot();
      await this.finishRecording();
    } catch (error) {
      failure = error;
    }
    try {
      if (this.#browserContextId && !this.#keepOpen) {
        await this.#cdp.command("Target.disposeBrowserContext", { browserContextId: this.#browserContextId });
      } else if (this.#ownsTarget && !this.#keepOpen) {
        await this.#cdp.command("Target.closeTarget", { targetId: this.#targetId });
      } else {
        await this.#cdp.command("Target.detachFromTarget", { sessionId: this.#sessionId });
      }
    } catch (error) {
      failure ??= error;
    } finally {
      this.#cdp.close();
    }
    if (failure) throw failure;
  }
}
