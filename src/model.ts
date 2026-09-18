import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEXT_ACTION, TARGET, TEXT_VALUE } from "./questions";
import TEXT_SCHEMA from "./text-value.schema.json" with { type: "json" };
import type {
  BrowserAction,
  ChoiceAnswer,
  Decision,
  HistoryEntry,
  PageState,
  TextHelperDetails,
  TypeSafeResponse,
} from "./types";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

async function postJson<T>(url: string, key: string, body: unknown): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new Error("Model connection failed; no action executed");
    }
    if ([429, 503, 529].includes(response.status) && attempt < 2) {
      await Bun.sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}; no action executed`);
    return await response.json() as T;
  }
  throw new Error("Model unavailable");
}

export function validateChoice(answer: ChoiceAnswer, ids: Iterable<string>): ChoiceAnswer {
  const expected = new Set(ids);
  const actual = new Set(Object.keys(answer?.probabilities ?? {}));
  const values = [...Object.values(answer?.probabilities ?? {}), answer?.confidence];
  const sum = Object.values(answer?.probabilities ?? {}).reduce((total, value) => total + value, 0);
  const maximum = Math.max(...Object.values(answer?.probabilities ?? {}));
  const valid = expected.has(answer?.choice)
    && expected.size === actual.size
    && [...expected].every((id) => actual.has(id))
    && values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(sum - 1) < 0.02
    && (answer?.probabilities?.[answer.choice] ?? -1) >= maximum - 1e-6;
  if (!valid) throw new Error("Invalid TypeSafe response; no action executed");
  return answer;
}

interface ElementSummary extends Record<string, unknown> {
  index: string;
  label: string;
  operations: string[];
  options?: { index: string; label: string; value?: string }[];
}

export interface ActionSpace {
  elements: ElementSummary[];
  targets: Record<string, Record<string, BrowserAction>>;
  controls: Record<string, BrowserAction>;
}

export function actionSpace(actions: BrowserAction[]): ActionSpace {
  const elements: ElementSummary[] = [];
  const indices = new Map<number, string>();
  const targets: Record<string, Record<string, BrowserAction>> = {};
  const controls: Record<string, BrowserAction> = {};
  const operations: Record<string, string> = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" };

  for (const action of actions) {
    const operation = operations[action.kind];
    if (!operation) {
      controls[action.id.toUpperCase()] = action;
      continue;
    }
    if (typeof action.node !== "number") continue;
    if (!indices.has(action.node)) {
      const index = String(elements.length + 1);
      indices.set(action.node, index);
      const element: ElementSummary = {
        index,
        label: action.label.split(" → ")[0] ?? action.label,
        operations: [],
      };
      for (const key of ["role", "value", "checked", "selected", "expanded", "pressed", "sensitive"] as const) {
        if (action[key] !== undefined) element[key] = action[key];
      }
      if (action.kind === "select") {
        element.value = action.current_value ?? "";
        element.options = [];
      }
      elements.push(element);
    }
    const index = indices.get(action.node)!;
    const group = targets[operation] ??= {};
    const element = elements[Number(index) - 1]!;
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target = index;
    if (action.kind === "select") {
      target = `${index}:${(element.options?.length ?? 0) + 1}`;
      element.options!.push({ index: target, label: action.label, value: action.value });
    }
    group[target] = action;
  }
  return { elements, targets, controls };
}

export async function choose(
  page: PageState,
  goal: string,
  history: HistoryEntry[],
  providedFields: string[] = [],
): Promise<Decision> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is required");
  const { elements, targets, controls } = actionSpace(page.actions);
  const labels: Record<string, string> = {
    CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
    TYPE_TEXT: "Enter or replace text in an editable field. Caller values are available for labels in provided_fields; otherwise a small LLM supplies the value from the goal.",
    SELECT: "Select an observed dropdown value.",
  };
  const operations: Record<string, unknown> = {};
  for (const operation of Object.keys(targets)) operations[operation] = labels[operation];
  for (const [operation, action] of Object.entries(controls)) operations[operation] = action.label;
  operations.DONE = "Every requirement is visibly satisfied.";
  operations.BLOCKED = "No supported operation can progress.";

  const questions: Record<string, unknown> = {
    operation: { type: "choice", criteria: operations, instructions: { goal, rules: NEXT_ACTION } },
  };
  for (const [operation, candidates] of Object.entries(targets)) {
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria: Object.fromEntries(Object.entries(candidates).map(([index, action]) => [index, {
        element: `[${index}] ${action.label}`,
        current_value: action.current_value ?? action.value ?? "",
        ...Object.fromEntries(
          (["role", "checked", "selected", "expanded", "pressed", "sensitive"] as const)
            .filter((name) => action[name] !== undefined)
            .map((name) => [name, action[name]]),
        ),
      }])),
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }

  const body = {
    model: process.env.TYPESAFE_MODEL ?? "jev-latest",
    state: {
      page: { url: page.url, title: page.title, text: page.text },
      elements,
      provided_fields: providedFields,
      recent_actions: history.slice(-10).map(({ action, kind, text, page_changed }) => ({
        action, kind, text, page_changed,
      })),
    },
    questions,
  };
  const started = performance.now();
  const result = await postJson<TypeSafeResponse>(TYPESAFE_URL, key, body);
  const operationAnswer = validateChoice(result.answers.operation!, Object.keys(operations));
  const operation = operationAnswer.choice;
  let target: string | null = null;
  let targetAnswer: ChoiceAnswer | null = null;
  let choice: string;
  let probabilities: Record<string, number> = {};

  if (targets[operation]) {
    const candidates = targets[operation];
    targetAnswer = validateChoice(result.answers[`${operation.toLowerCase()}_target`]!, Object.keys(candidates));
    target = targetAnswer.choice;
    choice = candidates[target]!.id;
    probabilities = Object.fromEntries(
      Object.entries(candidates).map(([index, action]) => [action.id, targetAnswer!.probabilities[index] ?? 0]),
    );
  } else {
    choice = controls[operation]?.id ?? operation;
    probabilities[choice] = operationAnswer.probabilities[operation] ?? 0;
  }

  return {
    choice,
    operation,
    target,
    confidence: operationAnswer.confidence,
    probabilities,
    operation_probabilities: operationAnswer.probabilities,
    target_probabilities: targetAnswer?.probabilities ?? {},
    target_confidence: targetAnswer?.confidence ?? null,
    raw_answers: result.answers,
    model: result.model,
    usage: result.usage ?? {},
    latency_ms: Math.round(performance.now() - started),
    request: body,
  };
}

export function fieldContext(goal: string, action: BrowserAction, page: PageState, history: HistoryEntry[]) {
  return {
    goal,
    field: { label: action.label, role: action.role, value: action.value },
    page: { title: page.title, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map(({ action: label, text }) => ({ action: label, text })),
  };
}

export function validateTextOutput(output: unknown): string {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Text helper returned no valid field value; nothing typed");
  }
  const record = output as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.text !== "string"
      || !record.text.trim() || record.text.length > 2000) {
    throw new Error("Text helper returned no valid field value; nothing typed");
  }
  return record.text;
}

async function codexFieldText(context: unknown): Promise<[string, TextHelperDetails]> {
  const executable = Bun.which(process.env.CODEX_BIN ?? "codex");
  if (!executable) throw new Error("TYPE_TEXT needs an authenticated Codex CLI");
  const model = process.env.TEXT_MODEL ?? "gpt-5.6-luna";
  const reasoning = process.env.TEXT_MODEL_REASONING ?? "low";
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(reasoning)) {
    throw new Error("Unsupported Codex reasoning effort");
  }
  const folder = await mkdtemp(join(tmpdir(), "jev-codex-text-"));
  const outputPath = join(folder, "output.json");
  const schemaPath = join(folder, "schema.json");
  await Bun.write(schemaPath, JSON.stringify(TEXT_SCHEMA));
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env)
      .filter(([name, value]) => value !== undefined && !["TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY"].includes(name))
      .map(([name, value]) => [name, value!]),
  );
  const command = [
    executable, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--disable", "shell_tool", "--disable", "apps", "--disable", "browser_use",
    "--disable", "computer_use", "--disable", "image_generation", "--disable", "multi_agent",
    "--model", model, "-c", `model_reasoning_effort="${reasoning}"`,
    "--output-schema", schemaPath, "--output-last-message", outputPath, "-",
  ];
  const prompt = `${TEXT_VALUE}\nReturn only the JSON object required by the output schema.\n\nContext:\n${JSON.stringify(context)}`;
  const started = performance.now();
  try {
    const process = Bun.spawn(command, {
      cwd: folder,
      env: childEnvironment,
      stdin: new Blob([prompt]),
      stdout: "ignore",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => process.kill(), 60_000);
    const exitCode = await process.exited;
    clearTimeout(timeout);
    if (exitCode !== 0 || !(await Bun.file(outputPath).exists())) {
      throw new Error("Codex text helper failed; nothing typed");
    }
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    return [validateTextOutput(output), {
      model,
      provider: "codex-subscription",
      reasoning,
      latency_ms: Math.round(performance.now() - started),
      usage: {},
    }];
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function apiFieldText(context: unknown): Promise<[string, TextHelperDetails]> {
  const key = process.env.TEXT_MODEL_API_KEY;
  if (!key) throw new Error("TYPE_TEXT needs TEXT_MODEL_API_KEY");
  const base = (process.env.TEXT_MODEL_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/$/, "");
  const model = process.env.TEXT_MODEL ?? "deepseek-chat";
  const started = performance.now();
  const result = await postJson<{
    choices: { message: { content: string } }[];
    usage?: Record<string, unknown>;
  }>(`${base}/chat/completions`, key, {
    model,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: TEXT_VALUE },
      { role: "user", content: JSON.stringify(context) },
    ],
  });
  const output = JSON.parse(result.choices[0]?.message.content ?? "null");
  return [validateTextOutput(output), {
    model,
    provider: "openai-compatible",
    latency_ms: Math.round(performance.now() - started),
    usage: result.usage ?? {},
  }];
}

export function fieldText(context: unknown): Promise<[string, TextHelperDetails]> {
  return process.env.TEXT_MODEL_PROVIDER === "api" ? apiFieldText(context) : codexFieldText(context);
}
