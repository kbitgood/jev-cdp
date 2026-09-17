export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ActionKind = "click" | "fill" | "select" | "scroll" | "wait";

export interface BrowserAction {
  id: string;
  kind: ActionKind;
  label: string;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string | boolean;
  selected?: string | boolean;
  expanded?: string | boolean;
  delta?: number;
  rect?: { x: number; y: number; w: number; h: number };
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  w: number;
  h: number;
  scroll: { y: number; height: number };
  actions: BrowserAction[];
  marker: JsonValue;
  page_key: JsonValue;
  guards: Record<string, JsonValue>;
  omitted_actions: number;
  fingerprint: string;
  screenshot?: string;
}

export interface ChoiceAnswer {
  type?: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface TypeSafeResponse {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage?: Record<string, number>;
}

export interface Decision {
  choice: string;
  operation: string;
  target: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  operation_probabilities: Record<string, number>;
  target_probabilities: Record<string, number>;
  target_confidence: number | null;
  raw_answers: Record<string, ChoiceAnswer>;
  model: string;
  usage: Record<string, number>;
  latency_ms: number;
  request: Record<string, unknown>;
}

export interface TextHelperDetails {
  model: string;
  provider: string;
  reasoning?: string;
  latency_ms: number;
  usage: Record<string, unknown>;
}

export interface HistoryEntry {
  step: number;
  action: string;
  kind: ActionKind;
  choice: string;
  probability: number;
  confidence: number;
  latency_ms: number;
  text: string | null;
  text_helper: string | null;
  text_latency_ms: number;
  operation: string;
  target: string | null;
  page_changed: boolean | null;
  url: string;
  usage: Record<string, number>;
  executed_ms: number;
  elapsed_ms: number;
}

export type AgentStatus = "ready" | "predicted" | "done" | "blocked" | "budget_exhausted";

export interface ChromeTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}
