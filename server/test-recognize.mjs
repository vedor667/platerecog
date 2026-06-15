/**
 * Quick API test — sends one image to Plate Recognizer and prints the raw
 * response plus our normalized shape. Lets you verify the token works and see
 * exactly what Thai plates return (Thai script vs. Latin).
 *
 * Usage:
 *   node test-recognize.mjs path\to\plate.jpg
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.PLATE_API_TOKEN;
const API_URL = process.env.PLATE_API_URL || "https://api.platerecognizer.com/v1/plate-reader/";
const REGIONS = process.env.PLATE_REGIONS || ""; // empty = let the API auto-detect

const imgPath = process.argv[2];

if (!TOKEN) {
  console.error("✗ PLATE_API_TOKEN not set in .env");
  process.exit(1);
}
if (!imgPath || !fs.existsSync(imgPath)) {
  console.error("✗ Pass a path to an image: node test-recognize.mjs path\\to\\plate.jpg");
  process.exit(1);
}

const buf = fs.readFileSync(imgPath);
const form = new FormData();
form.append("upload", new Blob([buf]), path.basename(imgPath));
if (REGIONS) form.append("regions", REGIONS);

console.log(`→ Sending ${imgPath} (${(buf.length / 1024).toFixed(0)} KB) to ${API_URL} ...`);

const res = await fetch(API_URL, {
  method: "POST",
  headers: { Authorization: `Token ${TOKEN}` },
  body: form,
});

const data = await res.json();

if (!res.ok) {
  console.error(`✗ API error ${res.status}:`, data);
  process.exit(1);
}

console.log("\n=== RAW response ===");
console.log(JSON.stringify(data, null, 2));

const best = (data.results || [])[0];
console.log("\n=== Normalized (what the app shows) ===");
if (!best) {
  console.log("No plate detected.");
} else {
  console.log({
    plate: best.plate ? best.plate.toUpperCase() : null,
    province: best.region?.code ?? null,
    confidence: best.score,
    box: best.box ? [best.box.xmin, best.box.ymin, best.box.xmax, best.box.ymax] : null,
    box_confidence: best.dscore,
    candidates: (best.candidates || []).map((c) => `${c.plate} (${c.score})`),
  });
}
