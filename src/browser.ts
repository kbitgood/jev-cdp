import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CdpClient, listChromeTargets } from "./cdp";
import { recordingEncoder, renderRecording } from "./ffmpeg";
import { PAGE_HEIGHT, PAGE_WIDTH, composeFrameExpression } from "./recording-visual";
import READ_STATE from "./snapshot.js" with { type: "text" };
import type { BrowserAction, ConsoleError, FrameState, JsonValue, NavigationTransition, PageState, ReplayElement } from "./types";

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
export class WaitTimeoutError extends Error {
  constructor(readonly elapsedMs: number, readonly pendingCondition: string, readonly state: PageState | null) {
    super(`Wait timed out after ${elapsedMs}ms: ${pendingCondition}`);
  }
}

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
  waitBudgetMs?: number;
}

interface RecordingFrame {
  path: string;
  elapsedMs: number;
  targetId: string;
  url: string;
  newTab: boolean;
  noticeUrl?: string;
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
}

interface ElementDetails {
  css: string;
  tag: string;
  href: string | null;
  inputType: string | null;
  frameUrl: string;
  target: string | null;
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
  #sessionId: string;
  #targetId: string;
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
  #activeUrl = "about:blank";
  #recordingUrlEvents: Array<{ elapsedMs: number; targetId: string; url: string }> = [];
  #newTabNoticeUntil = 0;
  #newTabNoticeUrl: string | null = null;
  #newTabNoticeWindows: Array<{ startMs: number; endMs: number }> = [];
  #hadNewTab = false;
  #stopRecordingEvents?: () => void;
  #stopPageEvents: (() => void)[] = [];
  #mainFrameId?: string;
  #pageLoadPromise: Promise<void> | null = null;
  #resolvePageLoad?: () => void;
  #pauseUntil = 0;
  #frameSessions = new Map<string, string>();
  #frameContexts = new Map<string, number>();
  #knownTargets = new Set<string>();
  #openedTabs: Array<{ id: string; url: string; title: string }> = [];
  #cdpUrl: string;
  #switchOnPopup = false;
  #loadingFrames = new Set<string>();
  #waitBudgetMs: number;
  #waitSpentMs = 0;
  #transitions: NavigationTransition[] = [];
  #origin: { control: string; targetId: string; url: string; href: string | null } | null = null;
  #changeListeners = new Set<() => void>();
  #targetUrls = new Map<string, string[]>();
  #newTargets = new Set<string>();
  #popupListeners = new Set<() => void>();
  #consoleErrors: ConsoleError[] = [];
  #watchedConsoleSessions = new Set<string>();

