import json
import os

import anthropic

MODEL = "claude-opus-5"

SYSTEM_PROMPT = """You are a nutrition planning assistant for a personal calorie-tracking app.
Given a person's daily calorie and macro targets, and any dietary preferences or restrictions
they've listed, design one full day of realistic, easy-to-prepare meals (breakfast, lunch,
dinner, and one snack) whose combined calories and macros land close to the targets
(within about 5%). Use real, ordinary foods and portion sizes a person could actually shop for
and cook — no exotic ingredients unless the preferences call for them. Respect any dietary
restrictions exactly (e.g. vegetarian, allergies) — never include a restricted ingredient.

For each meal give a short one-line rationale connecting it to their goal (e.g. "high-protein
start to hit your target early" or "fiber-rich carbs to fuel your workout")."""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "meals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "meal_type": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "rationale": {"type": "string"},
                    "calories": {"type": "integer"},
                    "protein_g": {"type": "number"},
                    "carbs_g": {"type": "number"},
                    "fat_g": {"type": "number"},
                },
                "required": ["meal_type", "name", "description", "rationale",
                             "calories", "protein_g", "carbs_g", "fat_g"],
                "additionalProperties": False,
            },
        },
        "daily_totals": {
            "type": "object",
            "properties": {
                "calories": {"type": "integer"},
                "protein_g": {"type": "number"},
                "carbs_g": {"type": "number"},
                "fat_g": {"type": "number"},
            },
            "required": ["calories", "protein_g", "carbs_g", "fat_g"],
            "additionalProperties": False,
        },
        "notes": {"type": "string"},
    },
    "required": ["meals", "daily_totals", "notes"],
    "additionalProperties": False,
}


def _client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


LANGUAGE_NAMES = {"en": "English", "bg": "Bulgarian"}


def generate_meal_plan(targets: dict, dietary_notes: str = "", lang: str = "en") -> dict:
    client = _client()
    lang_name = LANGUAGE_NAMES.get(lang, "English")
    system = SYSTEM_PROMPT + f"\n\nWrite every text value (meal names, descriptions, rationale, notes) in {lang_name}."
    prompt = (
        f"Daily targets: {targets['target_calories']} kcal, "
        f"{targets['protein_g']}g protein, {targets['carbs_g']}g carbs, {targets['fat_g']}g fat.\n"
        f"Dietary preferences/restrictions: {dietary_notes or 'none specified'}."
    )

    response = client.messages.create(
        model=MODEL,
        max_tokens=6000,
        system=system,
        output_config={"format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )

    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to generate a meal plan.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The meal plan response was cut off before it finished. Try again.")

    text = next(block.text for block in response.content if block.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError("The meal plan response wasn't valid — try again.") from e
