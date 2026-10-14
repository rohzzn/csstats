"""Trim + resample the collectible medal PNGs for crisp header rendering.

Source PNGs are 512x384 / 1024x768 with 25-70% transparent side padding, shown ~30px tall.
That padding makes medals look tiny and unevenly spaced, and a 12-25x in-browser downscale
aliases. This trims every image to its visible (alpha) bounds plus a 2% margin and resamples
with premultiplied-alpha Lanczos to TARGET_H px tall (4x the 30px display height -> sharp on
1x/2x/3x screens). File names are unchanged so collectibles-map.js keeps working.

    python tools/process-collectibles.py [src_dir] [out_dir]
    (then copy out_dir over collectibles-images/ and refresh the w/h fields in collectibles-map.js)
"""
import sys
from pathlib import Path

from PIL import Image

TARGET_H = 128
ALPHA_THRESHOLD = 10
MARGIN_RATIO = 0.02

src = Path(sys.argv[1] if len(sys.argv) > 1 else "collectibles-images")
out = Path(sys.argv[2] if len(sys.argv) > 2 else ".dev/assets-out/collectibles-images")
out.mkdir(parents=True, exist_ok=True)

before = after = 0
rows = []
for path in sorted(src.glob("*.png")):
    im = Image.open(path).convert("RGBA")
    alpha = im.getchannel("A").point(lambda a: 255 if a > ALPHA_THRESHOLD else 0)
    bbox = alpha.getbbox()
    if not bbox:
        continue
    l, t, r, b = bbox
    m = round(max(r - l, b - t) * MARGIN_RATIO)
    l, t = max(0, l - m), max(0, t - m)
    r, b = min(im.width, r + m), min(im.height, b + m)
    cropped = im.crop((l, t, r, b))

    h = min(TARGET_H, cropped.height)
    w = max(1, round(cropped.width * h / cropped.height))
    # premultiplied alpha avoids dark halos around anti-aliased edges
    resized = cropped.convert("RGBa").resize((w, h), Image.LANCZOS, reducing_gap=3.0).convert("RGBA")

    dest = out / path.name
    resized.save(dest, optimize=True)
    before += path.stat().st_size
    after += dest.stat().st_size
    rows.append((path.name, im.size, (r - l, b - t), resized.size))

print(f"processed {len(rows)} images: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")
for name, orig, crop, final in rows[:: max(1, len(rows) // 12)]:
    print(f"  {name[:60]:60s} {orig} -> crop {crop} -> {final}")
