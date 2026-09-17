import { createHash } from "node:crypto";
import { CdpClient, listChromeTargets } from "./cdp";
import type { BrowserAction, JsonValue, PageState } from "./types";

const READ_STATE = await Bun.file(new URL("./snapshot.js", import.meta.url)).text();
const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

export class StalePageError extends Error {}

export interface BrowserOptions {
  cdpUrl: string;
  url?: string;
  targetId?: string;
  visible?: boolean;
  keepOpen?: boolean;
  screenshots?: boolean;
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
  #afterInput: BrowserAction | null = null;
  #closed = false;

  private constructor(
    cdp: CdpClient,
    sessionId: string,
    targetId: string,
    ownsTarget: boolean,
    options: BrowserOptions,
  ) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#ownsTarget = ownsTarget;
    this.#keepOpen = options.keepOpen ?? false;
    this.#screenshots = options.screenshots ?? false;
  }

  static async open(options: BrowserOptions): Promise<Browser> {
    const cdp = await CdpClient.connect(options.cdpUrl);
    let targetId = options.targetId;
    const ownsTarget = !targetId;

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
      const created = await cdp.command<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
        background: !(options.visible ?? false),
      });
      targetId = created.targetId;
    }

    if (options.visible) await cdp.command("Target.activateTarget", { targetId });
    const attached = await cdp.command<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const browser = new Browser(cdp, attached.sessionId, targetId, ownsTarget, options);

    try {
      await browser.call("Emulation.setDeviceMetricsOverride", {
        width: 1120,
        height: 780,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      if (options.url) await browser.call("Page.navigate", { url: options.url });
      await browser.waitForReady();
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

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.evaluate<string>("document.readyState") === "complete") return;
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
    if (action.kind !== "select") {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await this.call("Input.dispatchMouseEvent", {
          type, x: target.x, y: target.y, button: "left", clickCount: 1,
        });
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
    try {
      if (this.#ownsTarget && !this.#keepOpen) {
        await this.#cdp.command("Target.closeTarget", { targetId: this.#targetId });
      } else {
        await this.#cdp.command("Target.detachFromTarget", { sessionId: this.#sessionId });
      }
    } finally {
      this.#cdp.close();
    }
  }
}
