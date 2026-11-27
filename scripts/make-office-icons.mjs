// Builds the website's "Mellerick Office" icons: the company logo with a dark
// OFFICE band, so the laptop's app icon can't be mistaken for the phone app.
// Run: node scripts/make-office-icons.mjs  (writes public/office-icon-*.png)
import sharp from "sharp";

async function make(size, out, { maskable = false } = {}) {
  const band = Math.round(size * 0.24);
  // Trim the source's white margin, then fit the mark into the space above
  // the band (smaller when maskable, to stay inside the safe zone).
  const boxW = Math.round(size * (maskable ? 0.7 : 0.88));
  const boxH = Math.round((size - band) * (maskable ? 0.6 : 0.8));
  const logo = await sharp("public/icon-512.png")
    .trim()
    .resize(boxW, boxH, { fit: "inside", background: "#ffffff" })
    .toBuffer();
  const meta = await sharp(logo).metadata();
  const font = Math.round(band * 0.6);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="0" y="${size - band}" width="${size}" height="${band}" fill="#0f172a"/>
    <text x="50%" y="${size - band / 2}" dy="0.35em" text-anchor="middle"
      font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold"
      font-size="${font}" letter-spacing="${Math.round(font * 0.12)}" fill="#ffffff">OFFICE</text>
  </svg>`;
  const top = Math.round((size - band - meta.height) / 2 + (maskable ? size * 0.05 : 0));
  await sharp({ create: { width: size, height: size, channels: 4, background: "#ffffff" } })
    .composite([
      { input: logo, top, left: Math.round((size - meta.width) / 2) },
      { input: Buffer.from(svg), top: 0, left: 0 },
    ])
    .png()
    .toFile(out);
}

await make(192, "public/office-icon-192.png");
await make(512, "public/office-icon-512.png");
await make(512, "public/office-icon-512-maskable.png", { maskable: true });
await make(180, "public/office-apple-touch-icon.png");
