import json
import os

import anthropic

MODEL = "claude-sonnet-5"

SYSTEM_PROMPT = """You are a friendly, concise nutrition coach inside a personal calorie-tracking app.
Given a snapshot of someone's day so far (current local time, calories/macros eaten vs their goal,
and what they've logged), give ONE short, actionable tip or piece of encouragement for the rest of
the day. Keep it to 1-2 short sentences, conversational, no lecturing. If they're on track, it's
completely fine to just say so and encourage them to keep going — don't invent a problem that isn't
there. Consider the time of day: e.g. don't suggest breakfast in the evening, and if it's late in the
day and they're well under their calorie goal with few hours left, that's worth a gentle mention.
If their goal type is "gain": they're deliberately eating in a calorie surplus to build muscle, so
being at or over their calorie/protein goal is success, not a problem — never suggest cutting back.
If it's afternoon/evening and they're still meaningfully under their calorie or protein target with
few hours of eating windows left, be direct and specific about hitting the surplus today (e.g. name
a concrete easy add like a protein shake or a calorie-dense snack) rather than gently suggesting it
— hitting the number matters more here than for a "lose"/"maintain" goal. If their goal type is
"lose", keep the current gentle, encouraging tone about staying under budget; don't add urgency
there."""

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


ANALYST_SYSTEM_PROMPT = """You are a supportive coach inside a personal calorie-tracking app, writing
a short note that explains what its automatic weight/calorie analysis just found and what to do about
it. The person you're writing to is trying to gain weight/muscle and often genuinely struggles to eat
enough — hitting exact macro numbers every day is unrealistic for them, so never lecture about
precision, and never imply they've failed by missing a target.

Be warm and brief (2-4 short sentences): say what's happening in plain terms, briefly why (the data
point behind it), and 1-2 specific, low-effort next steps — a concrete food/timing suggestion, not
vague advice like "eat more protein" or "be consistent."

If the note is about an adherence gap (they're logging well below their current target, not a target
that's too low), the real issue is eating enough in the first place — do not just say "eat more."
Suggest one specific, low-effort tactic (an easy calorie-dense add, spreading intake across more/
smaller meals so it feels less overwhelming, a liquid-calorie option) and acknowledge that hitting a
big number every day is genuinely hard, without guilt-tripping.

You'll also be given how their protein/carbs/fat intake compares to target, not just calories. Only
bring up a macro if it's notably off (well under or well over) and relevant to what's happening — e.g.
if protein is running low, mention it's worth prioritizing since it protects muscle during a gain
phase; if a fat-mass finding lines up with fat intake also running high, it's fine to connect the two.
Don't recite every number just because you have it — one relevant macro callout is plenty.

If a target was actually changed, say so plainly in your own words and say why in one clause — never
use clinical/robotic phrasing like "delta," "kcal threshold," or "commit." Write like a person talking
to a friend, not a formula printing a log line."""

ANALYST_NOTE_SCHEMA = {
    "type": "object",
    "properties": {"note": {"type": "string"}},
    "required": ["note"],
    "additionalProperties": False,
}


def generate_analyst_note(context: dict, lang: str = "en") -> str:
    """context keys: goal_type, weight_velocity_kg_week, elapsed_days, avg_daily_intake,
    goal_calories, intake_adherence_pct, adherence (nutrition.calculate_macro_adherence()'s
    output — per-field {avg, goal, pct, status} for calories/protein_g/carbs_g/fat_g, lets the
    note reference any macro specifically, not just calories), findings (list of short
    plain-English fact strings), adherence_gap (bool), committed (bool), old_calories/
    new_calories (present if committed)."""
    client = _client()
    lang_name = LANGUAGE_NAMES.get(lang, "English")
    system = ANALYST_SYSTEM_PROMPT + f"\n\nRespond in {lang_name}."

    macro_lines = []
    for field, label in (("protein_g", "Protein"), ("carbs_g", "Carbs"), ("fat_g", "Fat")):
        m = context.get("adherence", {}).get(field)
        if m:
            macro_lines.append(f"{label}: averaging {m['avg']}g against a {m['goal']}g target ({m['status']}).")

    lines = [
        f"Goal type: {context.get('goal_type') or 'not set'}.",
        f"Weight velocity: {context['weight_velocity_kg_week']:+.2f} kg/week over {context['elapsed_days']} days.",
        f"Logged intake averages {context['avg_daily_intake']} kcal/day against a {context['goal_calories']} kcal "
        f"target ({context['intake_adherence_pct'] * 100:.0f}%).",
        *macro_lines,
        f"Findings: {'; '.join(context['findings']) if context['findings'] else 'none'}.",
        f"Adherence gap (eating well under their own current target): {'yes' if context['adherence_gap'] else 'no'}.",
    ]
    if context.get("committed"):
        lines.append(f"Target was just changed from {context['old_calories']} to {context['new_calories']} kcal.")
    else:
        lines.append("No target change was made this time.")
    prompt = "\n".join(lines)

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=500,
            system=system,
            output_config={"format": {"type": "json_schema", "schema": ANALYST_NOTE_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.APIError as e:
        raise RuntimeError("Couldn't generate a coach note this time.") from e

    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to generate a note.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The note response was cut off. Try again.")

    text = next(block.text for block in response.content if block.type == "text")
    try:
        return json.loads(text)["note"]
    except json.JSONDecodeError as e:
        raise RuntimeError("The note response wasn't valid — try again.") from e
