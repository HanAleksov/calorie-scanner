import base64
import json
import os
from io import BytesIO

import anthropic
from PIL import Image

MODEL = "claude-opus-5"

# Anthropic's own guidance: vision quality plateaus above ~1.15 megapixels — beyond that,
# extra resolution costs tokens without helping accuracy. Phone photos are typically 8-12MP,
# so this is a large, quality-neutral token/bandwidth cut. Never upscales.
MAX_IMAGE_PIXELS = 1_150_000
IMAGE_JPEG_QUALITY = 87

SYSTEM_PROMPT = """You are a nutrition estimation assistant for a personal calorie-tracking app.
Given one or two photos of the same meal (a second photo, if present, is a different angle of the
same food taken to help you judge portions more accurately), identify each distinct food item,
estimate its portion size in grams, and estimate calories and macros (protein, carbs, fat) for that
item specifically — not just a combined total. The per-item numbers matter: the app lets the user
correct your gram estimate for any item afterward and rescales that item's calories/macros
proportionally, so each item's figures must be internally consistent with its own est_grams (i.e.
correspond to a plausible calories-per-gram density for that food).

MULTI-IMAGE DEDUPLICATION: If more than one photo is given, they are different angles of the exact
same single meal — never treat them as separate meals or add up quantities across photos. Merge
everything you see across all photos into ONE consolidated itemized list; never list the same food
item twice just because it's visible in more than one photo.

EDIBLE MASS ONLY: est_grams and every macro must reflect edible mass, never packaging, bone, shell,
pit, or peel. For bone-in meat (whole chicken leg quarters, wings, drumsticks, ribs, chops on the
bone), subtract the inedible bone mass before estimating nutrition — bone is roughly 30-35% of a
chicken leg quarter or wing's gross weight (more for wings, less for a thigh or leg alone). Make the
edible-mass basis explicit in the item name, e.g. "Roasted chicken leg quarter - edible meat ~150g",
rather than implying the bone-in weight is what's nutritionally counted.

PORTION ANCHORS: Use reference objects visible in frame (a standard dinner plate ~27cm across,
cutlery, cups, a hand) to judge true volume and weight. Estimate the quantity actually visible in the
photo, not a manufacturer's standard serving size — if the photo clearly shows more or less than a
"typical" serving (e.g. a large handful of chips, not a 30g bag-serving), go with what's visible.

USER NOTES: If the user provides a text note alongside the photo(s), treat it as authoritative for
whatever it specifically describes. A note that adds an item not fully shown in the photo (e.g. "add
3 slices of bread") means: add exactly one corresponding item, sized from the note, applied once.
A note correcting something already visible (e.g. "no sugar", "homemade with olive oil") should
adjust that detail only. Either way, do not let the note cause you to re-describe, duplicate, or
re-estimate the rest of the plate differently than what the photo itself shows — everything the note
doesn't mention should still be assessed purely from the image(s).

COOKING FATS: Cooking method adds calories that often aren't visually obvious — don't let a dish
"look lean" talk you out of accounting for it. Frying, sautéing, pan-searing, stir-frying, and
roasting/basting typically add absorbed oil, butter, or ghee that's rarely fully visible as a
puddle or sheen in the photo. When you can identify or infer the cooking method (a glossy/browned
surface, a stir-fry, fried batter, a sautéed vegetable side, a curry or dish from a cuisine that
commonly cooks with generous oil/ghee/butter), add a reasonable fat estimate for the absorbed
cooking fat on top of the ingredient's own inherent fat — do not estimate as if it were steamed,
boiled, or raw. As a rough anchor: a home-cooked stir-fry or sautéed vegetable portion typically
absorbs 1-2 tsp (5-10g) of oil per serving; a fried or deep-fried item can absorb substantially
more depending on batter/breading and surface area. If you can't tell whether a method used added
fat, let this raise your confidence rating toward "low"/"medium" rather than silently defaulting
to the leanest interpretation — but always give a number, never omit the fat.

If the dish is a stacked or mixed dish, has sauces, or portions are hard to judge, set confidence to
"low" — do not present a guess as precise. Set confidence to "medium" when some items are clear but
others are estimated. Set confidence to "high" only when portions and ingredients are clearly
visible and unambiguous. A second angle photo, when given, should let you raise confidence versus a
single photo of the same dish.

Also rate the meal's overall "energy quality" on a 0-5 scale — this means how likely the food is to
give steady, sustained energy versus a quick spike and crash. Use this rubric:
5 = whole, minimally processed food, good protein/fiber, little to no added sugar or refined carbs
    (e.g. grilled meat with vegetables, oats, eggs, legumes, plain yogurt with fruit)
3-4 = mostly balanced with some processed or refined components, or one strong plus one weak factor
1-2 = mostly refined carbs/added sugar/fried, low protein/fiber, likely a spike-then-crash
0 = essentially empty calories (candy, soda, sugary pastry with little else)
This is about food quality, not calorie count or portion size — a large healthy meal can still score
high, and a small sugary snack can still score low.

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
        "energy_score": {"type": "number"},
    },
    "required": ["items", "total_calories", "protein_g", "carbs_g", "fat_g", "confidence", "energy_score"],
    "additionalProperties": False,
}


def _client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


def _optimize_image(image_bytes: bytes, media_type: str) -> tuple[bytes, str]:
    """Downscale to MAX_IMAGE_PIXELS before sending to the API, if the source exceeds it.
    Leaves already-small images untouched (no redundant re-compression). Only affects the
    copy sent to Claude — the original upload on disk is never touched. Falls back to the
    original bytes on any processing error, so a resize hiccup never blocks an analysis."""
    try:
        img = Image.open(BytesIO(image_bytes))
        width, height = img.size
        if width * height <= MAX_IMAGE_PIXELS:
            return image_bytes, media_type
        scale = (MAX_IMAGE_PIXELS / (width * height)) ** 0.5
        img = img.convert("RGB").resize(
            (max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS
        )
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=IMAGE_JPEG_QUALITY)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        return image_bytes, media_type


LANGUAGE_NAMES = {"en": "English", "bg": "Bulgarian"}


def analyze_meal_photo(images: list[tuple[bytes, str]], lang: str = "en", user_note: str | None = None) -> dict:
    """images: list of (image_bytes, media_type) tuples — one or two angles of the same meal.
    user_note: optional free-text hint from the user (e.g. "no sugar", "half portion", "homemade
    with olive oil") to help disambiguate what the photo alone can't show. Treat it as a helpful
    hint, not ground truth — still estimate from what's visible."""
    client = _client()
    lang_name = LANGUAGE_NAMES.get(lang, "English")

    image_blocks = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": base64.standard_b64encode(image_bytes).decode("utf-8"),
            },
        }
        for image_bytes, media_type in (_optimize_image(b, mt) for b, mt in images)
    ]
    prompt_text = (
        "Analyze this meal photo and estimate calories, macros, and energy quality."
        if len(images) == 1
        else "Analyze these two photos of the same meal (different angles) and estimate calories, macros, and energy quality."
    )
    if user_note:
        prompt_text += (
            f"\n\nUser note: {user_note}\n"
            "Apply this per the USER NOTES rule — handle exactly what it describes, once, without "
            "changing how you assess the rest of the plate."
        )

    response = client.messages.create(
        model=MODEL,
        max_tokens=3072,
        system=[
            # Cached separately from the language line so the large static prompt is reused
            # across both languages and every call, not fragmented into per-language entries.
            {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": f"Write every text value (food item names) in {lang_name}."},
        ],
        output_config={"format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}},
        messages=[
            {
                "role": "user",
                "content": [*image_blocks, {"type": "text", "text": prompt_text}],
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


SCALE_SYSTEM_PROMPT = """You are reading a screenshot from a smart scale / bioelectrical impedance
(BIA) app (e.g. Huawei Health, Honor Health, or similar). Extract the numeric health metrics shown
on screen. Only report a metric if it is actually visible in the screenshot — if a field isn't
shown, return null for it rather than guessing or estimating. weight_kg is the one metric that must
always be present; every other field is optional and should be null when absent. Convert any value
shown in a different unit (e.g. lb, %) to the schema's stated unit. Values only — no units or extra
text inside them."""

SCALE_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "weight_kg": {"type": "number"},
        "body_fat_pct": {"type": ["number", "null"]},
        "fat_mass_kg": {"type": ["number", "null"]},
        "skeletal_muscle_kg": {"type": ["number", "null"]},
        "bmr_kcal": {"type": ["integer", "null"]},
        "body_water_pct": {"type": ["number", "null"]},
        "protein_pct": {"type": ["number", "null"]},
    },
    "required": [
        "weight_kg",
        "body_fat_pct",
        "fat_mass_kg",
        "skeletal_muscle_kg",
        "bmr_kcal",
        "body_water_pct",
        "protein_pct",
    ],
    "additionalProperties": False,
}


def parse_scale_screenshot(image_bytes: bytes, media_type: str) -> dict:
    """Extract BIA smart-scale metrics from a screenshot. Only weight_kg is guaranteed to be
    non-null — every other field comes back null when that metric isn't shown on screen, never
    fabricated. Not cached/multi-language like analyze_meal_photo — this prompt is small and
    single-purpose, and the values it returns are numbers, not language-dependent text."""
    client = _client()
    opt_bytes, opt_media_type = _optimize_image(image_bytes, media_type)

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=512,
            system=[{"type": "text", "text": SCALE_SYSTEM_PROMPT}],
            output_config={"format": {"type": "json_schema", "schema": SCALE_RESPONSE_SCHEMA}},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": opt_media_type,
                                "data": base64.standard_b64encode(opt_bytes).decode("utf-8"),
                            },
                        },
                        {"type": "text", "text": "Extract the scale metrics from this screenshot."},
                    ],
                }
            ],
        )
    except anthropic.APIError as e:
        raise RuntimeError("Couldn't read that screenshot — try a clearer photo.") from e

    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to read this screenshot.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The scan was cut off before it finished. Try again.")

    text = next(block.text for block in response.content if block.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError("The scan response wasn't valid — try again.") from e