  private constructor(
    cdp: CdpClient,
    sessionId: string,
    targetId: string,
    ownsTarget: boolean,
    browserContextId: string | undefined,
    options: BrowserOptions,
  ) {
    this.#cdp = cdp;
    this.#cdpUrl = options.cdpUrl;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#ownsTarget = ownsTarget;
    this.#browserContextId = browserContextId;
    this.#keepOpen = options.keepOpen ?? false;
    this.#screenshots = options.screenshots ?? false;
    this.#interactionPauses = options.interactionPauses ?? 0;
    this.#waitBudgetMs = options.waitBudgetMs ?? 15_000;
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
    browser.#knownTargets = new Set((await listChromeTargets(options.cdpUrl)).map(target => target.id));

    try {
      const recordTargetUrl = (params: Record<string, unknown>) => {
        const info = params.targetInfo as { targetId?: string; url?: string; type?: string } | undefined;
        if (info?.type === "page" && info.targetId && !browser.#knownTargets.has(info.targetId)) {
          browser.#newTargets.add(info.targetId);
          for (const listener of browser.#popupListeners) listener();
        }
        if (!info?.targetId || !info.url || info.url === "about:blank") return;
        if (info.targetId === browser.#targetId) browser.setActiveUrl(info.url);
        const urls = browser.#targetUrls.get(info.targetId) ?? [];
        if (urls.at(-1) !== info.url) urls.push(info.url);
        browser.#targetUrls.set(info.targetId, urls);
      };
      browser.#stopPageEvents.push(
        cdp.on("Target.targetCreated", "", recordTargetUrl),
        cdp.on("Target.targetInfoChanged", "", recordTargetUrl),
      );
      await cdp.command("Target.setDiscoverTargets", { discover: true });
      browser.#stopPageEvents.push(cdp.on("Target.attachedToTarget", browser.#sessionId, (params) => {
        const info = params.targetInfo as { type?: string; targetId?: string } | undefined;
        if (info?.type === "iframe" && info.targetId && typeof params.sessionId === "string") {
          browser.#frameSessions.set(info.targetId, params.sessionId);
          void browser.watchConsole(params.sessionId, info.targetId).catch(() => undefined);
        }
      }));
      browser.#stopPageEvents.push(cdp.on("Page.frameNavigated", browser.#sessionId, (params) => {
        const frame = params.frame as { id?: string } | undefined;
        if (frame?.id) browser.#frameContexts.delete(frame.id);
      }));
      await browser.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await browser.watchConsole();
      await browser.call("Page.enable");
      await browser.call("Emulation.setDeviceMetricsOverride", {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      await browser.watchPageLoads();
      if (options.url) await browser.call("Page.navigate", { url: options.url });
      await browser.waitForReady();
      browser.#activeUrl = await browser.evaluate<string>("location.href") ?? browser.#activeUrl;
      browser.#pauseUntil = performance.now() + browser.#interactionPauses;
      await browser.startRecording();
      return browser;
    } catch (error) {
      await browser.close().catch(() => undefined);
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

  private setActiveUrl(url: string): void {
    if (!url || url === this.#activeUrl) return;
    this.#activeUrl = url;
    if (this.#recordingDirectory && this.#recordingFrames.length) {
      this.#recordingUrlEvents.push({ elapsedMs: performance.now() - this.#recordingStartedAt,
        targetId: this.#targetId, url });
    }
  }

  takeConsoleErrors(): ConsoleError[] {
    return this.#consoleErrors.splice(0);
  }

  pendingConsoleErrors(): ConsoleError[] {
    return [...this.#consoleErrors];
  }

  private async watchConsole(sessionId = this.#sessionId, targetId = this.#targetId): Promise<void> {
    if (this.#watchedConsoleSessions.has(sessionId)) return;
    this.#watchedConsoleSessions.add(sessionId);
    const record = (source: ConsoleError["source"], message: string, url?: string, timestamp?: number) => {
      if (!message.trim()) return;
      this.#consoleErrors.push({ source, message: message.slice(0, 4000), ...(url ? { url } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}), targetId });
    };
    this.#stopPageEvents.push(
      this.#cdp.on("Runtime.consoleAPICalled", sessionId, (params) => {
        if (params.type !== "error") return;
        const args = params.args as Array<{ value?: unknown; description?: string }> | undefined;
        const message = args?.map(arg => String(arg.value ?? arg.description ?? "")).join(" ") ?? "";
        const frame = (params.stackTrace as { callFrames?: Array<{ url?: string }> } | undefined)?.callFrames?.[0];
        record("console", message, frame?.url, typeof params.timestamp === "number" ? params.timestamp : undefined);
      }),
      this.#cdp.on("Runtime.exceptionThrown", sessionId, (params) => {
        const details = params.exceptionDetails as { text?: string; url?: string; exception?: { description?: string } } | undefined;
        record("exception", details?.exception?.description ?? details?.text ?? "Uncaught exception",
          details?.url, typeof params.timestamp === "number" ? params.timestamp : undefined);
      }),
      this.#cdp.on("Log.entryAdded", sessionId, (params) => {
        const entry = params.entry as { level?: string; text?: string; url?: string; timestamp?: number } | undefined;
        if (entry?.level === "error") record("log", entry.text ?? "", entry.url, entry.timestamp);
      }),
    );
    await this.#cdp.command("Runtime.enable", {}, sessionId);
    await this.#cdp.command("Log.enable", {}, sessionId);
  }

  private async watchPageLoads(): Promise<void> {
    await this.call("Page.enable");
    const tree = await this.call<{ frameTree: { frame: { id: string; url?: string } } }>("Page.getFrameTree");
    this.#mainFrameId = tree.frameTree.frame.id;
    if (tree.frameTree.frame.url) this.setActiveUrl(tree.frameTree.frame.url);
    await this.call("Runtime.addBinding", { name: "__jevDomChanged" });
    const observeDom = `(() => {
      if (window.__jevDomWatching) return;
      window.__jevDomWatching = true;
      const start = () => new MutationObserver(() => window.__jevDomChanged?.('change'))
        .observe(document, {subtree:true, childList:true, attributes:true, characterData:true});
      if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, {once:true});
    })()`;
    await this.call("Page.addScriptToEvaluateOnNewDocument", { source: observeDom });
    await this.evaluate(observeDom).catch(() => undefined);
    const loading = (params: Record<string, unknown>) => {
      if (typeof params.frameId === "string") this.#loadingFrames.add(params.frameId);
      this.signalChange();
      if (params.frameId !== this.#mainFrameId || this.#pageLoadPromise) return;
      this.#pageLoadPromise = new Promise<void>((resolve) => { this.#resolvePageLoad = resolve; });
    };
    const loaded = () => {
      if (this.#mainFrameId) this.#loadingFrames.delete(this.#mainFrameId);
      this.signalChange();
      if (!this.#pageLoadPromise) return;
      this.#pauseUntil = performance.now() + this.#interactionPauses;
      this.#resolvePageLoad?.();
      this.#resolvePageLoad = undefined;
      this.#pageLoadPromise = null;
    };
    this.#stopPageEvents.push(
      this.#cdp.on("Page.frameStartedLoading", this.#sessionId, loading),
      this.#cdp.on("Page.frameNavigated", this.#sessionId, (params) => {
        const frame = params.frame as { id?: string; parentId?: string; url?: string } | undefined;
        this.signalChange();
        if (frame && frame.id === this.#mainFrameId && !frame.parentId) {
          if (frame.url) this.setActiveUrl(frame.url);
          loading({ frameId: frame.id });
        }
      }),
      this.#cdp.on("Page.loadEventFired", this.#sessionId, loaded),
      this.#cdp.on("Page.frameStoppedLoading", this.#sessionId, (params) => {
        if (typeof params.frameId === "string") this.#loadingFrames.delete(params.frameId);
        this.signalChange();
        if (params.frameId === this.#mainFrameId) loaded();
      }),
      this.#cdp.on("Page.navigatedWithinDocument", this.#sessionId, (params) => {
        this.signalChange();
        if (params.frameId === this.#mainFrameId) {
          if (typeof params.url === "string") this.setActiveUrl(params.url);
          this.#pauseUntil = performance.now() + this.#interactionPauses;
          void this.resetRecordingCursor().catch(() => undefined);
        }
      }),
      this.#cdp.on("Page.frameAttached", this.#sessionId, () => this.signalChange()),
      this.#cdp.on("Page.frameDetached", this.#sessionId, () => this.signalChange()),
      this.#cdp.on("Runtime.bindingCalled", this.#sessionId, () => this.signalChange()),
    );
  }

  private signalChange(): void {
    for (const listener of this.#changeListeners) listener();
  }

  private async waitForChange(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.#changeListeners.delete(done); resolve(); };
      const timer = setTimeout(done, Math.min(ms, 150));
      this.#changeListeners.add(done);
    });
  }

  private async waitForNewTarget(ms: number): Promise<void> {
    if (this.#newTargets.size) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.#popupListeners.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.#popupListeners.add(done);
    });
  }

  async waitForInteractionPause(): Promise<void> {
    if (!this.#interactionPauses) return;
    const waitStarted = performance.now();
    while (true) {
      const pageLoad = this.#pageLoadPromise;
      if (pageLoad) {
        const remainingBudget = this.#waitBudgetMs - this.#waitSpentMs - (performance.now() - waitStarted);
        if (remainingBudget <= 0) throw new WaitTimeoutError(Math.round(this.#waitSpentMs + performance.now() - waitStarted), "main document loading", null);
        await Promise.race([pageLoad, Bun.sleep(remainingBudget).then(() => {
          throw new WaitTimeoutError(Math.round(this.#waitSpentMs + performance.now() - waitStarted), "main document loading", null);
        })]);
        continue;
      }
      this.#waitSpentMs += performance.now() - waitStarted;
      const remaining = this.#pauseUntil - performance.now();
      if (remaining <= 0) return;
      await Bun.sleep(remaining);
    }
  }

  private async startRecording(): Promise<void> {
    if (!this.#recordingPath) return;
    await recordingEncoder();
    const firstSegment = !this.#recordingDirectory;
    if (firstSegment) this.#recordingDirectory = await mkdtemp(join(tmpdir(), "jev-cdp-recording-"));
    await this.call("Page.enable");
    await this.call("Page.addScriptToEvaluateOnNewDocument", { source: RECORDING_CURSOR_INIT });
    const viewport = await this.evaluate<{ width: number; height: number }>(
      "({width: innerWidth, height: innerHeight})",
    );
    if (!viewport) throw new Error("Could not read the recording viewport");
    await this.animateCursor(viewport.width / 2, viewport.height / 2);
    const initial = await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const initialPath = join(this.#recordingDirectory!, `${String(this.#recordingSequence++).padStart(6, "0")}.jpg`);
    await Bun.write(initialPath, Buffer.from(initial.data, "base64"));
    if (firstSegment) this.#recordingStartedAt = performance.now();
    const initialElapsedMs = firstSegment ? 0 : performance.now() - this.#recordingStartedAt;
    this.#recordingFrames.push({ path: initialPath, elapsedMs: initialElapsedMs,
      targetId: this.#targetId, url: this.#activeUrl, newTab: false });
    this.#stopRecordingEvents = this.#cdp.on("Page.screencastFrame", this.#sessionId, (params) => {
      const frame = params as unknown as ScreencastFrame;
      void this.call("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      const sequence = this.#recordingSequence++;
      const path = join(this.#recordingDirectory!, `${String(sequence).padStart(6, "0")}.jpg`);
      const capturedAt = performance.now();
      const elapsedMs = sequence ? capturedAt - this.#recordingStartedAt : 0;
      const url = this.#activeUrl;
      const targetId = this.#targetId;
      const notice = capturedAt < this.#newTabNoticeUntil;
      const noticeUrl = notice ? this.#newTabNoticeUrl ?? undefined : undefined;
      this.#recordingWrites = this.#recordingWrites.then(async () => {
        await Bun.write(path, Buffer.from(frame.data, "base64"));
        this.#recordingFrames.push({ path, elapsedMs, targetId, url, newTab: notice,
          ...(noticeUrl ? { noticeUrl } : {}) });
      });
    });
    await this.call("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: PAGE_WIDTH,
      maxHeight: PAGE_HEIGHT,
      everyNthFrame: 3,
    });
  }

  private async recordNewTabNotice(url: string): Promise<number | undefined> {
    if (!this.#recordingPath || !this.#recordingDirectory) return;
    const capture = await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const elapsedMs = performance.now() - this.#recordingStartedAt;
    const path = join(this.#recordingDirectory, `${String(this.#recordingSequence++).padStart(6, "0")}.jpg`);
    await Bun.write(path, Buffer.from(capture.data, "base64"));
    this.#recordingFrames.push({ path, elapsedMs, targetId: this.#targetId, url: this.#activeUrl,
      newTab: true, noticeUrl: url });
    return elapsedMs;
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
    const stoppedAt = performance.now() - this.#recordingStartedAt;
    this.#recordingFrames.sort((a, b) => a.elapsedMs - b.elapsedMs);
    for (const event of this.#recordingUrlEvents) {
      let index = this.#recordingFrames.length - 1;
      while (index >= 0 && (this.#recordingFrames[index]!.elapsedMs >= event.elapsedMs ||
        this.#recordingFrames[index]!.targetId !== event.targetId)) index--;
      const before = this.#recordingFrames[index];
      if (!before || before.url === event.url) continue;
      const path = join(this.#recordingDirectory, `${String(this.#recordingSequence++).padStart(6, "0")}.jpg`);
      await Bun.write(path, Bun.file(before.path));
      const frame: RecordingFrame = { path, elapsedMs: event.elapsedMs, targetId: event.targetId,
        url: event.url, newTab: this.#newTabNoticeWindows.some(window =>
          event.elapsedMs >= window.startMs && event.elapsedMs < window.endMs), noticeUrl: before.noticeUrl };
      this.#recordingFrames.push(frame);
      this.#recordingFrames.sort((a, b) => a.elapsedMs - b.elapsedMs);
    }
    for (const { endMs } of this.#newTabNoticeWindows) {
      if (this.#interactionPauses > 0) continue;
      let index = this.#recordingFrames.length - 1;
      while (index >= 0 && this.#recordingFrames[index]!.elapsedMs >= endMs) index--;
      const before = this.#recordingFrames[index];
      if (!before?.newTab || this.#recordingFrames[index + 1]?.elapsedMs === endMs) continue;
      const path = join(this.#recordingDirectory, `${String(this.#recordingSequence++).padStart(6, "0")}.jpg`);
      await Bun.write(path, Bun.file(before.path));
      this.#recordingFrames.splice(index + 1, 0, { path, elapsedMs: endMs, targetId: before.targetId,
        url: before.url, newTab: false });
    }
    for (const frame of this.#recordingFrames) {
      const jpeg = Buffer.from(await Bun.file(frame.path).arrayBuffer()).toString("base64");
      await Bun.write(frame.path, Buffer.from(await this.composeFrame(jpeg, frame.url,
        frame.newTab ? frame.noticeUrl ?? frame.url : null), "base64"));
    }
    await mkdir(dirname(this.#recordingPath), { recursive: true });
    const finishedAt = Math.max(stoppedAt, this.#recordingFrames.at(-1)!.elapsedMs + 40);
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
    await renderRecording(await recordingEncoder(), manifest, this.#recordingPath);
    await rm(this.#recordingDirectory, { recursive: true, force: true });
    this.#recordingDirectory = undefined;
  }

  private async saveFinalScreenshot(): Promise<void> {
    if (!this.#screenshotPath) return;
    await mkdir(dirname(this.#screenshotPath), { recursive: true });
    const capture = await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    const url = await this.evaluate<string>("location.href") ?? this.#activeUrl;
    await Bun.write(this.#screenshotPath, Buffer.from(await this.composeFrame(capture.data, url,
      this.#hadNewTab ? url : null), "base64"));
  }

  private async composeFrame(jpeg: string, url: string, newTabUrl: string | null): Promise<string> {
    const composed = await this.evaluate<string>(composeFrameExpression(jpeg, url, newTabUrl), true);
    if (!composed) throw new Error("Could not compose browser recording frame");
    return composed;
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
    const started = performance.now();
    const deadline = started + this.#waitBudgetMs - this.#waitSpentMs;
    while (performance.now() < deadline) {
      try {
        if (!this.#pageLoadPromise && await this.evaluate<string>("document.readyState") === "complete") {
          this.#waitSpentMs += performance.now() - started;
          return;
        }
      } catch (error) {
        if (!(error instanceof StalePageError)) throw error;
      }
      await this.waitForChange(Math.max(1, deadline - performance.now()));
    }
    this.#waitSpentMs += performance.now() - started;
    const state = await this.observe(false).catch(() => null);
    throw new WaitTimeoutError(Math.round(this.#waitSpentMs), "main document loading", state);
  }

  async waitForSemanticReady(initial: PageState, screenshot = this.#screenshots): Promise<PageState> {
    const started = performance.now();
    const spentAtStart = this.#waitSpentMs;
    const deadline = started + Math.max(0, this.#waitBudgetMs - this.#waitSpentMs);
    const accountWait = () => { this.#waitSpentMs += Math.max(0, performance.now() - started - (this.#waitSpentMs - spentAtStart)); };
    let state = initial;
    while (true) {
      const pending = state.frames.find(frame => frame.loading || frame.readyState !== "complete");
      const loadingText = state.frames.length > 1 && !state.actions.some(action => action.frameId) &&
        /(?:^|\n)loading(?:\.{0,3}|\s)/i.test(state.text);
      if (!pending && !loadingText) {
        accountWait();
        return state;
      }
      const condition = pending ? `frame ${pending.url || pending.id} loading` : "embedded content loading";
      if (performance.now() >= deadline) {
        accountWait();
        throw new WaitTimeoutError(Math.round(this.#waitSpentMs), condition, state);
      }
      await this.waitForChange(Math.max(1, deadline - performance.now()));
      try { state = await this.observe(screenshot); }
      catch (error) { if (!(error instanceof StalePageError)) throw error; }
    }
  }

  async evaluate<T>(expression: string, awaitPromise = false): Promise<T | undefined> {
    const response = await this.call<{
      result?: { value?: T };
      exceptionDetails?: object;
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, awaitPromise ? 15_000 : undefined);
    if (response.exceptionDetails) throw new StalePageError("Document changed during evaluation");
    return response.result?.value;
  }

  private async evaluateFrame<T>(frameId: string, expression: string): Promise<T | undefined> {
    const session = this.#frameSessions.get(frameId);
    let contextId = this.#frameContexts.get(frameId);
    if (!session && !contextId) {
      const context = await this.call<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId });
      contextId = context.executionContextId;
      this.#frameContexts.set(frameId, contextId);
    }
    const response = await this.#cdp.command<{ result?: { value?: T }; exceptionDetails?: object }>(
      "Runtime.evaluate", { expression, returnByValue: true, ...(contextId ? { contextId } : {}) }, session ?? this.#sessionId);
    if (response.exceptionDetails) throw new StalePageError("Frame changed during evaluation");
    return response.result?.value;
  }

  private async frameOffset(frameId: string, parentId: string | null = null): Promise<{ x: number; y: number }> {
    const session = parentId ? this.#frameSessions.get(parentId) ?? this.#sessionId : this.#sessionId;
    const owner = await this.#cdp.command<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId }, session);
    const box = await this.#cdp.command<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, session);
    return { x: box.model.content[0]!, y: box.model.content[1]! };
  }

  private async frameScreenOffset(frameId: string, frames?: FrameState[]): Promise<{ x: number; y: number }> {
    const states = frames ?? await this.frameStates();
    let id: string | null = frameId;
    let x = 0, y = 0;
    while (id) {
      const frame = states.find(item => item.id === id);
      if (!frame?.parentId) break;
      const offset = await this.frameOffset(id, frame.parentId);
      x += offset.x; y += offset.y;
      id = frame.parentId;
    }
    return { x, y };
  }

  private async frameStates(): Promise<FrameState[]> {
    type Tree = { frame: { id: string; parentId?: string; url?: string }; childFrames?: Tree[] };
    const tree = await this.call<{ frameTree: Tree }>("Page.getFrameTree");
    const frames: FrameState[] = [];
    const visit = async (node: Tree, parentId: string | null): Promise<void> => {
      const { id, url = "" } = node.frame;
      let readyState: string | null = null;
      try { readyState = id === this.#mainFrameId
        ? await this.evaluate<string>("document.readyState") ?? null
        : await this.evaluateFrame<string>(id, "document.readyState") ?? null;
      } catch { /* A frame can navigate while its state is read. */ }
      frames.push({ id, parentId, url, readyState,
        loading: this.#loadingFrames.has(id) || readyState !== "complete" });
      for (const child of node.childFrames ?? []) await visit(child, id);
    };
    await visit(tree.frameTree, null);
    return frames;
  }

  private async discoverTabs(): Promise<void> {
    if (!this.#switchOnPopup) return;
    for (const target of await listChromeTargets(this.#cdpUrl)) {
      if (target.type !== "page" || this.#knownTargets.has(target.id)) continue;
      this.#knownTargets.add(target.id);
      this.#newTargets.delete(target.id);
      const attached = await this.#cdp.command<{ sessionId: string }>("Target.attachToTarget", { targetId: target.id, flatten: true });
      try {
        await this.#cdp.command("Emulation.setDeviceMetricsOverride", {
          width: PAGE_WIDTH, height: PAGE_HEIGHT, deviceScaleFactor: 1, mobile: false,
        }, attached.sessionId);
      } finally {
        if (this.#switchOnPopup) {
          const noticeStart = await this.recordNewTabNotice(target.url);
          const noticeStartAt = noticeStart === undefined ? performance.now() : this.#recordingStartedAt + noticeStart;
          this.#newTabNoticeUrl = target.url;
          this.#newTabNoticeUntil = this.#interactionPauses > 0 ? Infinity : 0;
          const noticeWindow = noticeStart === undefined ? undefined : { startMs: noticeStart,
            endMs: noticeStart + Math.max(40, this.#interactionPauses) };
          if (noticeWindow) this.#newTabNoticeWindows.push(noticeWindow);
          if (this.#interactionPauses > 0) await Bun.sleep(Math.max(0, noticeStartAt + this.#interactionPauses - performance.now()));
          if (this.#recordingPath) {
            await this.call("Page.stopScreencast").catch(() => undefined);
            this.#stopRecordingEvents?.();
            this.#stopRecordingEvents = undefined;
            await this.#recordingWrites;
          }
          if (noticeWindow && this.#interactionPauses > 0) noticeWindow.endMs = performance.now() - this.#recordingStartedAt;
          this.#newTabNoticeUrl = null;
          this.#newTabNoticeUntil = 0;
          this.#sessionId = attached.sessionId;
          this.#targetId = target.id;
          this.#activeUrl = target.url;
          this.#loadingFrames.clear();
          await this.watchConsole();
          await this.watchPageLoads();
          this.#switchOnPopup = false;
          this.#hadNewTab = true;
          await this.startRecording();
          this.#pauseUntil = performance.now();
        } else {
          await this.#cdp.command("Target.detachFromTarget", { sessionId: attached.sessionId });
        }
      }
      this.#openedTabs.push({ id: target.id, url: target.url, title: target.title });
      if (this.#origin) this.#transitions.push({ kind: "new_tab", control: this.#origin.control,
        fromTargetId: this.#origin.targetId, targetId: target.id, fromUrl: this.#origin.url,
        destinationUrl: target.url, settled: false });
      const urls = this.#targetUrls.get(target.id) ?? [];
      const requested = this.#origin?.href ?? urls[0];
      if (this.#origin && requested && requested !== target.url) this.#transitions.push({ kind: "redirect",
        control: this.#origin.control, fromTargetId: this.#origin.targetId, targetId: target.id,
        fromUrl: requested, destinationUrl: target.url, settled: false });
    }
    this.#switchOnPopup = false;
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
    await this.discoverTabs();
    let info: Omit<PageState, "fingerprint"> | null | undefined;
    const waitStarted = performance.now();
    const deadline = waitStarted + Math.max(0, this.#waitBudgetMs - this.#waitSpentMs);
    let waited = false;
    while (true) {
      try {
        info = await this.evaluate<Omit<PageState, "fingerprint"> | null>(READ_STATE);
        if (info) break;
      } catch (error) {
        if (!(error instanceof StalePageError)) throw error;
      }
      if (performance.now() >= deadline) {
        this.#waitSpentMs += performance.now() - waitStarted;
        throw new WaitTimeoutError(Math.round(this.#waitSpentMs), "document navigating", null);
      }
      waited = true;
      await this.waitForChange(Math.max(1, deadline - performance.now()));
    }
    if (waited) this.#waitSpentMs += performance.now() - waitStarted;
    if (this.#openedTabs.length) {
      const targets = await listChromeTargets(this.#cdpUrl);
      this.#openedTabs = this.#openedTabs.map(tab => {
        const current = targets.find(target => target.id === tab.id);
        return current ? { ...tab, url: current.url, title: current.title } : tab;
      });
      info.text = `${info.text}\n${this.#openedTabs.map(tab => `Opened new tab: ${tab.title} ${tab.url} (target ${tab.id})`).join("\n")}`;
    }
    const frames = await this.frameStates();
    for (const frame of frames.filter(frame => frame.parentId !== null)) {
      const frameId = frame.id;
      try {
        const offset = await this.frameScreenOffset(frameId, frames);
        const child = await this.evaluateFrame<Omit<PageState, "fingerprint"> | null>(frameId, READ_STATE);
        if (!child) continue;
        info.text = `${info.text}\n${child.text}`.slice(0, 6000);
        for (const action of child.actions) {
          if (!action.node || !action.rect) continue;
          const rect = { ...action.rect, x: action.rect.x + offset.x, y: action.rect.y + offset.y };
          if (rect.x < 0 || rect.y < 0 || rect.x >= info.w || rect.y >= info.h) continue;
          const covering = await this.evaluate<{tag:string;text:string;role:string|null}|null>(`(() => {
            const e=document.elementFromPoint(${rect.x + rect.w / 2},${rect.y + rect.h / 2});
            if (!e || e.tagName==='IFRAME') return null;
            return {tag:e.tagName.toLowerCase(),text:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,160),role:e.getAttribute('role')};
          })()`);
          info.actions.push({ ...action, frameId, rect, id: `e${info.actions.length + 1}`,
            clickable: action.clickable && !covering, coveredBy: covering ?? action.coveredBy });
          info.guards[`${frameId}:${action.node}`] = child.guards[String(action.node)]!;
        }
        info.marker = [info.marker, frameId, child.marker];
      } catch { /* A frame can navigate or detach while observing. */ }
    }
    if (this.#origin && this.#targetId === this.#origin.targetId && info.url !== this.#origin.url &&
        !this.#transitions.some(transition => transition.control === this.#origin!.control && transition.fromUrl === this.#origin!.url && transition.targetId === this.#targetId)) {
      this.#transitions.push({ kind: "navigation", control: this.#origin.control,
        fromTargetId: this.#origin.targetId, targetId: this.#targetId,
        fromUrl: this.#origin.url, destinationUrl: info.url, settled: false });
      if (this.#origin.href && this.#origin.href !== info.url) this.#transitions.push({
        kind: "redirect", control: this.#origin.control, fromTargetId: this.#origin.targetId,
        targetId: this.#targetId, fromUrl: this.#origin.href, destinationUrl: info.url, settled: false,
      });
    }
    const targets = this.#transitions.length ? await listChromeTargets(this.#cdpUrl) : [];
    for (const transition of this.#transitions) {
      const target = targets.find(item => item.id === transition.targetId);
      if (target) transition.destinationUrl = target.url;
      transition.settled = frames.every(frame => !frame.loading);
    }
    if (this.#origin?.href) for (const transition of this.#transitions.filter(item => item.kind === "new_tab" && item.control === this.#origin!.control)) {
      if (transition.destinationUrl !== this.#origin.href &&
          !this.#transitions.some(item => item.kind === "redirect" && item.targetId === transition.targetId && item.fromUrl === this.#origin!.href)) {
        this.#transitions.push({ kind: "redirect", control: transition.control,
          fromTargetId: transition.fromTargetId, targetId: transition.targetId,
          fromUrl: this.#origin.href, destinationUrl: transition.destinationUrl,
          settled: transition.settled });
      }
    }
    const page: PageState = { ...info, frames, transitions: [...this.#transitions], fingerprint: fingerprint(info) };
    if (screenshot) {
      const capture = await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 72 });
      page.screenshot = await this.composeFrame(capture.data, info.url,
        performance.now() < this.#newTabNoticeUntil ? this.#newTabNoticeUrl : null);
    }
    return page;
  }

  async fresh(page: PageState, action?: BrowserAction): Promise<boolean> {
    if (action?.frameId && typeof action.node === "number") {
      const current = await this.evaluateFrame<JsonValue>(action.frameId, `(() => {
        const c=window.__jevFast; return c ? c.guard(c.nodes.get(${action.node})) : null;
      })()`);
      return stableStringify(current) === stableStringify(page.guards[`${action.frameId}:${action.node}`]);
    }
    if (action && (action.kind === "click" || action.kind === "select")) {
      if (typeof action.node !== "number") return false;
      const current = await this.evaluate<JsonValue>(`(() => {
        const c=window.__jevFast;
        return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null;
      })()`);
      return stableStringify(current) === stableStringify([page.page_key, page.guards[String(action.node)]]);
    }
    let marker = await this.evaluate<JsonValue>(MARKER);
    for (const frame of (await this.frameStates()).filter(item => item.parentId !== null)) {
      try {
        const childMarker = await this.evaluateFrame<JsonValue>(frame.id, MARKER);
        if (childMarker !== undefined) marker = [marker ?? null, frame.id, childMarker];
      } catch { return false; }
    }
    return stableStringify(marker) === stableStringify(page.marker);
  }

  private async describeElement(action: BrowserAction): Promise<ElementDetails> {
    const expression = `(node => {
      const e = window.__jevFast?.nodes.get(node);
      if (!e?.isConnected) return null;
      const path = [];
      for (let current = e; current; current = current.parentElement) {
        if (current.id && document.querySelectorAll('#' + CSS.escape(current.id)).length === 1) {
          path.unshift('#' + CSS.escape(current.id));
          break;
        }
        let position = 1;
        for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (sibling.tagName === current.tagName) position++;
        }
        path.unshift(current.tagName.toLowerCase() + ':nth-of-type(' + position + ')');
      }
      return {css:path.join(' > '),tag:e.tagName.toLowerCase(),
        href:typeof e.href === 'string' ? e.href : e.getAttribute('href'),
        inputType:e.getAttribute('type'),frameUrl:location.href,target:e.getAttribute('target')};
    })(${action.node})`;
    const details = action.frameId
      ? await this.evaluateFrame<ElementDetails | null>(action.frameId, expression)
      : await this.evaluate<ElementDetails | null>(expression);
    if (!details) throw new StalePageError("Target changed before replay details were captured");
    return details;
  }

  async act(action: BrowserAction, page: PageState, text?: string): Promise<{ element: ReplayElement | null; performedAt: number }> {
    if (!(await this.fresh(page, action))) throw new StalePageError("Page changed since this decision");
    if (action.kind === "wait") {
      await Bun.sleep(100);
      return { element: null, performedAt: performance.now() };
    }
    if (action.kind === "scroll") {
      await this.animateCursor(550, 650);
      await this.call("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta ?? 0,
      });
      return { element: null, performedAt: performance.now() };
    }
    if (typeof action.node !== "number") throw new Error("Invalid observed node");
    const details = await this.describeElement(action);
    if (action.kind === "click") this.#origin = { control: action.label, targetId: this.#targetId,
      url: page.url, href: details.href };

    const target = await (action.frameId ? this.evaluateFrame<{ x: number; y: number } | null>(action.frameId, `(action => {
      const e=window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
      const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      if (!e.contains(document.elementFromPoint(x,y))) return null;
      return {x,y};
    })(${JSON.stringify(action)})`) : this.evaluate<{ x: number; y: number } | null>(`(action => {
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
    })(${JSON.stringify(action)})`));
    if (!target) {
      if (action.kind === "select") throw new Error("Dropdown execution was not confirmed");
      throw new StalePageError("Target changed or is covered");
    }
    let performedAt = action.kind === "select" ? performance.now() : 0;
    if (action.frameId) {
      const offset = await this.frameScreenOffset(action.frameId);
      target.x += offset.x;
      target.y += offset.y;
      const covered = await this.evaluate<boolean>(`(() => {
        const e=document.elementFromPoint(${target.x},${target.y});
        return !e || e.tagName!=='IFRAME';
      })()`);
      if (covered) throw new StalePageError("Target is covered in the parent page");
    }
    let frame: ReplayElement["frame"] = null;
    if (action.frameId) {
      const frames = await this.frameStates();
      const parentId = frames.find(item => item.id === action.frameId)?.parentId ?? null;
      const index = frames.filter(item => item.parentId === parentId).findIndex(item => item.id === action.frameId);
      if (index < 0) throw new StalePageError("Target frame changed before input");
      frame = { id: action.frameId, parentId, url: details.frameUrl, index };
    }
    const element: ReplayElement = {
      css: details.css, role: action.role ?? null, name: action.label, tag: details.tag,
      href: details.href, inputType: details.inputType, point: { x: target.x, y: target.y }, frame,
    };
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
      performedAt = performance.now();
      if (action.kind === "fill") {
        const modifiers = process.platform === "darwin" ? 4 : 2;
        await this.call("Input.dispatchKeyEvent", {
          type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"],
        });
        await this.call("Input.dispatchKeyEvent", {
          type: "keyUp", key: "a", code: "KeyA", modifiers,
        });
        await this.call("Input.insertText", { text: text ?? "" });
        performedAt = performance.now();
      }
    }
    this.#afterInput = action;
    if (action.kind === "click") {
      this.#switchOnPopup = true;
      await this.waitForNewTarget(details.target === "_blank" ? 650 : 100);
    }
    return { element, performedAt };
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
