import json
import os

import anthropic

MODEL = "claude-opus-5"

SYSTEM_PROMPT = """You are a friendly, concise nutrition coach inside a personal calorie-tracking app.
Given a snapshot of someone's day so far (current local time, calories/macros eaten vs their goal,
and what they've logged), give ONE short, actionable tip or piece of encouragement for the rest of
the day. Keep it to 1-2 short sentences, conversational, no lecturing. If they're on track, it's
completely fine to just say so and encourage them to keep going — don't invent a problem that isn't
there. Consider the time of day: e.g. don't suggest breakfast in the evening, and if it's late in the
day and they're well under their calorie goal with few hours left, that's worth a gentle mention."""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {"tip": {"type": "string"}},
    "required": ["tip"],
    "additionalProperties": False,
}

LANGUAGE_NAMES = {"en": "English", "bg": "Bulgarian"}


def _client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


def generate_tip(context: dict, lang: str = "en") -> str:
    client = _client()
    lang_name = LANGUAGE_NAMES.get(lang, "English")
    system = SYSTEM_PROMPT + f"\n\nRespond in {lang_name}."
    prompt = (
        f"Local time: {context['local_time']}.\n"
        f"Calories so far: {context['calories_eaten']} / {context['calories_goal']} kcal.\n"
        f"Protein: {context['protein_eaten']}/{context['protein_goal']}g, "
        f"Carbs: {context['carbs_eaten']}/{context['carbs_goal']}g, "
        f"Fat: {context['fat_eaten']}/{context['fat_goal']}g.\n"
        f"Meals logged today: {context['meals_summary'] or 'none yet'}.\n"
        f"Goal type: {context.get('goal_type') or 'not set'}."
    )

    response = client.messages.create(
        model=MODEL,
        max_tokens=500,
        system=system,
        output_config={"format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )

    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to generate a tip.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The tip response was cut off. Try again.")

    text = next(block.text for block in response.content if block.type == "text")
    try:
        return json.loads(text)["tip"]
    except json.JSONDecodeError as e:
        raise RuntimeError("The tip response wasn't valid — try again.") from e
