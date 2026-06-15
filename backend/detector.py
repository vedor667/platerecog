"""
YOLO license-plate detector.

Loads an Ultralytics YOLO model from a weights file and returns the plate
bounding boxes for an image. The plate region is cropped before OCR, which is
the biggest accuracy win over running OCR on the whole frame.

Weights are NOT bundled. Set the path via the YOLO_WEIGHTS env var, or drop a
file named `license_plate_detector.pt` next to this module. If no weights are
found (or Ultralytics fails to load), detection is disabled and the caller
falls back to full-frame OCR — the app keeps working.

Where to get plate-detection weights (any country works for *detecting* the
plate region; the OCR step handles Thai characters):
  - https://huggingface.co/morsetechlab/yolov11-license-plate-detection
  - https://huggingface.co/keremberke/yolov8m-license-plate
  - any YOLOv8/v11 model you train on a license-plate dataset (Roboflow, etc.)
"""

import os

_WEIGHTS = os.environ.get("YOLO_WEIGHTS", os.path.join(os.path.dirname(__file__), "license_plate_detector.pt"))

_model = None
_load_error = None
_tried = False


def _get_model():
    global _model, _load_error, _tried
    if _tried:
        return _model
    _tried = True
    try:
        if not os.path.exists(_WEIGHTS):
            _load_error = f"weights file not found: {_WEIGHTS}"
            return None
        from ultralytics import YOLO
        _model = YOLO(_WEIGHTS)
    except Exception as e:  # ultralytics missing, corrupt weights, etc.
        _load_error = f"{type(e).__name__}: {e}"
        _model = None
    return _model


def detect_plates(image, conf=0.25, pad=0.08):
    """
    Return plate boxes sorted by confidence (highest first).

    image: HxWx3 numpy array (RGB).
    pad:   fraction of box width/height to expand the crop, so we don't clip
           characters at the edges.
    -> [{"box": [x1, y1, x2, y2], "conf": float}, ...]   (empty if disabled)
    """
    model = _get_model()
    if model is None:
        return []

    h, w = image.shape[:2]
    results = model.predict(image, conf=conf, verbose=False)
    boxes = []
    for r in results:
        for b in r.boxes:
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
            c = float(b.conf[0])
            bw, bh = x2 - x1, y2 - y1
            x1 = max(0, int(x1 - bw * pad))
            y1 = max(0, int(y1 - bh * pad))
            x2 = min(w, int(x2 + bw * pad))
            y2 = min(h, int(y2 + bh * pad))
            boxes.append({"box": [x1, y1, x2, y2], "conf": c})
    boxes.sort(key=lambda b: -b["conf"])
    return boxes


def detector_status():
    """For the /health endpoint: is YOLO active, and why/why not."""
    _get_model()
    return {
        "weights": _WEIGHTS,
        "enabled": _model is not None,
        "error": _load_error,
    }
