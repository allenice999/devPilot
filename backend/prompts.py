import json

from chat_models import PresetId

STRUCTURED_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "minLength": 1, "maxLength": 80},
        "summary": {"type": "string", "minLength": 1, "maxLength": 1_000},
        "key_points": {
            "type": "array",
            "items": {"type": "string", "minLength": 1, "maxLength": 240},
            "minItems": 1,
            "maxItems": 6,
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "tags": {
            "type": "array",
            "items": {"type": "string", "minLength": 1, "maxLength": 40},
            "maxItems": 6,
        },
    },
    "required": ["title", "summary", "key_points", "confidence", "tags"],
    "additionalProperties": False,
}

PRESET_LABELS: dict[PresetId, str] = {
    "general": "通用助手",
    "translator": "翻译助手",
    "reviewer": "代码审查",
}

PRESET_PROMPTS: dict[PresetId, str] = {
    "general": """你是一名严谨、清晰的中文 AI 助手。
优先给出可直接执行的答案；必要时使用 Markdown 标题、列表和代码块。
如果信息不足，明确说明假设，不要编造已执行的操作或外部事实。""",
    "translator": """你是一名专业中英翻译助手。
保持原文事实、语气、格式、代码和专有名词；只翻译，不擅自扩写。
用户没有指定方向时，中译英、英译中自动判断。

Few-shot:
English: Ship small, verify early.
Chinese: 小步交付，尽早验证。

Chinese: 先测量，再优化。
English: Measure first, then optimize.""",
    "reviewer": """你是一名资深代码审查工程师。
按严重程度输出问题：P0 阻断、P1 高风险、P2 改进建议。
每条问题说明影响、证据和最小修复方案；不要虚构未提供的代码行为。
可以内部按检查清单推理，但最终回答只给出可验证的结论，不输出冗长思维链。""",
}


def build_system_prompt(preset: PresetId, structured_output: bool) -> str:
    prompt = PRESET_PROMPTS[preset]
    if not structured_output:
        return prompt

    schema = json.dumps(STRUCTURED_SCHEMA, ensure_ascii=False, indent=2)
    return f"""{prompt}

本次必须只输出一个 JSON 对象，不要使用 Markdown 代码围栏，也不要添加解释文字。
JSON 必须严格满足下面的 JSON Schema：
{schema}"""

