"""
Thai license plate recognition API (prototype).

Pipeline:
  image bytes  ->  EasyOCR (th + en, with built-in text detection)
               ->  group detected text into rows (top = plate, bottom = province)
               ->  return structured JSON

This is a fast prototype. EasyOCR is general-purpose OCR, not a plate-tuned
model, so accuracy on hard images (angle, glare, motion blur) is limited.
The upgrade path is to swap the `recognize_plate` internals for a YOLO plate
detector + a Thai-fine-tuned recognizer, keeping the same JSON response.
"""

import io
import re

import easyocr
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

from detector import detect_plates, detector_status

# --- Thai provinces (subset of the 77; extend as needed) -------------------
# Used to identify which detected line is the province (bottom row).
THAI_PROVINCES = [
    "กรุงเทพมหานคร", "กรุงเทพ", "สมุทรปราการ", "นนทบุรี", "ปทุมธานี",
    "พระนครศรีอยุธยา", "อ่างทอง", "ลพบุรี", "สิงห์บุรี", "ชัยนาท",
    "สระบุรี", "ชลบุรี", "ระยอง", "จันทบุรี", "ตราด", "ฉะเชิงเทรา",
    "ปราจีนบุรี", "นครนายก", "สระแก้ว", "นครราชสีมา", "บุรีรัมย์",
    "สุรินทร์", "ศรีสะเกษ", "อุบลราชธานี", "ยโสธร", "ชัยภูมิ",
    "อำนาจเจริญ", "หนองบัวลำภู", "ขอนแก่น", "อุดรธานี", "เลย",
    "หนองคาย", "มหาสารคาม", "ร้อยเอ็ด", "กาฬสินธุ์", "สกลนคร",
    "นครพนม", "มุกดาหาร", "เชียงใหม่", "ลำพูน", "ลำปาง", "อุตรดิตถ์",
    "แพร่", "น่าน", "พะเยา", "เชียงราย", "แม่ฮ่องสอน", "นครสวรรค์",
    "อุทัยธานี", "กำแพงเพชร", "ตาก", "สุโขทัย", "พิษณุโลก", "พิจิตร",
    "เพชรบูรณ์", "ราชบุรี", "กาญจนบุรี", "สุพรรณบุรี", "นครปฐม",
    "สมุทรสาคร", "สมุทรสงคราม", "เพชรบุรี", "ประจวบคีรีขันธ์",
    "นครศรีธรรมราช", "กระบี่", "พังงา", "ภูเก็ต", "สุราษฎร์ธานี",
    "ระนอง", "ชุมพร", "สงขลา", "สตูล", "ตรัง", "พัทลุง", "ปัตตานี",
    "ยะลา", "นราธิวาส", "บึงกาฬ",
]

# Thai consonants commonly used on plates + Thai digits.
THAI_CHARS = re.compile(r"[ก-ฮ]")

app = FastAPI(title="Thai LPR Prototype", version="0.1.0")

# Allow the browser frontend (any origin) to call us during prototyping.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Build the reader once at startup (downloads models on first run, ~100MB).
# gpu=False keeps it portable; set True if you have CUDA.
reader = easyocr.Reader(["th", "en"], gpu=False)


def _province_for(text: str) -> str | None:
    """Return the matching province name if `text` looks like one."""
    cleaned = text.replace(" ", "")
    for prov in THAI_PROVINCES:
        if prov in cleaned or cleaned in prov:
            return prov
    return None


def _ocr_region(image: np.ndarray) -> dict:
    """Run OCR on an image (full frame or a cropped plate) and parse it."""
    # detail=1 -> list of (bbox, text, confidence)
    results = reader.readtext(image, detail=1, paragraph=False)
    if not results:
        return {"plate": None, "province": None, "raw": [], "confidence": 0.0}

    items = []
    for bbox, text, conf in results:
        ys = [pt[1] for pt in bbox]
        items.append({
            "text": text.strip(),
            "conf": float(conf),
            "y": sum(ys) / len(ys),
        })

    # Identify the province line (if any) and treat the rest as the plate.
    province = None
    plate_tokens = []
    for it in items:
        prov = _province_for(it["text"])
        if prov and province is None:
            province = prov
        else:
            plate_tokens.append(it)

    # Plate tokens: keep top-most rows, join left-to-right.
    plate_tokens.sort(key=lambda x: x["y"])
    plate_text = " ".join(t["text"] for t in plate_tokens).strip()
    # Normalize: collapse spaces, drop stray punctuation.
    plate_text = re.sub(r"\s+", " ", plate_text)
    plate_text = re.sub(r"[^\w฀-๿ ]", "", plate_text)

    confs = [it["conf"] for it in items]
    avg_conf = sum(confs) / len(confs) if confs else 0.0

    return {
        "plate": plate_text or None,
        "province": province,
        "raw": [{"text": it["text"], "confidence": round(it["conf"], 3)} for it in items],
        "confidence": round(avg_conf, 3),
    }


def recognize_plate(image: np.ndarray) -> dict:
    """
    Detect the plate with YOLO, crop it, then OCR the crop. Falls back to
    full-frame OCR when no detector weights are present or nothing is detected.
    """
    boxes = detect_plates(image)

    if not boxes:
        result = _ocr_region(image)
        result["detection"] = {"used": False, "boxes": 0}
        return result

    # Use the highest-confidence plate. (Could loop over all boxes for
    # multi-plate scenes; one is enough for the prototype.)
    best = boxes[0]
    x1, y1, x2, y2 = best["box"]
    crop = image[y1:y2, x1:x2]

    result = _ocr_region(crop)
    result["detection"] = {
        "used": True,
        "boxes": len(boxes),
        "box": best["box"],
        "box_confidence": round(best["conf"], 3),
    }
    return result


@app.get("/health")
def health():
    return {"status": "ok", "detector": detector_status()}


@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload an image file.")

    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img).convert("RGB")  # honor phone rotation
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    result = recognize_plate(np.array(img))
    return JSONResponse(result)
