"""Shared writer for the dataset the web prototype reads.

Both the simulated generator and the real Sentinel-2 pipeline call
`write_dataset`, so the front end never needs to know where the data came from.

Encoding
--------
NDVI is stored as 8-bit: v = round((ndvi - NDVI_MIN) / (NDVI_MAX - NDVI_MIN) * 254),
with 255 meaning "no clear observation" (cloud, shadow or missing).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

NDVI_MIN, NDVI_MAX, NODATA = -0.2, 1.0, 255


def encode_ndvi(ndvi: np.ndarray) -> np.ndarray:
    """Float NDVI (NaN = no data) to uint8 with 255 as no data."""
    out = np.full(ndvi.shape, NODATA, dtype=np.uint8)
    ok = np.isfinite(ndvi)
    v = (np.clip(ndvi[ok], NDVI_MIN, NDVI_MAX) - NDVI_MIN) / (NDVI_MAX - NDVI_MIN) * 254
    out[ok] = np.round(v).astype(np.uint8)
    return out


def cell_series(ndvi: np.ndarray, cell: int, min_clear: float = 0.6) -> np.ndarray:
    """Average a single-date NDVI raster into cells; cells mostly under cloud become NaN."""
    h, w = ndvi.shape
    rows, cols = h // cell, w // cell
    block = ndvi[: rows * cell, : cols * cell].reshape(rows, cell, cols, cell)
    clear = np.isfinite(block).mean(axis=(1, 3))
    with np.errstate(invalid="ignore"):
        mean = np.nanmean(block, axis=(1, 3))
    mean[clear < min_clear] = np.nan
    return mean


def write_dataset(
    out_dir: Path,
    *,
    meta: dict,
    composites: list[dict],
    dates: list[str],
    series: np.ndarray,
    cell: int,
) -> None:
    """
    composites: [{"year": int, "rgb": HxWx3 uint8, "ndvi": HxW float (NaN ok), "clear_obs": int}]
    series:     (n_dates, rows, cols) float NDVI with NaN for no clear observation
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*"):
        old.unlink()

    comp_meta = []
    for c in composites:
        y = c["year"]
        Image.fromarray(c["rgb"]).save(out_dir / f"rgb_{y}.jpg", quality=85, optimize=True)
        Image.fromarray(encode_ndvi(c["ndvi"])).save(out_dir / f"ndvi_{y}.png", optimize=True)
        comp_meta.append(
            {"year": y, "rgb": f"rgb_{y}.jpg", "ndvi": f"ndvi_{y}.png", "clearObs": int(c["clear_obs"])}
        )

    n, rows, cols = series.shape
    # one row per date, one column per cell (row-major), stored as a lossless greyscale PNG
    Image.fromarray(encode_ndvi(series).reshape(n, rows * cols)).save(out_dir / "series.png", optimize=True)

    manifest = {
        **meta,
        "width": int(composites[0]["rgb"].shape[1]),
        "height": int(composites[0]["rgb"].shape[0]),
        "years": [c["year"] for c in composites],
        "composites": comp_meta,
        "ndviEncoding": {"min": NDVI_MIN, "max": NDVI_MAX, "scale": 254, "nodata": NODATA},
        "series": {"file": "series.png", "cellSizePx": cell, "rows": rows, "cols": cols, "dates": dates},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
