import asyncio
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

ProviderName = str


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "provider_error",
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class ProviderConfig:
    name: ProviderName
    base_url: str
    api_key: str
    model: str
    input_cost_per_million: float
    output_cost_per_million: float


@dataclass
class StreamMetrics:
    emitted_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    usage_from_provider: dict | None = None
    finish_reason: str = "stop"


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def get_provider_config(name: ProviderName) -> ProviderConfig | None:
    deepseek_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    qwen_key = (
        os.getenv("QWEN_API_KEY", "").strip()
        or os.getenv("DASHSCOPE_API_KEY", "").strip()
    )

    if name == "deepseek" and deepseek_key:
        return ProviderConfig(
            name="deepseek",
            base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
            api_key=deepseek_key,
            model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
            input_cost_per_million=_env_float(
                "DEEPSEEK_INPUT_COST_PER_MILLION_USD", 0.27
            ),
            output_cost_per_million=_env_float(
                "DEEPSEEK_OUTPUT_COST_PER_MILLION_USD", 1.10
            ),
        )

    if name == "qwen" and qwen_key:
        return ProviderConfig(
            name="qwen",
            base_url=os.getenv(
                "QWEN_BASE_URL",
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
            ),
            api_key=qwen_key,
            model=os.getenv("QWEN_MODEL", "qwen-plus"),
            input_cost_per_million=_env_float(
                "QWEN_INPUT_COST_PER_MILLION_USD", 0.40
            ),
            output_cost_per_million=_env_float(
                "QWEN_OUTPUT_COST_PER_MILLION_USD", 1.20
            ),
        )

    if name == "mock":
        return ProviderConfig(
            name="mock",
            base_url="mock://local",
            api_key="",
            model="devpilot-demo",
            input_cost_per_million=0,
            output_cost_per_million=0,
        )

    return None


def resolve_provider_name(requested: str) -> str:
    if requested != "auto":
        return requested

    configured = os.getenv("LLM_PROVIDER", "auto").strip().lower()
    if configured in {"deepseek", "qwen", "mock"}:
        if get_provider_config(configured):
            return configured
    if get_provider_config("deepseek"):
        return "deepseek"
    if get_provider_config("qwen"):
        return "qwen"
    return "mock"


