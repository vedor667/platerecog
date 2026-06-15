/**
 * Thai license plate reader — Node backend.
 *
 * Responsibilities:
 *   1. Serve the static frontend (../frontend).
 *   2. POST /recognize: receive an uploaded image, forward it to the
 *      Plate Recognizer ANPR API (Thailand-aware), and return a normalized
 *      JSON shape the frontend already understands:
 *        { plate, province, confidence, detection:{...}, raw:[...] }
 *
 * No heavy ML runs here — the API does the recognition. This keeps the VPS
 * light (no PyTorch) and the response fast.
 *
 * Requires Node >= 18 (uses global fetch / FormData / Blob).
 */

import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import * as store from "./store.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.PLATE_API_TOKEN;
const API_URL = process.env.PLATE_API_URL || "https://api.platerecognizer.com/v1/plate-reader/";
const REGIONS = process.env.PLATE_REGIONS || ""; // empty = API auto-detects (the "th" code may be rejected)

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB cap
});

app.use(express.json({ limit: "1mb" }));

// --- serve the frontend ----------------------------------------------------
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    anpr: API_URL,
    regions: REGIONS,
    token_configured: Boolean(TOKEN),
  });
});

// --- recognition proxy -----------------------------------------------------
app.post("/recognize", upload.single("file"), async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({ error: "PLATE_API_TOKEN is not set on the server." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded (field name must be 'file')." });
  }

  try {
    const form = new FormData();
    form.append(
      "upload",
      new Blob([req.file.buffer], { type: req.file.mimetype || "image/jpeg" }),
      req.file.originalname || "frame.jpg"
    );
    if (REGIONS) form.append("regions", REGIONS);

    const apiRes = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Token ${TOKEN}` },
      body: form,
    });

    const data = await apiRes.json();

    if (!apiRes.ok) {
      // Pass through the API's error (bad token, quota, etc.).
      return res.status(apiRes.status).json({
        error: data.detail || data.error || "ANPR API error",
        status: apiRes.status,
      });
    }

    return res.json(normalize(data));
  } catch (err) {
    console.error("recognize failed:", err);
    return res.status(502).json({ error: "Could not reach ANPR API: " + err.message });
  }
});

/**
 * Map Plate Recognizer's response to the frontend's expected shape.
 * Plate Recognizer returns: { results: [ { plate, score, dscore,
 *   box:{xmin,ymin,xmax,ymax}, region:{code,score}, candidates:[...] } ] }
 */
function normalize(data) {
  const results = data.results || [];
  if (results.length === 0) {
    return { plate: null, province: null, confidence: 0, raw: [], detection: { used: false, boxes: 0 } };
  }

  const best = results[0];
  const b = best.box;
  const box = b ? [b.xmin, b.ymin, b.xmax, b.ymax] : null;

  // Region prediction is unreliable for Thai plates on the default engine;
  // treat "unknown" / very-low-score guesses as no province.
  const regionCode = best.region && best.region.code;
  const province = regionCode && regionCode !== "unknown" && (best.region.score || 0) > 0.3 ? regionCode : null;

  return {
    plate: best.plate ? best.plate.toUpperCase() : null,
    province,
    confidence: typeof best.score === "number" ? best.score : 0,
    detection: box
      ? {
          used: true,
          boxes: results.length,
          box,
          box_confidence: typeof best.dscore === "number" ? best.dscore : best.score || 0,
        }
      : { used: false, boxes: results.length },
    raw: (best.candidates || []).map((c) => ({ text: c.plate, confidence: c.score })),
  };
}

// --- captures log ----------------------------------------------------------
app.get("/api/captures", (req, res) => {
  let list = store.listCaptures(); // newest first, owner-enriched
  const since = Number(req.query.since);
  if (since) list = list.filter((c) => c.ts > since);
  const limit = Number(req.query.limit);
  if (limit > 0) list = list.slice(0, limit);
  res.json(list);
});

app.post("/api/captures", (req, res) => {
  const { plate, province, confidence } = req.body || {};
  if (!plate || !plate.trim()) return res.status(400).json({ error: "plate is required" });
  res.json(store.addCapture({ plate, province, confidence }));
});

app.delete("/api/captures/:id", (req, res) => {
  store.deleteCapture(req.params.id);
  res.json({ ok: true });
});

app.post("/api/captures/clear", (_req, res) => {
  store.clearCaptures();
  res.json({ ok: true });
});

// --- registry (plate -> owner) ---------------------------------------------
app.get("/api/registry", (_req, res) => res.json(store.listRegistry()));

app.post("/api/registry", (req, res) => {
  try {
    res.json(store.upsertRegistry(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/registry/:plate", (req, res) => {
  store.deleteRegistry(req.params.plate);
  res.json({ ok: true });
});

// --- backups ---------------------------------------------------------------
app.get("/api/backups", (_req, res) => res.json(store.listBackups()));
app.post("/api/backups", (_req, res) => res.json(store.backupNow() || { error: "backup failed" }));
app.post("/api/backups/restore", (req, res) => {
  try {
    res.json(store.restoreBackup((req.body || {}).file));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Hourly snapshot of the data files (kept in server/data/backups/).
store.backupNow();
setInterval(() => {
  const r = store.backupNow();
  if (r) console.log(`backup ok — ${r.captures} captures, ${r.registry} owners (${r.kept} snapshots kept)`);
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Thai LPR server listening on http://0.0.0.0:${PORT}`);
  if (!TOKEN) console.warn("⚠  PLATE_API_TOKEN not set — /recognize will return 500 until you add it.");
});
