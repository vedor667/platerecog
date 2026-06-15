# Thai License Plate Reader (prototype)

Mobile-web app that captures a photo from the phone camera and sends it to a
Python backend, which reads the Thai plate (letters + digits) and the province
line using EasyOCR.

```
frontend/index.html   browser: camera capture + result UI
server/server.js       Node/Express: serves frontend + proxies to ANPR API  <-- DEPLOY THIS
backend/               OPTIONAL self-hosted Python ML (YOLO + EasyOCR)
```

## Two backends — pick one

**A) Node + ANPR API (current deploy target — Hostinger VPS).**
Node serves the frontend and forwards images to the Plate Recognizer API.
Light on the server (no PyTorch), fast, Thailand-aware. Per-call API cost.
→ Deploy: see [DEPLOY-HOSTINGER.md](DEPLOY-HOSTINGER.md).

```
frame --> Node /recognize --> Plate Recognizer API --> plate + box + province
```

Test locally first (Windows):

```powershell
cd "D:\Club work\License Plate\server"
npm install
copy .env.example .env      # then edit .env and paste your PLATE_API_TOKEN
npm start                   # -> http://localhost:3000
```

Open http://localhost:3000 — the page and the API are served together.

**B) Python self-hosted ML (`backend/`).** Runs YOLO + EasyOCR yourself, no
per-call fee, needs ~2 GB RAM. Kept as an alternative; see the sections below.

```
frame --> YOLO (find plate box) --> crop + pad --> EasyOCR --> parse
                └─ no weights / no detection --> OCR full frame
```

## ⚠️ Python version

Your default Python is **3.14 alpha**, which has **no PyTorch wheels** (EasyOCR
needs PyTorch). Use **Python 3.11 or 3.12** for the backend.

Install one from https://www.python.org/downloads/ (tick "Add to PATH"), then
use `py -3.12` below.

## 1. Backend setup

```powershell
cd "D:\Club work\License Plate\backend"
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

First run downloads the EasyOCR models (~100 MB) automatically.

### YOLO plate-detection weights (recommended)

The detector crops the plate before OCR, which sharply improves accuracy.
Weights are **not bundled**. Get a YOLOv8/v11 license-plate model and either:

- save it as `backend\license_plate_detector.pt`, **or**
- point to it: `$env:YOLO_WEIGHTS = "C:\path\to\weights.pt"`

Sources:
- https://huggingface.co/morsetechlab/yolov11-license-plate-detection
- https://huggingface.co/keremberke/yolov8m-license-plate
- or train your own on a license-plate dataset (Roboflow has several).

Without weights, the app **still runs** — it just OCRs the whole frame.
Check which mode you're in at http://localhost:8000/health → `detector.enabled`.

Start the API (listen on all interfaces so a phone on your Wi-Fi can reach it):

```powershell
uvicorn main:app --host 0.0.0.0 --port 8000
```

Check it: open http://localhost:8000/health → `{"status":"ok"}`.

## 2. Frontend

The browser **needs HTTPS or localhost** to access the camera. Two options:

**A) Test on your PC (file picker / webcam):**
Just open `frontend/index.html` in a browser. On desktop it falls back to the
"Pick a photo" button if there's no webcam.

**B) Test on your phone (real camera) — recommended:**
Mobile browsers block the camera over plain `http://LAN-IP`. Easiest fix is a
tunnel that gives you HTTPS. Serve the frontend and point it at the backend:

1. Find your PC's LAN IP: `ipconfig` (look for IPv4, e.g. `192.168.1.20`).
2. Serve the frontend folder:
   ```powershell
   cd "D:\Club work\License Plate\frontend"
   py -3.12 -m http.server 5500
   ```
3. In the page, set the backend URL once from the browser console:
   ```js
   localStorage.setItem("lpr_api", "http://192.168.1.20:8000"); location.reload();
   ```
4. For HTTPS on the phone, expose port 5500 with a tunnel
   (e.g. `npx localtunnel --port 5500` or `cloudflared tunnel --url http://localhost:5500`)
   and open the https URL it prints on your phone.

## 3. How it works

`POST /recognize` (multipart `file`) → JSON:

```json
{
  "plate": "1กก 1234",
  "province": "กรุงเทพมหานคร",
  "confidence": 0.82,
  "raw": [{"text": "1กก 1234", "confidence": 0.9}, ...]
}
```

## Deployment

Two halves, deployed separately. **The frontend (HTTPS) can only call an HTTPS
backend** — mixed `http://` calls are blocked by the browser. All hosts below
provide HTTPS automatically.

### Backend (the ML container)

It bundles PyTorch + EasyOCR + YOLO, so it needs **~2 GB RAM** and a Docker
host. CPU is fine; no GPU required. Build/run locally first to confirm:

```powershell
cd "D:\Club work\License Plate\backend"
docker build -t thai-lpr .
docker run -p 8000:8000 thai-lpr
# -> http://localhost:8000/health
```

Then push to a host that runs Dockerfiles and gives HTTPS:

- **Render** (recommended to start): New > Web Service > point at the repo,
  root = `backend/`, it detects the Dockerfile. Pick an instance with ≥2 GB RAM
  (the free 512 MB tier will OOM with torch). You get `https://your-app.onrender.com`.
- **Railway / Fly.io**: same idea — `fly launch` / Railway "Deploy from repo",
  bump memory to 2 GB, HTTPS is automatic.
- **Hugging Face Spaces** (Docker SDK): free CPU tier, good for demos.
- **A VM** (DigitalOcean/EC2): run the container, then put **Caddy or nginx +
  Let's Encrypt** in front for HTTPS. Most work; only worth it for full control.

Bake YOLO weights into the image (uncomment the `COPY license_plate_detector.pt`
line in the Dockerfile) so detection works in production. Mind the cold-start:
first boot loads ~600 MB of models into RAM.

### Frontend (static)

Deploy the `frontend/` folder to any static host — **Cloudflare Pages**,
Netlify, Vercel, or GitHub Pages (all free, all HTTPS).

Then point it at your deployed backend. Two options:
- Edit the `API_URL` default in `index.html` to your backend's HTTPS URL, **or**
- leave it and set per-device from the browser console:
  ```js
  localStorage.setItem("lpr_api", "https://your-app.onrender.com"); location.reload();
  ```

CORS is already open (`allow_origins=["*"]`) for prototyping. Before going
public, lock it to your frontend's domain in `main.py`.

### Cost / scaling notes

- Idle ML containers still cost money (they hold RAM). Cheap PaaS tiers may
  **sleep on idle** → ~30 s cold start on the next request.
- CPU inference is ~0.5–2 s/image. For higher throughput, add a GPU instance or
  the lighter YOLO-crop path, and consider a queue.

## Limitations & upgrade path

EasyOCR is general OCR, not plate-tuned — expect misreads on angled, blurry, or
glare-heavy shots, and Thai/Latin character confusion (ก vs n, etc.).

To improve accuracy without changing the frontend:
1. Add a **YOLO plate detector** to crop the plate before OCR.
2. Fine-tune / swap the recognizer on a **Thai plate dataset**.
3. Use the plate **color** to classify vehicle type.
