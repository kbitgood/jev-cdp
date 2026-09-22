import { Browser, StalePageError, stableStringify } from "./browser";
import { actionSpace, choose, fieldContext, fieldText } from "./model";
import type {
  AgentStatus,
  Decision,
  HistoryEntry,
  PageState,
  TextHelperDetails,
} from "./types";

export interface AgentOptions {
  url?: string;
  targetId?: string;
  goal: string;
  cdpUrl: string;
  maxSteps: number;
  interactionPauses?: number;
  visible?: boolean;
  keepOpen?: boolean;
  screenshots?: boolean;
  recordingPath?: string;
  screenshotPath?: string;
  fieldValues?: Record<string, string>;
  freshContext?: boolean;
}

export interface AgentSnapshot {
  goal: string;
  page: PageState;
  decision: Decision | null;
  history: HistoryEntry[];
  decisions: Decision[];
  textCalls: (TextHelperDetails & { field: string; value: string })[];
  status: AgentStatus;
  elapsedMs: number;
  maxSteps: number;
  elements: ReturnType<typeof actionSpace>["elements"];
}

interface PendingText {
  contextKey: string;
  text: string;
  helper: TextHelperDetails;
}

export class Agent {
  readonly #browser: Browser;
  readonly #goal: string;
  readonly #maxSteps: number;
  readonly #screenshots: boolean;
  readonly #fieldValues: Readonly<Record<string, string>>;
  #page: PageState;
  #decision: Decision | null = null;
  #history: HistoryEntry[] = [];
  #decisions: Decision[] = [];
  #textCalls: (TextHelperDetails & { field: string; value: string })[] = [];
  #status: AgentStatus = "ready";
  #startedAt: number | null = null;
  #pendingText: PendingText | null = null;

  private constructor(browser: Browser, page: PageState, options: AgentOptions) {
    this.#browser = browser;
    this.#page = page;
    this.#goal = options.goal.trim();
    this.#maxSteps = options.maxSteps;
    this.#screenshots = options.screenshots ?? false;
    this.#fieldValues = options.fieldValues ?? {};
  }

  static async create(options: AgentOptions): Promise<Agent> {
    if (!options.goal.trim()) throw new Error("Supply a goal");
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 500) {
      throw new Error("maxSteps must be an integer from 1 to 500");
    }
    const browser = await Browser.open({
      cdpUrl: options.cdpUrl,
      url: options.url,
      targetId: options.targetId,
      visible: options.visible,
      keepOpen: options.keepOpen,
      screenshots: options.screenshots,
      recordingPath: options.recordingPath,
      screenshotPath: options.screenshotPath,
      freshContext: options.freshContext,
      interactionPauses: options.interactionPauses,
    });
    try {
      return new Agent(browser, await browser.observe(options.screenshots), options);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  snapshot(): AgentSnapshot {
    return {
      goal: this.#goal,
      page: this.#page,
      decision: this.#decision,
      history: [...this.#history],
      decisions: [...this.#decisions],
      textCalls: [...this.#textCalls],
      status: this.#status,
      elapsedMs: this.elapsedMs(),
      maxSteps: this.#maxSteps,
      elements: actionSpace(this.#page.actions).elements,
    };
  }

  get targetId(): string {
    return this.#browser.targetId;
  }

  private elapsedMs(): number {
    return this.#startedAt === null ? 0 : Math.round(performance.now() - this.#startedAt);
  }

  private async predict(): Promise<void> {
    if (this.#startedAt === null) this.#startedAt = performance.now();
    if (!(await this.#browser.fresh(this.#page))) {
      this.#page = await this.#browser.observe(this.#screenshots);
    }
    this.#decision = null;
    if (["done", "blocked", "budget_exhausted"].includes(this.#status)) {
      throw new Error("This run has stopped");
    }
    if (this.#decisions.length >= this.#maxSteps * 2) {
      this.#status = "budget_exhausted";
      return;
    }
    this.#decision = await choose(this.#page, this.#goal, this.#history, Object.keys(this.#fieldValues));
    this.#decisions.push(this.#decision);
    this.#status = "predicted";
  }

  private async act(): Promise<void> {
    const decision = this.#decision;
    const page = this.#page;
    if (!decision) return;
    this.#decision = null;
    const selected = decision.choice;
    if (selected === "DONE" || selected === "BLOCKED") {
      if (!(await this.#browser.fresh(page))) {
        this.#status = "ready";
        throw new StalePageError("Page changed since the decision");
      }
      this.#status = selected === "DONE" ? "done" : "blocked";
      return;
    }
    if (this.#history.length >= this.#maxSteps) {
      this.#status = "budget_exhausted";
      return;
    }
    const action = page.actions.find((candidate) => candidate.id === selected);
    if (!action) throw new Error(`Selected action no longer exists: ${selected}`);
    let text: string | null = null;
    let helper: TextHelperDetails | null = null;
    if (action.kind === "fill") {
      if (!(await this.#browser.fresh(page))) throw new StalePageError("Page changed before text generation");
      const context = fieldContext(this.#goal, action, page, this.#history);
      const contextKey = stableStringify(context);
      const provided = this.#fieldValues[action.label];
      if (action.sensitive && provided === undefined) {
        throw new Error(`Sensitive field \"${action.label}\" requires a caller-provided --field-value`);
      }
      if (provided !== undefined) {
        text = provided;
        helper = { model: "provided-field-value", provider: "caller", latency_ms: 0, usage: {} };
        this.#textCalls.push({ ...helper, field: action.label, value: action.sensitive ? "[redacted]" : text });
      } else if (this.#pendingText?.contextKey === contextKey) {
        ({ text, helper } = this.#pendingText);
      } else {
        [text, helper] = await fieldText(context);
        this.#pendingText = { contextKey, text, helper };
        this.#textCalls.push({ ...helper, field: action.label, value: text });
      }
    }
    await this.#browser.waitForInteractionPause();
    await this.#browser.act(action, page, text ?? undefined);
    this.#pendingText = null;
    const entry: HistoryEntry = {
      step: this.#history.length + 1,
      action: action.label,
      kind: action.kind,
      choice: selected,
      probability: decision.probabilities[selected] ?? 0,
      confidence: decision.confidence,
      latency_ms: decision.latency_ms,
      text: action.sensitive && text !== null ? "[redacted]" : text,
      text_helper: helper?.model ?? null,
      text_latency_ms: helper?.latency_ms ?? 0,
      operation: decision.operation,
      target: decision.target,
      page_changed: null,
      url: page.url,
      usage: decision.usage,
      executed_ms: this.elapsedMs(),
      elapsed_ms: this.elapsedMs(),
    };
    this.#history.push(entry);
    this.#page = await this.#browser.observe(this.#screenshots);
    entry.page_changed = this.#page.fingerprint !== page.fingerprint;
    entry.url = this.#page.url;
    entry.elapsed_ms = this.elapsedMs();
    this.#status = "ready";
  }

  async tick(): Promise<AgentSnapshot> {
    try {
      await this.predict();
      await this.act();
    } catch (error) {
      if (!(error instanceof StalePageError)) throw error;
      this.#decision = null;
      this.#status = "ready";
      this.#page = await this.#browser.observe(this.#screenshots);
    }
    return this.snapshot();
  }

  async run(onStep?: (state: AgentSnapshot) => void): Promise<AgentSnapshot> {
    while (!["done", "blocked", "budget_exhausted"].includes(this.#status)) {
      const state = await this.tick();
      onStep?.(state);
    }
    return this.snapshot();
  }

  close(): Promise<void> {
    return this.#browser.close();
  }
}
