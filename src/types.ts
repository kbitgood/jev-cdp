export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ActionKind = "click" | "fill" | "select" | "scroll" | "wait";

export interface BrowserAction {
  id: string;
  kind: ActionKind;
  label: string;
  node?: number;
  frameId?: string;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string | boolean;
  selected?: string | boolean;
  expanded?: string | boolean;
  pressed?: string | boolean;
  sensitive?: boolean;
  delta?: number;
  rect?: { x: number; y: number; w: number; h: number };
  frameUrl?: string;
  nearbyText?: string;
  region?: string;
  clickable?: boolean;
  coveredBy?: { tag: string; text: string; role: string | null } | null;
}

export interface FrameState {
  id: string;
  parentId: string | null;
  url: string;
  loading: boolean;
  readyState: string | null;
}

export interface NavigationTransition {
  kind: "new_tab" | "redirect" | "navigation";
  control: string;
  fromTargetId: string;
  targetId: string;
  fromUrl: string;
  destinationUrl: string;
  settled: boolean;
}

export interface ConsoleError {
  source: "console" | "exception" | "log";
  message: string;
  url?: string;
  timestamp?: number;
  targetId: string;
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  w: number;
  h: number;
  scroll: { y: number; height: number };
  actions: BrowserAction[];
  frames: FrameState[];
  transitions: NavigationTransition[];
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

export interface ReplayElement {
  css: string;
  role: string | null;
  name: string;
  tag: string;
  href: string | null;
  inputType: string | null;
  point: { x: number; y: number };
  frame: { id: string; parentId: string | null; url: string; index: number } | null;
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
  from_url: string;
  url: string;
  viewport: { width: number; height: number };
  from_target_id: string;
  target_id: string;
  element: ReplayElement | null;
  value: string | null;
  delta_y: number | null;
  redacted: boolean;
  usage: Record<string, number>;
  executed_ms: number;
  elapsed_ms: number;
  consoleErrors: ConsoleError[];
}

export type AgentStatus = "ready" | "predicted" | "done" | "blocked" | "budget_exhausted" | "wait_timeout";

export interface ChromeTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}
