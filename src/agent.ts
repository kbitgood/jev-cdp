import { Browser, StalePageError, WaitTimeoutError, stableStringify } from "./browser";
import { actionSpace, choose, fieldContext, fieldText } from "./model";
import type {
  AgentStatus,
  ConsoleError,
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
  waitBudgetMs?: number;
  visible?: boolean;
  keepOpen?: boolean;
  screenshots?: boolean;
  recordingPath?: string;
  screenshotPath?: string;
  fieldValues?: Record<string, string>;
  sensitiveFieldLabels?: string[];
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
  waitTimeout?: { elapsedMs: number; pendingCondition: string };
  initialConsoleErrors: ConsoleError[];
  consoleErrors: ConsoleError[];
}

interface PendingText {
  contextKey: string;
  text: string;
  helper: TextHelperDetails;
}

export function redactConsoleErrors(errors: ConsoleError[], secrets: readonly string[]): ConsoleError[] {
  const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  return errors.map(error => ({ ...error, message: redact(error.message),
    ...(error.url ? { url: redact(error.url) } : {}) }));
}

export class Agent {
  readonly #browser: Browser;
  readonly #goal: string;
  readonly #maxSteps: number;
  readonly #screenshots: boolean;
  readonly #fieldValues: Readonly<Record<string, string>>;
  readonly #sensitiveFieldLabels: ReadonlySet<string>;
  readonly #secretValues: readonly string[];
  #page: PageState;
  #decision: Decision | null = null;
  #history: HistoryEntry[] = [];
  #decisions: Decision[] = [];
  #textCalls: (TextHelperDetails & { field: string; value: string })[] = [];
  #status: AgentStatus = "ready";
  #startedAt: number | null = null;
  #pendingText: PendingText | null = null;
  #waitTimeout?: { elapsedMs: number; pendingCondition: string };
  #initialConsoleErrors: ConsoleError[] = [];

  private constructor(browser: Browser, page: PageState, options: AgentOptions) {
    this.#browser = browser;
    this.#page = page;
    this.#goal = options.goal.trim();
    this.#maxSteps = options.maxSteps;
    this.#screenshots = options.screenshots ?? false;
    this.#fieldValues = options.fieldValues ?? {};
    this.#sensitiveFieldLabels = new Set(options.sensitiveFieldLabels ?? []);
    this.#secretValues = Object.entries(this.#fieldValues)
      .filter(([label, value]) => this.#sensitiveFieldLabels.has(label) && value.length > 0)
      .map(([, value]) => value);
    this.#startedAt = performance.now();
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
      waitBudgetMs: options.waitBudgetMs,
    });
    try {
      const agent = new Agent(browser, await browser.observe(options.screenshots), options);
      try { await agent.waitForReadiness(); }
      catch (error) {
        if (!(error instanceof WaitTimeoutError)) throw error;
        agent.recordWaitTimeout(error);
      }
      agent.#initialConsoleErrors = redactConsoleErrors(browser.takeConsoleErrors(), agent.#secretValues);
      return agent;
    } catch (error) {
      await browser.close().catch(() => undefined);
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
      initialConsoleErrors: [...this.#initialConsoleErrors],
      consoleErrors: [...this.#initialConsoleErrors, ...this.#history.flatMap(entry => entry.consoleErrors),
        ...redactConsoleErrors(this.#browser.pendingConsoleErrors(), this.#secretValues)],
      ...(this.#waitTimeout ? { waitTimeout: this.#waitTimeout } : {}),
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
      await this.waitForReadiness();
    }
    this.#decision = null;
    if (["done", "blocked", "budget_exhausted", "wait_timeout"].includes(this.#status)) {
      throw new Error("This run has stopped");
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
        this.#textCalls.push({ ...helper, field: action.label, value: action.sensitive || this.#sensitiveFieldLabels.has(action.label) ? "[redacted]" : text });
      } else if (this.#pendingText?.contextKey === contextKey) {
        ({ text, helper } = this.#pendingText);
      } else {
        [text, helper] = await fieldText(context);
        this.#pendingText = { contextKey, text, helper };
        this.#textCalls.push({ ...helper, field: action.label, value: text });
      }
    }
    await this.#browser.waitForInteractionPause();
    const fromTargetId = this.#browser.targetId;
    const { element, performedAt } = await this.#browser.act(action, page, text ?? undefined);
    this.#pendingText = null;
    const entry: HistoryEntry = {
      step: this.#history.length + 1,
      action: action.label,
      kind: action.kind,
      choice: selected,
      probability: decision.probabilities[selected] ?? 0,
      confidence: decision.confidence,
      latency_ms: decision.latency_ms,
      text: (action.sensitive || this.#sensitiveFieldLabels.has(action.label)) && text !== null ? "[redacted]" : text,
      text_helper: helper?.model ?? null,
      text_latency_ms: helper?.latency_ms ?? 0,
      operation: decision.operation,
      target: decision.target,
      page_changed: null,
      from_url: page.url,
      url: page.url,
      viewport: { width: page.w, height: page.h },
      from_target_id: fromTargetId,
      target_id: this.#browser.targetId,
      element,
      value: action.kind === "select" ? action.value ?? null : null,
      delta_y: action.kind === "scroll" ? action.delta ?? 0 : null,
      redacted: action.kind === "fill" && (Boolean(action.sensitive) || this.#sensitiveFieldLabels.has(action.label)),
      usage: decision.usage,
      executed_ms: Math.round(performedAt - this.#startedAt!),
      elapsed_ms: this.elapsedMs(),
      consoleErrors: [],
    };
    this.#history.push(entry);
    this.#page = await this.#browser.observe(this.#screenshots);
    await this.waitForReadiness();
    entry.consoleErrors = redactConsoleErrors(this.#browser.takeConsoleErrors(), this.#secretValues);
    entry.page_changed = this.#page.fingerprint !== page.fingerprint;
    entry.url = this.#page.url;
    entry.target_id = this.#browser.targetId;
    entry.elapsed_ms = this.elapsedMs();
    this.#status = "ready";
  }

  async tick(): Promise<AgentSnapshot> {
    try {
      await this.predict();
      await this.act();
    } catch (error) {
      if (error instanceof WaitTimeoutError) {
        this.recordWaitTimeout(error);
        return this.snapshot();
      }
      if (!(error instanceof StalePageError)) throw error;
      this.#decision = null;
      this.#status = "ready";
      this.#page = await this.#browser.observe(this.#screenshots);
      try { await this.waitForReadiness(); }
      catch (waitError) {
        if (!(waitError instanceof WaitTimeoutError)) throw waitError;
        this.recordWaitTimeout(waitError);
      }
    }
    return this.snapshot();
  }

  async run(onStep?: (state: AgentSnapshot) => void): Promise<AgentSnapshot> {
    while (!["done", "blocked", "budget_exhausted", "wait_timeout"].includes(this.#status)) {
      const state = await this.tick();
      onStep?.(state);
    }
    return this.snapshot();
  }

  private async waitForReadiness(): Promise<void> {
    this.#page = await this.#browser.waitForSemanticReady(this.#page, this.#screenshots);
  }

  private recordWaitTimeout(error: WaitTimeoutError): void {
    this.#status = "wait_timeout";
    this.#waitTimeout = { elapsedMs: error.elapsedMs, pendingCondition: error.pendingCondition };
    if (error.state) this.#page = error.state;
  }

  close(): Promise<void> {
    return this.#browser.close();
  }
}
