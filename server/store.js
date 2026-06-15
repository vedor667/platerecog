/**
 * Tiny JSON-file data store (no external DB).
 *
 *   data/captures.json  — log of recognized plates  [{id, plate, province, confidence, ts}]
 *   data/registry.json  — plate -> owner mapping     [{plate, name, idcode, note}]
 *
 * Low write volume (manual captures), single process, so synchronous fs with
 * atomic rename is plenty. Plates are matched on a normalized key (uppercase,
 * no spaces) so "กข 1234" and "กข1234" resolve to the same owner.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const CAPTURES = path.join(DATA_DIR, "captures.json");
const REGISTRY = path.join(DATA_DIR, "registry.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CAPTURES)) fs.writeFileSync(CAPTURES, "[]");
  if (!fs.existsSync(REGISTRY)) fs.writeFileSync(REGISTRY, "[]");
}
ensure();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}
function writeJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic on the same filesystem
}

export function normPlate(p) {
  return (p || "").toString().toUpperCase().replace(/\s+/g, "").trim();
}

// Owners are matched on the LAST 4 DIGITS of the plate number. Duplicates on
// the last 4 are rare, and this is robust to ANPR misreading the province
// letters or leading characters. Configurable via MATCH_DIGITS (default 4).
const MATCH_DIGITS = Number(process.env.MATCH_DIGITS) || 4;
export function plateKey(p) {
  const digits = (p || "").toString().replace(/\D/g, "");
  return digits.slice(-MATCH_DIGITS);
}

// Don't re-log the same plate (by key) more than once within this window.
const DEDUPE_MS = (Number(process.env.DEDUPE_SECONDS) || 60) * 1000;

let seq = Date.now();
const nextId = () => (seq++).toString(36);

// --- captures --------------------------------------------------------------
export function listCaptures() {
  const reg = readJson(REGISTRY);
  const owners = new Map();
  for (const r of reg) {
    const k = plateKey(r.plate);
    if (k && !owners.has(k)) owners.set(k, r);
  }
  return readJson(CAPTURES)
    .sort((a, b) => b.ts - a.ts)
    .map((c) => {
      const o = owners.get(plateKey(c.plate));
      return { ...c, owner: o ? { name: o.name, idcode: o.idcode, note: o.note } : null };
    });
}
export function addCapture({ plate, province, confidence }) {
  const list = readJson(CAPTURES);
  const np = normPlate(plate);
  const key = plateKey(np);
  const now = Date.now();

  // De-dupe: skip if the same key was logged very recently (camera sees the
  // same car for several seconds during continuous scanning).
  if (key) {
    const recent = list.find((c) => plateKey(c.plate) === key && now - c.ts < DEDUPE_MS);
    if (recent) return { duplicate: true, of: recent.id };
  }

  const rec = {
    id: nextId(),
    plate: np,
    province: province || null,
    confidence: Number(confidence) || 0,
    ts: now,
  };
  list.push(rec);
  writeJson(CAPTURES, list);
  const reg = readJson(REGISTRY).find((r) => plateKey(r.plate) === key);
  return { ...rec, owner: reg ? { name: reg.name, idcode: reg.idcode, note: reg.note } : null };
}
export function deleteCapture(id) {
  writeJson(CAPTURES, readJson(CAPTURES).filter((c) => c.id !== id));
}
export function clearCaptures() {
  writeJson(CAPTURES, []);
}

// --- registry (plate -> owner) ---------------------------------------------
export function listRegistry() {
  return readJson(REGISTRY).sort((a, b) => normPlate(a.plate).localeCompare(normPlate(b.plate)));
}
export function upsertRegistry({ plate, name, idcode, note }) {
  const np = normPlate(plate);
  if (!np) throw new Error("plate is required");
  const list = readJson(REGISTRY);
  const rec = { plate: np, name: name || "", idcode: idcode || "", note: note || "" };
  const i = list.findIndex((r) => normPlate(r.plate) === np);
  if (i >= 0) list[i] = rec; else list.push(rec);
  writeJson(REGISTRY, list);
  return rec;
}
export function deleteRegistry(plate) {
  const np = normPlate(plate);
  writeJson(REGISTRY, readJson(REGISTRY).filter((r) => normPlate(r.plate) !== np));
}
