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
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_BACKUPS = Number(process.env.KEEP_BACKUPS) || 336; // hourly ≈ 14 days

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

// Reconcile a DETECTED plate to a registry entry, in priority order:
//   1. exact match on the detected plate alias (handles consistent misreads)
//   2. last-4 digits of the ACTUAL (real) plate the operator entered
//   3. last-4 digits of the detected plate
function findEntry(reg, detected) {
  const nd = normPlate(detected);
  const kd = plateKey(nd);
  let e = reg.find((r) => normPlate(r.plate) === nd);
  if (e) return e;
  if (kd) {
    e = reg.find((r) => r.actual && plateKey(r.actual) === kd);
    if (e) return e;
    e = reg.find((r) => plateKey(r.plate) === kd);
    if (e) return e;
  }
  return null;
}
function ownerFrom(e) {
  return e ? { name: e.name, idcode: e.idcode, note: e.note, actual: e.actual || "" } : null;
}

// --- captures --------------------------------------------------------------
export function listCaptures() {
  const reg = readJson(REGISTRY);
  return readJson(CAPTURES)
    .sort((a, b) => b.ts - a.ts)
    .map((c) => ({ ...c, owner: ownerFrom(findEntry(reg, c.plate)) }));
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
  return { ...rec, owner: ownerFrom(findEntry(readJson(REGISTRY), np)) };
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
export function upsertRegistry({ plate, actual, name, idcode, note }) {
  const np = normPlate(plate);
  if (!np) throw new Error("plate is required");
  const list = readJson(REGISTRY);
  const rec = { plate: np, actual: normPlate(actual) || "", name: name || "", idcode: idcode || "", note: note || "" };
  const i = list.findIndex((r) => normPlate(r.plate) === np);
  if (i >= 0) list[i] = rec; else list.push(rec);
  writeJson(REGISTRY, list);
  return rec;
}
export function deleteRegistry(plate) {
  const np = normPlate(plate);
  writeJson(REGISTRY, readJson(REGISTRY).filter((r) => normPlate(r.plate) !== np));
}

// --- backups ---------------------------------------------------------------
// One timestamped snapshot file holds both captures + registry, so a restore
// is atomic. Old snapshots are pruned to KEEP_BACKUPS.
export function backupNow() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const snapshot = { ts: d.getTime(), captures: readJson(CAPTURES), registry: readJson(REGISTRY) };
    writeJson(path.join(BACKUP_DIR, `backup-${stamp}.json`), snapshot);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("backup-") && f.endsWith(".json")).sort();
    while (files.length > KEEP_BACKUPS) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch {}
    }
    return { captures: snapshot.captures.length, registry: snapshot.registry.length, kept: files.length };
  } catch (e) {
    console.error("backup failed:", e.message);
    return null;
  }
}
export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("backup-")).sort().reverse();
}
export function restoreBackup(name) {
  const file = path.join(BACKUP_DIR, path.basename(name)); // basename blocks path traversal
  if (!fs.existsSync(file)) throw new Error("backup not found");
  const snap = readJson(file);
  if (Array.isArray(snap.captures)) writeJson(CAPTURES, snap.captures);
  if (Array.isArray(snap.registry)) writeJson(REGISTRY, snap.registry);
  return { captures: (snap.captures || []).length, registry: (snap.registry || []).length };
}
