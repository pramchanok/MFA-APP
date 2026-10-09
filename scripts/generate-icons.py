"""Generate the original geometric app icon. Requires Pillow; no downloaded artwork."""
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
out.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((40, 40, 984, 984), radius=220, fill="#2256D7")
draw.polygon([(512, 190), (784, 296), (760, 590), (708, 694), (624, 778), (512, 846), (400, 778), (316, 694), (264, 590), (240, 296)], fill="#F4F7FB")
draw.rounded_rectangle((386, 452, 638, 646), radius=42, fill="#2256D7")
draw.arc((432, 320, 592, 510), 180, 360, fill="#2256D7", width=46)
draw.ellipse((489, 508, 535, 554), fill="#72E0BC")
draw.rounded_rectangle((500, 538, 524, 587), radius=10, fill="#72E0BC")
image.save(out / "icon.png")
for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    image.resize((size, size), Image.Resampling.LANCZOS).save(out / name)
image.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
image.save(out / "icon.icns")
print(f"Generated icons in {out}")
