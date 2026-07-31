from PIL import Image, ImageDraw

BG = (234, 88, 12)  # accent orange
PLATE = (255, 255, 255)
FOOD = (22, 163, 74)  # green


def make_icon(size: int, path: str, corner_radius_pct: float = 0.0):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if corner_radius_pct > 0:
        draw.rounded_rectangle([0, 0, size, size], radius=int(size * corner_radius_pct), fill=BG)
    else:
        draw.rectangle([0, 0, size, size], fill=BG)

    cx, cy = size / 2, size / 2
    plate_r = size * 0.32
    draw.ellipse([cx - plate_r, cy - plate_r, cx + plate_r, cy + plate_r], fill=PLATE)

    food_r = size * 0.16
    draw.ellipse(
        [cx - food_r, cy - food_r * 0.9, cx + food_r * 0.5, cy + food_r * 0.9],
        fill=FOOD,
    )
    draw.ellipse(
        [cx - food_r * 0.2, cy - food_r * 0.6, cx + food_r * 0.9, cy + food_r * 0.6],
        fill=(217, 119, 6),
    )

    # fork
    fork_x = cx + plate_r * 0.75
    draw.line([fork_x, cy - plate_r * 0.9, fork_x, cy + plate_r * 0.9], fill=BG, width=max(2, size // 40))

    img.save(path)


make_icon(192, "icon-192.png", corner_radius_pct=0.18)
make_icon(512, "icon-512.png", corner_radius_pct=0.18)
make_icon(180, "apple-touch-icon.png", corner_radius_pct=0.0)
print("icons generated")
