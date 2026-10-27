from typing import Literal

from pydantic import BaseModel, Field

MessageRole = Literal["system", "user", "assistant", "tool"]
PresetId = Literal["general", "translator", "reviewer"]
ProviderId = Literal["auto", "mock", "deepseek", "qwen"]


class ChatMessage(BaseModel):
    role: MessageRole
    content: str = Field(min_length=1, max_length=20_000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    preset: PresetId = "general"
    provider: ProviderId = "auto"
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: int = Field(default=1_200, ge=64, le=4_096)
    structured_output: bool = False

