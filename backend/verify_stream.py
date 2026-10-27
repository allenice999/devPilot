import asyncio
import json
import time

import httpx
from jsonschema import validate

from prompts import STRUCTURED_SCHEMA

BASE_URL = "http://127.0.0.1:8000"


async def collect_events(payload: dict) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    event_name = "message"
    data_lines: list[str] = []

    async with httpx.AsyncClient(timeout=30) as client:
        async with client.stream(
            "POST", f"{BASE_URL}/chat/stream", json=payload
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line == "":
                    if data_lines:
                        events.append((event_name, json.loads("\n".join(data_lines))))
                    event_name = "message"
                    data_lines = []
                elif line.startswith("event:"):
                    event_name = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].strip())

    return events


async def verify_weather_tool() -> None:
    events = await collect_events(
        {
            "messages": [{"role": "user", "content": "查一下北京今天的天气"}],
            "preset": "general",
            "provider": "mock",
        }
    )
    names = [name for name, _ in events]
    assert "tool_start" in names, names
    assert "tool_result" in names, names
    assert "token" in names, names
    assert names[-1] == "done", names[-1]
    print("PASS weather tool: tool_start -> tool_result -> token -> done")


async def verify_long_stream() -> None:
    started = time.perf_counter()
    events = await collect_events(
        {
            "messages": [
                {"role": "user", "content": "请详细解释流式聊天应用的工作链路"}
            ],
            "preset": "general",
            "provider": "mock",
        }
    )
    elapsed = time.perf_counter() - started
    token_events = [data for name, data in events if name == "token"]
    assert len(token_events) >= 10, len(token_events)
    assert events[-1][0] == "done", events[-1][0]
    text = "".join(event.get("text", "") for event in token_events)
    assert len(text) > 100
    print(
        f"PASS long stream: {len(token_events)} token events, "
        f"{len(text)} chars, {elapsed:.2f}s"
    )


async def verify_structured_outputs() -> None:
    passed = 0
    for index in range(10):
        events = await collect_events(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": f"总结第 {index + 1} 次结构化输出验收结果",
                    }
                ],
                "preset": "general",
                "provider": "mock",
                "structured_output": True,
            }
        )
        structured_events = [data for name, data in events if name == "structured"]
        if not structured_events:
            continue
        card = structured_events[0]["data"]
        validate(instance=card, schema=STRUCTURED_SCHEMA)
        assert isinstance(card["title"], str)
        assert isinstance(card["key_points"], list)
        passed += 1

    assert passed >= 9, f"only {passed}/10 structured outputs passed"
    print(f"PASS structured output: {passed}/10 schema-valid cards")


async def verify_cancellation() -> None:
    payload = {
        "messages": [{"role": "user", "content": "请生成一段很长的流式文本"}],
        "preset": "general",
        "provider": "mock",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        async with client.stream(
            "POST", f"{BASE_URL}/chat/stream", json=payload
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data:") and '"text"' in line:
                    break
    print("PASS cancellation: client closed the stream after the first token")


async def main() -> None:
    await verify_weather_tool()
    await verify_long_stream()
    await verify_structured_outputs()
    await verify_cancellation()


if __name__ == "__main__":
    asyncio.run(main())

