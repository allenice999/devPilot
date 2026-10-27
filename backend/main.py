import json
import os
import re
import uuid
from collections.abc import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from jsonschema import ValidationError, validate

from chat_models import ChatRequest
from llm import (
    ProviderError,
    StreamMetrics,
    estimate_cost,
    estimate_tokens,
    get_provider_config,
    provider_chain,
    stream_provider,
    trim_history,
)
from prompts import PRESET_LABELS, STRUCTURED_SCHEMA, build_system_prompt
from sse import encode_sse

app = FastAPI(title="DevPilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/chat/meta")
def chat_meta() -> dict:
    providers = ["mock"]
    for name in ("deepseek", "qwen"):
        if get_provider_config(name):
            providers.append(name)
    return {
        "providers": providers,
        "presets": PRESET_LABELS,
        "context_window": int(os.getenv("LLM_CONTEXT_WINDOW", "32768")),
    }


def _extract_weather_city(text: str) -> str | None:
    if not re.search(r"天气|气温|下雨|weather", text, re.IGNORECASE):
        return None

    known_cities = (
        "北京",
        "上海",
        "广州",
        "深圳",
        "杭州",
        "成都",
        "重庆",
        "武汉",
        "南京",
        "西安",
        "苏州",
    )
    for city in known_cities:
        if city in text:
            return city

    if not re.search(r"天气|weather", text, re.IGNORECASE):
        return None

    match = re.search(
        r"(?:查询|查一下|查|看看|告诉我)?\s*([\u4e00-\u9fa5A-Za-z]{2,12}?)"
        r"(?:今天|明天|的)?(?:天气)",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None

    candidate = match.group(1).strip()
    ignored = {"今天", "明天", "现在", "一下", "当地", "这里", "那里"}
    return candidate if candidate not in ignored else None


def _parse_structured_output(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        cleaned = "\n".join(line for line in lines if not line.startswith("```")).strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(cleaned[start : end + 1])

    validate(instance=parsed, schema=STRUCTURED_SCHEMA)
    return parsed


async def _event_stream(request: Request, payload: ChatRequest) -> AsyncIterator[str]:
    history = [
        {"role": message.role, "content": message.content}
        for message in payload.messages
        if message.role in {"user", "assistant"}
    ]
    last_user = next(
        (item["content"] for item in reversed(history) if item["role"] == "user"),
        None,
    )
    if last_user is None:
        raise HTTPException(status_code=400, detail="At least one user message is required")

    message_id = f"assistant_{uuid.uuid4().hex}"
    providers = provider_chain(payload.provider)
    initial_config = get_provider_config(providers[0])

    yield encode_sse(
        "message",
        {
            "id": message_id,
            "role": "assistant",
            "preset": payload.preset,
            "provider": providers[0],
            "model": initial_config.model if initial_config else None,
            "structured": payload.structured_output,
        },
    )

    tool_result: dict | None = None
    city = _extract_weather_city(last_user)
    if city:
        tool_id = f"weather_{uuid.uuid4().hex[:10]}"
        tool_result = {
            "city": city,
            "condition": "晴间多云",
            "temperature": "24°C",
            "source": "DevPilot 假工具演示数据",
            "observed_at": "演示值，并非实时天气",
        }
        yield encode_sse(
            "tool_start",
            {
                "id": tool_id,
                "name": "get_weather",
                "input": {"city": city},
            },
        )
        yield encode_sse(
            "tool_result",
            {
                "id": tool_id,
                "name": "get_weather",
                "result": tool_result,
            },
        )

    system_messages: list[dict[str, str]] = [
        {
            "role": "system",
            "content": build_system_prompt(payload.preset, payload.structured_output),
        }
    ]
    if tool_result:
        system_messages.append(
            {
                "role": "system",
                "content": (
                    "假工具 get_weather 已返回以下演示数据。回答时明确标注它是演示值，"
                    f"不要声称已访问真实天气服务：{json.dumps(tool_result, ensure_ascii=False)}"
                ),
            }
        )

    context_window = int(os.getenv("LLM_CONTEXT_WINDOW", "32768"))
    fixed_prompt = "\n".join(item["content"] for item in system_messages)
    fixed_prompt_tokens = estimate_tokens(fixed_prompt)
    trimmed_history = trim_history(
        history,
        fixed_prompt_tokens=fixed_prompt_tokens,
        context_window=context_window,
        output_reserve=payload.max_tokens,
    )
    model_messages = [*system_messages, *trimmed_history]
    prompt_tokens = estimate_tokens(
        "\n".join(message["content"] for message in model_messages)
    )

    selected_config = None
    selected_provider = providers[0]
    metrics = StreamMetrics(prompt_tokens=prompt_tokens)
    full_text = ""
    last_error: ProviderError | None = None

    for index, provider_name in enumerate(providers):
        config = get_provider_config(provider_name)
        if config is None:
            last_error = ProviderError(
                f"Provider '{provider_name}' is not configured",
                code="provider_not_configured",
            )
            continue

        if index > 0:
            yield encode_sse(
                "message",
                {
                    "id": message_id,
                    "role": "assistant",
                    "preset": payload.preset,
                    "provider": provider_name,
                    "model": config.model,
                    "fallback": True,
                    "warning": f"主模型 {providers[0]} 不可用，已降级到 {provider_name}。",
                },
            )

        metrics = StreamMetrics(prompt_tokens=prompt_tokens)
        try:
            async for token in stream_provider(
                config,
                model_messages,
                temperature=payload.temperature,
                max_tokens=payload.max_tokens,
                structured_output=payload.structured_output,
                tool_result=tool_result,
                preset=payload.preset,
                metrics=metrics,
            ):
                if await request.is_disconnected():
                    return
                full_text += token
                yield encode_sse("token", {"text": token})
        except ProviderError as exc:
            last_error = exc
            if metrics.emitted_tokens:
                yield encode_sse(
                    "error",
                    {
                        "code": exc.code,
                        "message": str(exc),
                        "retryable": False,
                        "partial_output_preserved": True,
                    },
                )
                yield encode_sse("done", {"finish_reason": "error", "provider": provider_name})
                return
            continue

        selected_config = config
        selected_provider = provider_name
        break

    if selected_config is None:
        error = last_error or ProviderError("No provider is available")
        yield encode_sse(
            "error",
            {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
            },
        )
        yield encode_sse("done", {"finish_reason": "error", "provider": None})
        return

    if payload.structured_output:
        try:
            structured = _parse_structured_output(full_text)
            yield encode_sse("structured", {"data": structured})
        except (json.JSONDecodeError, ValidationError) as exc:
            yield encode_sse(
                "error",
                {
                    "code": "invalid_structured_output",
                    "message": f"模型输出未通过 JSON Schema 校验：{exc}",
                    "retryable": True,
                    "partial_output_preserved": True,
                },
            )
            yield encode_sse(
                "done",
                {"finish_reason": "invalid_structured_output", "provider": selected_provider},
            )
            return

    raw_usage = metrics.usage_from_provider or {}
    prompt_usage = int(raw_usage.get("prompt_tokens") or prompt_tokens)
    completion_usage = int(
        raw_usage.get("completion_tokens") or estimate_tokens(full_text)
    )
    usage = {
        "prompt_tokens": prompt_usage,
        "completion_tokens": completion_usage,
        "total_tokens": int(
            raw_usage.get("total_tokens") or prompt_usage + completion_usage
        ),
        "context_window": context_window,
        "context_used_ratio": round(prompt_usage / context_window, 4),
        "estimated_cost_usd": estimate_cost(
            selected_config, prompt_usage, completion_usage
        ),
        "usage_is_estimated": not bool(raw_usage),
    }
    yield encode_sse(
        "done",
        {
            "finish_reason": metrics.finish_reason or "stop",
            "provider": selected_provider,
            "model": selected_config.model,
            "usage": usage,
        },
    )


@app.post("/chat/stream")
async def chat_stream(payload: ChatRequest, request: Request) -> StreamingResponse:
    if not any(message.role == "user" for message in payload.messages):
        raise HTTPException(status_code=400, detail="At least one user message is required")

    return StreamingResponse(
        _event_stream(request, payload),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
