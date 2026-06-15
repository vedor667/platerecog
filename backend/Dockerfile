# Backend container: FastAPI + EasyOCR + YOLO (CPU inference).
FROM python:3.12-slim

# System libs OpenCV/torch need at runtime (headless build keeps this minimal).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download EasyOCR models into the image so the first request isn't slow
# and doesn't depend on writable/persistent disk at runtime.
RUN python -c "import easyocr; easyocr.Reader(['th','en'], gpu=False)"

COPY . .

# If you have YOLO weights, COPY them in or bake them via build context, e.g.:
#   COPY license_plate_detector.pt .
# Otherwise the app runs in full-frame OCR fallback mode.

ENV PORT=8000
EXPOSE 8000

# Most PaaS hosts inject $PORT; default to 8000 locally.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
