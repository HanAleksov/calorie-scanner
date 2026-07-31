import base64
import json
import os

import anthropic

MODEL = "claude-opus-5"

SYSTEM_PROMPT = """You are a nutrition estimation assistant for a personal calorie-tracking app.
Given a photo of a meal, identify each distinct food item, estimate its portion size in grams,
and estimate calories and macros (protein, carbs, fat) for that item specifically — not just a
combined total. The per-item numbers matter: the app lets the user correct your gram estimate
for any item afterward and rescales that item's calories/macros proportionally, so each item's
figures must be internally consistent with its own est_grams (i.e. correspond to a plausible
calories-per-gram density for that food).

Use any visible reference objects (a standard dinner plate ~27cm, utensils, a hand) to calibrate
portion size. If the dish is a stacked or mixed dish, has sauces, or portions are hard to judge,
set confidence to "low" — do not present a guess as precise. Set confidence to "medium" when some
items are clear but others are estimated. Set confidence to "high" only when portions and
ingredients are clearly visible and unambiguous.

total_calories/protein_g/carbs_g/fat_g at the top level must equal the sum across all items.

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
                    "calories": {"type": "integer"},
                    "protein_g": {"type": "number"},
                    "carbs_g": {"type": "number"},
                    "fat_g": {"type": "number"},
                },
                "required": ["name", "est_grams", "calories", "protein_g", "carbs_g", "fat_g"],
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
        max_tokens=3072,
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
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The analysis was cut off before it finished. Try again.")

    text = next(block.text for block in response.content if block.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError("The analysis response wasn't valid — try again.") from e
