"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Bot,
  Braces,
  Code2,
  Languages,
  MessageSquare,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  UserRound,
} from "lucide-react";

import { MarkdownContent } from "@/components/chat/markdown-content";
import { StructuredCard } from "@/components/chat/structured-card";
import { ToolCard } from "@/components/chat/tool-card";
import {
  parseStructuredCard,
  parseUsage,
  type PresetId,
  type ProviderId,
  type ToolCallView,
  type UiMessage,
} from "@/lib/chat-types";
import { consumeSse } from "@/lib/sse";

const backendUrl = (
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

const presets: Array<{
  id: PresetId;
  label: string;
  description: string;
  icon: typeof MessageSquare;
}> = [
  {
    id: "general",
    label: "通用助手",
    description: "解释概念、分析问题和生成内容",
    icon: MessageSquare,
  },
  {
    id: "translator",
    label: "翻译助手",
    description: "Few-shot 约束中英翻译风格",
    icon: Languages,
  },
  {
    id: "reviewer",
    label: "代码审查",
    description: "按 P0/P1/P2 输出可执行建议",
    icon: Code2,
  },
];

const providerLabels: Record<ProviderId, string> = {
  auto: "自动选择",
  mock: "演示模型",
  deepseek: "DeepSeek",
  qwen: "Qwen",
};

const suggestions = [
  "用一个具体例子解释 SSE 如何分段推送",
  "查一下北京今天的天气",
  "审查这段代码：每个 token 都直接调用 setState",
];

type ApiMessage = { role: "user" | "assistant"; content: string };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function createMessageId() {
  return crypto.randomUUID();
}

function makeUserMessage(content: string): UiMessage {
  return {
    id: createMessageId(),
    role: "user",
    content,
    status: "done",
    tools: [],
  };
}

function makeAssistantMessage(structuredExpected: boolean): UiMessage {
  return {
    id: createMessageId(),
    role: "assistant",
    content: "",
    status: "streaming",
    tools: [],
    structuredExpected,
  };
}

function messageForApi(message: UiMessage): ApiMessage | null {
  if (
    !message.content.trim() ||
    (message.role === "assistant" && message.status === "error")
  ) {
    return null;
  }
  return { role: message.role, content: message.content };
}

export function ChatWorkspace() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [preset, setPreset] = useState<PresetId>("general");
  const [provider, setProvider] = useState<ProviderId>("auto");
  const [temperature, setTemperature] = useState(0.7);
  const [structuredOutput, setStructuredOutput] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [availableProviders, setAvailableProviders] = useState<ProviderId[]>([
    "auto",
    "mock",
  ]);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const pendingTextRef = useRef("");
  const animationFrameRef = useRef<number | null>(null);
  const demoTriggeredRef = useRef(false);

  const patchAssistant = useCallback(
    (id: string, update: (message: UiMessage) => UiMessage) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? update(message) : message,
        ),
      );
    },
    [],
  );

  const flushPendingTokens = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const id = activeAssistantIdRef.current;
    const text = pendingTextRef.current;
    pendingTextRef.current = "";
    if (!id || !text) {
      return;
    }

    patchAssistant(id, (message) => ({
      ...message,
      content: message.content + text,
    }));
  }, [patchAssistant]);

  const queueToken = useCallback(
    (text: string) => {
      pendingTextRef.current += text;
      if (animationFrameRef.current !== null) {
        return;
      }
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        const id = activeAssistantIdRef.current;
        const buffered = pendingTextRef.current;
        pendingTextRef.current = "";
        if (!id || !buffered) {
          return;
        }
        patchAssistant(id, (message) => ({
          ...message,
          content: message.content + buffered,
        }));
      });
    },
    [patchAssistant],
  );

  useEffect(() => {
    const controller = new AbortController();

    async function loadMeta() {
      try {
        const response = await fetch(`${backendUrl}/chat/meta`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = asRecord(await response.json());
        const providers = Array.isArray(data.providers)
          ? data.providers.filter((item): item is ProviderId =>
              ["mock", "deepseek", "qwen"].includes(String(item)),
            )
          : [];
        setAvailableProviders(["auto", ...providers]);
        setBackendOnline(true);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setBackendOnline(false);
        }
      }
    }

    void loadMeta();
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  const latestUsage = useMemo(
    () =>
      [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.usage)?.usage,
    [messages],
  );

  async function runStream(
    history: ApiMessage[],
    structuredForRequest = structuredOutput,
  ) {
    if (isStreaming) {
      return;
    }

    const controller = new AbortController();
    const assistant = makeAssistantMessage(structuredForRequest);
    controllerRef.current = controller;
    activeAssistantIdRef.current = assistant.id;
    pendingTextRef.current = "";
    setIsStreaming(true);
    setGlobalError(null);
    setMessages((current) => [...current, assistant]);

    try {
      const response = await fetch(`${backendUrl}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          preset,
          provider,
          temperature,
          max_tokens: 1200,
          structured_output: structuredForRequest,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`后端返回 ${response.status}: ${body.slice(0, 240)}`);
      }

      await consumeSse(response, ({ event, data }) => {
        const payload = asRecord(data);
        const assistantId = activeAssistantIdRef.current;
        if (!assistantId) {
          return;
        }

        if (event === "message") {
          patchAssistant(assistantId, (message) => ({
            ...message,
            provider: asString(payload.provider) ?? message.provider,
            model: asString(payload.model) ?? message.model,
            warning: asString(payload.warning) ?? message.warning,
          }));
          return;
        }

        if (event === "token") {
          const text = asString(payload.text);
          if (text) {
            queueToken(text);
          }
          return;
        }

        if (event === "tool_start" || event === "tool_result") {
          const toolId = asString(payload.id);
          if (!toolId) {
            return;
          }
          patchAssistant(assistantId, (message) => {
            const existing = message.tools.find((tool) => tool.id === toolId);
            if (event === "tool_start") {
              const tool: ToolCallView = {
                id: toolId,
                name: asString(payload.name) ?? "tool",
                input: asRecord(payload.input),
                status: "running",
              };
              return {
                ...message,
                tools: existing
                  ? message.tools.map((item) =>
                      item.id === toolId ? tool : item,
                    )
                  : [...message.tools, tool],
              };
            }

            return {
              ...message,
              tools: message.tools.map((tool) =>
                tool.id === toolId
                  ? {
                      ...tool,
                      result: asRecord(payload.result),
                      status: "done",
                    }
                  : tool,
              ),
            };
          });
          return;
        }

        if (event === "structured") {
          const structured = parseStructuredCard(payload.data);
          patchAssistant(assistantId, (message) => ({
            ...message,
            structured: structured ?? message.structured,
            error: structured ? message.error : "结构化数据未通过前端校验",
          }));
          return;
        }

        if (event === "error") {
          const message = asString(payload.message) ?? "流式生成失败";
          setGlobalError(message);
          patchAssistant(assistantId, (current) => ({
            ...current,
            status: "error",
            error: message,
          }));
          return;
        }

        if (event === "done") {
          const usage = parseUsage(payload.usage);
          patchAssistant(assistantId, (message) => ({
            ...message,
            status: message.status === "error" ? "error" : "done",
            provider: asString(payload.provider) ?? message.provider,
            model: asString(payload.model) ?? message.model,
            usage: usage ?? message.usage,
          }));
        }
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : "未知网络错误";
      setGlobalError(message);
      patchAssistant(assistant.id, (current) => ({
        ...current,
        status: "error",
        error: message,
      }));
    } finally {
      flushPendingTokens();
      const stopped = controller.signal.aborted;
      setMessages((current) =>
        current.map((message) =>
          message.id === assistant.id && message.status === "streaming"
            ? { ...message, status: stopped ? "stopped" : "done" }
            : message,
        ),
      );
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        activeAssistantIdRef.current = null;
        setIsStreaming(false);
      }
    }
  }

  async function sendMessage(
    text: string,
    regenerate = false,
    structuredOverride?: boolean,
  ) {
    const content = text.trim();
    if ((!content && !regenerate) || isStreaming || backendOnline === false) {
      return;
    }

    let baseMessages: UiMessage[];
    if (regenerate) {
      const lastUserIndex = messages.findLastIndex(
        (message) => message.role === "user",
      );
      if (lastUserIndex < 0) {
        return;
      }
      baseMessages = messages.slice(0, lastUserIndex + 1);
      setMessages(baseMessages);
    } else {
      baseMessages = messages;
      setMessages([...baseMessages, makeUserMessage(content)]);
      setInput("");
    }

    const apiMessages = baseMessages
      .map(messageForApi)
      .filter((message): message is ApiMessage => message !== null);
    if (!regenerate) {
      apiMessages.push({ role: "user", content });
    }

    await runStream(apiMessages, structuredOverride ?? structuredOutput);
  }

  function stopStream() {
    controllerRef.current?.abort();
  }

  function clearConversation() {
    controllerRef.current?.abort();
    pendingTextRef.current = "";
    animationFrameRef.current = null;
    setMessages([]);
    setGlobalError(null);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  useEffect(() => {
    if (!backendOnline || demoTriggeredRef.current) {
      return;
    }

    const demo = new URLSearchParams(window.location.search).get("demo");
    if (demo === "weather") {
      demoTriggeredRef.current = true;
      void sendMessage("查一下北京今天的天气");
    } else if (demo === "structured") {
      demoTriggeredRef.current = true;
      setStructuredOutput(true);
      void sendMessage(
        "总结流式聊天应用的关键设计，并给出三条验收要点",
        false,
        true,
      );
    }
  }, [backendOnline]);

  const activePreset = presets.find((item) => item.id === preset) ?? presets[0];

  return (
    <div className="flex min-h-screen bg-[#f5f6f8] text-slate-900">
      <aside className="hidden w-72 shrink-0 border-r border-slate-200/80 bg-[#0d1117] p-4 text-slate-200 lg:flex lg:flex-col">
        <div className="flex items-center gap-3 px-2 py-2">
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 font-black text-white shadow-lg shadow-blue-950/30">
            D
          </span>
          <div>
            <p className="font-semibold tracking-tight text-white">DevPilot</p>
            <p className="text-[11px] text-slate-500">Streaming AI Lab · W2</p>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            System Prompt
          </span>
          <Sparkles size={14} className="text-cyan-400" />
        </div>
        <div className="mt-3 space-y-2">
          {presets.map((item) => {
            const Icon = item.icon;
            const selected = item.id === preset;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPreset(item.id)}
                disabled={isStreaming}
                className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                  selected
                    ? "border-cyan-500/40 bg-cyan-400/10"
                    : "border-transparent hover:border-slate-700 hover:bg-slate-900"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  <Icon
                    size={15}
                    className={selected ? "text-cyan-300" : "text-slate-400"}
                  />
                  {item.label}
                </span>
                <span className="mt-1 block pl-[23px] text-[11px] leading-5 text-slate-500">
                  {item.description}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">上下文预算</span>
            <span className="font-mono text-slate-200">
              {latestUsage
                ? `${latestUsage.prompt_tokens.toLocaleString()} / ${(
                    latestUsage.context_window / 1000
                  ).toFixed(0)}k`
                : "32k"}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-cyan-400 transition-all"
              style={{
                width: `${Math.min(
                  100,
                  Math.max(2, (latestUsage?.context_used_ratio ?? 0) * 100),
                )}%`,
              }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={clearConversation}
          className="mt-auto flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-400 transition hover:bg-slate-900 hover:text-white"
        >
          <Trash2 size={15} />
          清除会话
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
          <div className="mr-auto">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-slate-900">
                {activePreset.label}
              </h1>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                SSE STREAM
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {backendOnline === false
                ? "后端不可达"
                : backendOnline
                  ? "后端已连接 · 流式通道就绪"
                  : "正在连接后端…"}
            </p>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-slate-500">
            模型
            <select
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as ProviderId)
              }
              disabled={isStreaming}
              className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-slate-400"
            >
              {availableProviders.map((item) => (
                <option key={item} value={item}>
                  {providerLabels[item]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-[11px] text-slate-500">
            Temp
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.1"
              value={temperature}
              onChange={(event) => setTemperature(Number(event.target.value))}
              disabled={isStreaming}
              className="w-20 accent-slate-900"
            />
            <span className="w-7 font-mono text-slate-800">
              {temperature.toFixed(1)}
            </span>
          </label>

          <button
            type="button"
            onClick={() => setStructuredOutput((current) => !current)}
            disabled={isStreaming}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition ${
              structuredOutput
                ? "border-violet-300 bg-violet-50 text-violet-700"
                : "border-slate-200 bg-white text-slate-600"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <Braces size={13} />
            结构化
          </button>

          <button
            type="button"
            onClick={clearConversation}
            className="grid size-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-900 lg:hidden"
            aria-label="清除会话"
          >
            <Trash2 size={14} />
          </button>
        </header>

        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 sm:px-6">
          <div className="flex-1 space-y-7 overflow-y-auto py-7">
            {messages.length === 0 ? (
              <div className="flex min-h-[55vh] flex-col items-center justify-center text-center">
                <div className="grid size-14 place-items-center rounded-2xl bg-white text-slate-800 shadow-sm ring-1 ring-slate-200">
                  <Bot size={26} />
                </div>
                <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">
                  开始一段流式对话
                </h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
                  试试普通问答、天气假工具或结构化输出。每条回答都会通过 SSE
                  逐段进入页面。
                </p>
                <div className="mt-7 grid w-full max-w-xl gap-2 sm:grid-cols-3">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => void sendMessage(suggestion)}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-left text-xs leading-5 text-slate-600 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-900"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message, index) => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  {message.role === "assistant" && (
                    <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-xl bg-slate-900 text-white shadow-sm">
                      <Bot size={16} />
                    </span>
                  )}

                  <div
                    className={`min-w-0 ${
                      message.role === "user"
                        ? "max-w-[85%] rounded-2xl rounded-tr-md bg-slate-900 px-4 py-3 text-white"
                        : "max-w-[calc(100%-44px)] flex-1"
                    }`}
                  >
                    {message.role === "user" ? (
                      <p className="whitespace-pre-wrap text-sm leading-6">
                        {message.content}
                      </p>
                    ) : (
                      <div>
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                          <span className="font-semibold uppercase tracking-wider">
                            DevPilot
                          </span>
                          {message.provider && (
                            <span className="rounded-full bg-slate-200/70 px-1.5 py-0.5 text-slate-600">
                              {providerLabels[
                                message.provider as ProviderId
                              ] ?? message.provider}
                            </span>
                          )}
                          {message.model && <span>{message.model}</span>}
                        </div>

                        {message.warning && (
                          <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            {message.warning}
                          </p>
                        )}

                        {message.tools.map((tool) => (
                          <ToolCard key={tool.id} tool={tool} />
                        ))}

                        {message.structured && (
                          <StructuredCard data={message.structured} />
                        )}

                        {message.content &&
                          !message.structured &&
                          (!message.structuredExpected ||
                            message.status !== "streaming") && (
                            <MarkdownContent content={message.content} />
                          )}

                        {message.status === "streaming" && (
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                            <span className="stream-cursor" />
                            {message.structuredExpected
                              ? "正在生成并校验 JSON"
                              : "正在生成"}
                          </span>
                        )}

                        {message.error && (
                          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                            {message.error}
                          </p>
                        )}

                        {message.status === "stopped" && (
                          <p className="mt-2 text-xs text-slate-400">
                            已停止生成
                          </p>
                        )}

                        {message.usage && (
                          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
                            <span>
                              {message.usage.usage_is_estimated ? "约 " : ""}
                              {message.usage.total_tokens} tokens
                            </span>
                            <span>
                              费用约 $
                              {message.usage.estimated_cost_usd.toFixed(6)}
                            </span>
                            <span>
                              上下文{" "}
                              {(message.usage.context_used_ratio * 100).toFixed(
                                1,
                              )}
                              %
                            </span>
                          </div>
                        )}

                        {message.status !== "streaming" &&
                          message.role === "assistant" && (
                            <button
                              type="button"
                              onClick={() => void sendMessage("", true)}
                              disabled={
                                isStreaming || index < messages.length - 2
                              }
                              className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-slate-700 disabled:invisible"
                            >
                              <RotateCcw size={12} />
                              重新生成
                            </button>
                          )}
                      </div>
                    )}
                  </div>

                  {message.role === "user" && (
                    <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-xl bg-white text-slate-500 ring-1 ring-slate-200">
                      <UserRound size={15} />
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="sticky bottom-0 bg-gradient-to-t from-[#f5f6f8] via-[#f5f6f8] to-transparent pb-5 pt-4">
            {globalError && (
              <p className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {globalError}
              </p>
            )}
            <form
              onSubmit={onSubmit}
              className="rounded-2xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-200/60 focus-within:border-slate-300"
            >
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!isStreaming) {
                      void sendMessage(input);
                    }
                  }
                }}
                rows={3}
                placeholder={`向${activePreset.label}提问…  Enter 发送，Shift+Enter 换行`}
                disabled={backendOnline === false}
                className="max-h-44 min-h-[70px] w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400"
              />
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2 text-[10px] text-slate-400">
                  {structuredOutput && (
                    <span className="flex items-center gap-1 rounded-full bg-violet-50 px-2 py-1 text-violet-600">
                      <Braces size={11} /> JSON Schema
                    </span>
                  )}
                  <span>多轮历史随请求回传</span>
                </div>
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={stopStream}
                    className="flex h-9 items-center gap-2 rounded-xl bg-slate-800 px-3 text-xs font-medium text-white"
                  >
                    <Square size={12} fill="currentColor" />
                    停止
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() || backendOnline === false}
                    className="grid size-9 place-items-center rounded-xl bg-slate-900 text-white transition hover:bg-slate-700 disabled:bg-slate-300"
                    aria-label="发送"
                  >
                    <Send size={15} />
                  </button>
                )}
              </div>
            </form>
            <p className="mt-2 text-center text-[10px] text-slate-400">
              演示工具返回假数据；真实模型输出的费用仅按配置费率估算。
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