def provider_chain(requested: str) -> list[str]:
    primary = resolve_provider_name(requested)
    chain = [primary]
    fallback = os.getenv("LLM_FALLBACK_PROVIDER", "").strip().lower()
    allow_mock = os.getenv("LLM_ALLOW_MOCK_FALLBACK", "true").lower() == "true"

    if fallback and fallback != primary and get_provider_config(fallback):
        chain.append(fallback)
    if allow_mock and "mock" not in chain:
        chain.append("mock")
    return chain


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    cjk_count = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
    non_cjk_count = max(0, len(text) - cjk_count)
    return max(1, cjk_count + (non_cjk_count + 3) // 4)


def trim_history(
    history: list[dict[str, str]],
    *,
    fixed_prompt_tokens: int,
    context_window: int,
    output_reserve: int,
) -> list[dict[str, str]]:
    available = max(256, context_window - fixed_prompt_tokens - output_reserve)
    kept: list[dict[str, str]] = []
    used = 0

    for message in reversed(history):
        cost = estimate_tokens(message["content"]) + 4
        if kept and used + cost > available:
            break
        kept.append(message)
        used += cost

    return list(reversed(kept))


def estimate_cost(
    config: ProviderConfig,
    prompt_tokens: int,
    completion_tokens: int,
) -> float:
    return round(
        (
            prompt_tokens * config.input_cost_per_million
            + completion_tokens * config.output_cost_per_million
        )
        / 1_000_000,
        8,
    )


def _mock_text(
    messages: list[dict[str, str]],
    preset: str,
    structured_output: bool,
    tool_result: dict | None,
) -> str:
    last_user = next(
        (message["content"] for message in reversed(messages) if message["role"] == "user"),
        "",
    )

    if structured_output:
        city = (tool_result or {}).get("city")
        title = "天气查询结果" if city else "流式聊天结果摘要"
        summary = (
            f"已查询 {city} 的演示天气数据。"
            if city
            else f"已处理请求：{last_user[:120]}。这是本地演示模型生成的结构化结果。"
        )
        points = (
            [
                f"城市：{city}",
                f"天气：{tool_result.get('condition', '未知')}",
                f"温度：{tool_result.get('temperature', '未知')}",
                "数据来自假工具，仅用于展示事件链路。",
            ]
            if tool_result
            else [
                "请求通过 FastAPI 建立 SSE 流。",
                "token 事件由前端逐段追加。",
                "最终 JSON 已通过后端 Schema 校验。",
            ]
        )
        return json.dumps(
            {
                "title": title,
                "summary": summary,
                "key_points": points,
                "confidence": 0.96,
                "tags": ["streaming", "demo", preset],
            },
            ensure_ascii=False,
        )

    if tool_result:
        return f"""已完成 **{tool_result['city']}** 的演示天气查询。

### 查询结果

| 项目 | 结果 |
| --- | --- |
| 天气 | {tool_result['condition']} |
| 温度 | {tool_result['temperature']} |
| 数据来源 | 假工具演示数据 |

这张工具卡片来自后端依次推送的 `tool_start` 和 `tool_result` 事件。当前没有连接真实天气服务，第五周会把这里替换成真实 MCP 工具。

> 建议把“演示数据”明确展示给用户，避免让界面看起来像真实实时天气。"""

    if preset == "translator":
        return f"""### 翻译演示

原文：

> {last_user}

译文：

> This is a streaming translation demo. The final wording would be produced by the selected LLM.

**处理说明**

1. System Prompt 约束“只翻译、不扩写”。
2. Few-shot 示例固定中英表达风格。
3. 语言方向应由真实模型根据原文自动判断。
4. 当前处于演示模型模式，因此译文用于验证流式链路。"""

    if preset == "reviewer":
        return f"""### 代码审查演示

**审查对象**

> {last_user}

#### P1：需要明确流式取消边界

- 影响：用户点击停止后，后端如果继续生成，会浪费 token 和连接资源。
- 证据：需要同时处理浏览器 `AbortController` 与 FastAPI 客户端断开。
- 最小修复：在 SSE generator 中检查 `request.is_disconnected()`。

#### P2：批量更新 UI

- 每个 token 都调用 `setState` 会造成高频渲染。
- 建议用 `requestAnimationFrame` 合并同一帧内的 token。

#### P2：结构化输出必须做运行时校验

- 不能只相信模型声称“这是 JSON”。
- 应使用 JSON Schema 校验，再由前端渲染成卡片。

以上是演示审查，替换为真实模型后会结合具体代码给出证据。"""

    return f"""### 流式回答已建立

你的问题是：

> {last_user}

这条回答由 **DevPilot 演示模型**分段生成。它用于验证一条完整链路：

1. 浏览器提交多轮消息历史。
2. FastAPI 构造 System Prompt 并选择模型。
3. 模型 token 先进入服务端异步生成器。
4. 服务端封装为 `event: token` + `data: JSON`。
5. 浏览器通过 `ReadableStream` 解码并逐字追加。

```ts
const reader = response.body?.getReader();
const decoder = new TextDecoder();
// 每次 read() 可能拿到半行、半条事件，甚至多个事件
```

**为什么不能按每个网络 chunk 直接解析？**  
因为 SSE 事件边界与 TCP/HTTP 分块边界没有一一对应。必须维护缓冲区，以空行作为一条完整事件的结束标志。

**下一步接真实模型时**，只需配置 `DEEPSEEK_API_KEY`、`QWEN_API_KEY` 或 `LLM_PROVIDER`，前端协议无需改变。"""


async def _stream_openai_compatible(
    config: ProviderConfig,
    messages: list[dict[str, str]],
    *,
    temperature: float,
    max_tokens: int,
    structured_output: bool,
    metrics: StreamMetrics,
) -> AsyncIterator[str]:
    payload: dict = {
        "model": config.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    if structured_output:
        payload["response_format"] = {"type": "json_object"}

    timeout = httpx.Timeout(
        connect=_env_float("LLM_CONNECT_TIMEOUT_SECONDS", 8),
        read=_env_float("LLM_READ_TIMEOUT_SECONDS", 60),
        write=15,
        pool=8,
    )
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{config.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            ) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", errors="replace")
                    retryable = response.status_code == 429 or response.status_code >= 500
                    code = (
                        "rate_limited"
                        if response.status_code == 429
                        else "provider_http_error"
                    )
                    raise ProviderError(
                        f"{config.name} returned HTTP {response.status_code}: {body[:500]}",
                        code=code,
                        retryable=retryable,
                    )

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    if chunk.get("usage"):
                        metrics.usage_from_provider = chunk["usage"]

                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    choice = choices[0]
                    metrics.finish_reason = choice.get("finish_reason") or metrics.finish_reason
                    delta = choice.get("delta") or {}
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        metrics.emitted_tokens += 1
                        yield content
    except httpx.TimeoutException as exc:
        raise ProviderError(
            f"{config.name} request timed out",
            code="provider_timeout",
            retryable=True,
        ) from exc
    except httpx.RequestError as exc:
        raise ProviderError(
            f"{config.name} network error: {exc}",
            code="provider_network_error",
            retryable=True,
        ) from exc


async def stream_provider(
    config: ProviderConfig,
    messages: list[dict[str, str]],
    *,
    temperature: float,
    max_tokens: int,
    structured_output: bool,
    tool_result: dict | None,
    preset: str,
    metrics: StreamMetrics,
) -> AsyncIterator[str]:
    if config.name == "mock":
        text = _mock_text(messages, preset, structured_output, tool_result)
        delay = max(0, _env_float("MOCK_DELAY_MS", 10)) / 1_000
        for index in range(0, len(text), 4):
            if delay:
                await asyncio.sleep(delay)
            metrics.emitted_tokens += 1
            yield text[index : index + 4]
        return

    for attempt in range(2):
        try:
            async for token in _stream_openai_compatible(
                config,
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
                structured_output=structured_output,
                metrics=metrics,
            ):
                yield token
            return
        except ProviderError as exc:
            if metrics.emitted_tokens or not exc.retryable or attempt == 1:
                raise
            await asyncio.sleep(0.6 * (attempt + 1))

