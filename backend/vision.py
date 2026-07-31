import base64
import json
import os

import anthropic

MODEL = "claude-opus-5"

SYSTEM_PROMPT = """You are a nutrition estimation assistant for a personal calorie-tracking app.
Given a photo of a meal, identify each distinct food item, estimate its portion size in grams,
and estimate total calories and macros (protein, carbs, fat) in grams.

Use any visible reference objects (a standard dinner plate ~27cm, utensils, a hand) to calibrate
portion size. If the dish is a stacked or mixed dish, has sauces, or portions are hard to judge,
set confidence to "low" — do not present a guess as precise. Set confidence to "medium" when some
items are clear but others are estimated. Set confidence to "high" only when portions and
ingredients are clearly visible and unambiguous.

Respond with your best estimate even under uncertainty — never refuse to estimate."""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "est_grams": {"type": "number"},
                },
                "required": ["name", "est_grams"],
                "additionalProperties": False,
            },
        },
        "total_calories": {"type": "integer"},
        "protein_g": {"type": "number"},
        "carbs_g": {"type": "number"},
        "fat_g": {"type": "number"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["items", "total_calories", "protein_g", "carbs_g", "fat_g", "confidence"],
    "additionalProperties": False,
}


def _client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


LANGUAGE_NAMES = {"en": "English", "bg": "Bulgarian"}


def analyze_meal_photo(image_bytes: bytes, media_type: str, lang: str = "en") -> dict:
    client = _client()
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    lang_name = LANGUAGE_NAMES.get(lang, "English")
    system = SYSTEM_PROMPT + f"\n\nWrite every text value (food item names) in {lang_name}."

    response = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        system=system,
        output_config={"format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": "Analyze this meal photo and estimate calories and macros.",
                    },
                ],
            }
        ],
    )

    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to analyze this image.")

    text = next(block.text for block in response.content if block.type == "text")
    return json.loads(text)
