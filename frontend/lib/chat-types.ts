export type PresetId = "general" | "translator" | "reviewer";
export type ProviderId = "auto" | "mock" | "deepseek" | "qwen";
export type MessageStatus = "streaming" | "done" | "stopped" | "error";

export interface ToolCallView {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: "running" | "done";
}

export interface StructuredCardData {
  title: string;
  summary: string;
  key_points: string[];
  confidence: number;
  tags: string[];
}

export interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  context_window: number;
  context_used_ratio: number;
  estimated_cost_usd: number;
  usage_is_estimated: boolean;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  provider?: string;
  model?: string;
  warning?: string;
  error?: string;
  tools: ToolCallView[];
  structured?: StructuredCardData;
  structuredExpected?: boolean;
  usage?: UsageStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseStructuredCard(value: unknown): StructuredCardData | null {
  if (!isRecord(value)) {
    return null;
  }

  const { title, summary, key_points, confidence, tags } = value;
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    title.length > 80 ||
    typeof summary !== "string" ||
    summary.length === 0 ||
    summary.length > 1000 ||
    !isStringArray(key_points) ||
    key_points.length < 1 ||
    key_points.length > 6 ||
    typeof confidence !== "number" ||
    confidence < 0 ||
    confidence > 1 ||
    !isStringArray(tags) ||
    tags.length > 6
  ) {
    return null;
  }

  return { title, summary, key_points, confidence, tags };
}

export function parseUsage(value: unknown): UsageStats | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const numericFields = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "context_window",
    "context_used_ratio",
    "estimated_cost_usd",
  ] as const;

  if (!numericFields.every((field) => typeof value[field] === "number")) {
    return undefined;
  }

  return {
    prompt_tokens: value.prompt_tokens as number,
    completion_tokens: value.completion_tokens as number,
    total_tokens: value.total_tokens as number,
    context_window: value.context_window as number,
    context_used_ratio: value.context_used_ratio as number,
    estimated_cost_usd: value.estimated_cost_usd as number,
    usage_is_estimated: value.usage_is_estimated === true,
  };
}

