from PIL import Image, ImageDraw
import os

os.makedirs("icons", exist_ok=True)
sizes = [16, 48, 128]

for size in sizes:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = max(1, size // 10)
    draw.rounded_rectangle([margin, margin, size - margin, size - margin], radius=size // 4, fill=(124, 106, 247))
    dot_r = max(2, size // 6)
    cx, cy = size // 2, size // 2
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=(255, 255, 255))
    img.save(f"icons/icon{size}.png")
    print(f"Created icons/icon{size}.png")

print("Done!")
