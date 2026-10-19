"""Build the prototype dataset from real Sentinel-2 L2A data (Microsoft Planetary Computer, no account needed).

For every scene April to October 2017-2025 over the area of interest it reads
red, green, blue and near-infrared at 20 m, masks cloud, shadow and snow with the
scene classification layer (SCL), and produces:

  * per-scene NDVI averaged into 200 m cells (the time series behind the chart)
  * per-summer (10 June to 31 August) median composites: true colour and NDVI

    pip install pystac-client planetary-computer rasterio pyproj numpy pillow
    python pipeline/sentinel2.py --out web/public/data
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import planetary_computer as pc
import pyproj
import pystac_client
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from dataset import cell_series, write_dataset

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "1")
os.environ.setdefault("VSI_CACHE", "TRUE")

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
SIZE, PX_M, CELL = 480, 20, 10
YEARS = range(2017, 2026)
CENTER = (10.60, 51.78)  # between Brocken, Schierke and Braunlage, upper Harz
CLEAR_SCL = {4, 5, 6}  # vegetation, bare soil, water. Everything else counts as no clear view.
BANDS = ["B02", "B03", "B04", "B08"]


def aoi_utm() -> tuple[float, float, float, float]:
    t = pyproj.Transformer.from_crs(4326, 32632, always_xy=True)
    x, y = t.transform(*CENTER)
    half = SIZE * PX_M / 2
    x0, y0 = round(x - half, -1), round(y - half, -1)
    return x0, y0, x0 + SIZE * PX_M, y0 + SIZE * PX_M


def bbox_wgs84(b) -> list[float]:
    t = pyproj.Transformer.from_crs(32632, 4326, always_xy=True)
    (w, s), (e, n) = t.transform(b[0], b[1]), t.transform(b[2], b[3])
    return [round(w, 5), round(s, 5), round(e, 5), round(n, 5)]


def read_band(href: str, bounds, resampling) -> np.ndarray:
    with rasterio.open(href) as src:
        win = from_bounds(*bounds, transform=src.transform)
        return src.read(1, window=win, out_shape=(SIZE, SIZE), resampling=resampling, boundless=True, fill_value=0)


def load_item(item, bounds):
    """Return (date, reflectance [4,H,W] float32 with NaN where not clear) or None."""
    for attempt in range(4):
        try:
            signed = pc.sign(item)
            scl = read_band(signed.assets["SCL"].href, bounds, Resampling.nearest)
            clear = np.isin(scl, list(CLEAR_SCL))
            if clear.mean() < 0.02:
                return item.datetime.date(), None
            offset = 1000 if item.properties.get("s2:processing_baseline", "00.00") >= "04.00" else 0
            refl = np.empty((4, SIZE, SIZE), np.float32)
            for i, b in enumerate(BANDS):
                raw = read_band(signed.assets[b].href, bounds, Resampling.average).astype(np.float32)
                refl[i] = (raw - offset) / 10000.0
            refl[:, ~clear] = np.nan
            refl[:, (refl[3] <= 0)] = np.nan
            return item.datetime.date(), refl
        except Exception as exc:  # network hiccups: retry with a fresh signature
            if attempt == 3:
                print("  skip", item.id, exc)
                return item.datetime.date(), None
            time.sleep(2 * (attempt + 1))


def ndvi(refl: np.ndarray) -> np.ndarray:
    red, nir = refl[2], refl[3]
    with np.errstate(all="ignore"):
        return (nir - red) / (nir + red)


def to_rgb(refl_median: np.ndarray) -> np.ndarray:
    rgb = np.stack([refl_median[2], refl_median[1], refl_median[0]], -1)
    rgb = np.clip(np.nan_to_num(rgb) / 0.16, 0, 1) ** (1 / 1.5)
    return (rgb * 255).astype(np.uint8)


def main(out: Path, workers: int) -> None:
    bounds = aoi_utm()
    cat = pystac_client.Client.open(STAC)
    lon, lat = CENTER
    items = list(
        cat.search(
            collections=["sentinel-2-l2a"],
            intersects={"type": "Point", "coordinates": [lon, lat]},
            datetime=f"{YEARS[0]}-04-01/{YEARS[-1]}-10-31",
            query={"eo:cloud_cover": {"lt": 80}},
        ).items()
    )
    items = [i for i in items if 4 <= i.datetime.month <= 10]
    print(f"{len(items)} scenes to read")

    by_date: dict[dt.date, np.ndarray] = {}
    done = 0
    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(load_item, it, bounds) for it in items]
        for f in as_completed(futs):
            d, refl = f.result()
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(items)}")
            if refl is None:
                continue
            if d in by_date:  # two scenes on one day: fill gaps in the first with the second
                prev = by_date[d]
                by_date[d] = np.where(np.isnan(prev), refl, prev)
            else:
                by_date[d] = refl

    dates = sorted(by_date)
    rows = SIZE // CELL
    series = np.stack([cell_series(ndvi(by_date[d]), CELL) for d in dates]).astype(np.float32)

    composites = []
    for y in YEARS:
        summer = [by_date[d] for d in dates if d.year == y and (d.month, d.day) >= (6, 10) and d.month <= 8]
        if not summer:
            continue
        stack = np.stack(summer)  # [n, 4, H, W]
        with np.errstate(all="ignore"):
            med = np.nanmedian(stack, axis=0)
        clear = np.isfinite(stack[:, 3]).sum(axis=0)
        composites.append({"year": y, "rgb": to_rgb(med), "ndvi": ndvi(med), "clear_obs": int(np.median(clear))})
        print(y, "summer scenes", len(summer), "median clear views/pixel", int(np.median(clear)))
        del stack

    write_dataset(
        out,
        meta={
            "simulated": False,
            "title": "Forest change, upper Harz",
            "place": "Brocken, Schierke and Braunlage, Harz, Germany",
            "source": "Copernicus Sentinel-2 L2A via Microsoft Planetary Computer, resampled to 20 m",
            "bbox": bbox_wgs84(bounds),
            "pixelSizeM": PX_M,
            "baselineYears": [2017, 2018],
            "lossThreshold": 0.15,
        },
        composites=composites,
        dates=[d.isoformat() for d in dates],
        series=series,
        cell=CELL,
    )
    print("wrote", out, "with", len(dates), "dates and", rows * rows, "cells")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(__file__).parents[1] / "web/public/data")
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args()
    main(a.out, a.workers)
