"""Generate a SIMULATED dataset in the same format as the real Sentinel-2 pipeline.

It models a Harz-like upland: spruce plantations hit by bark-beetle dieback from 2019,
salvage clear-cuts and slow regrowth, beech stands, farmland, a reservoir and a village,
observed every 5 days in the growing season with realistic cloud gaps.

This exists only so the prototype can be built and tested without network access.
Every view of it in the prototype is labelled "Simulated data".

    python pipeline/simulate.py --out web/public/data
"""
from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, distance_transform_edt

from dataset import cell_series, write_dataset

SIZE, CELL, PX_M = 480, 10, 20
YEARS = list(range(2017, 2026))
BBOX = [10.55, 51.76, 10.6895, 51.8463]  # around Torfhaus / Brocken, ~9.6 km square

rng = np.random.default_rng(7)


def smooth_noise(sigma: float, size: int = SIZE) -> np.ndarray:
    n = gaussian_filter(rng.standard_normal((size, size)), sigma)
    return (n - n.min()) / (n.max() - n.min())


# ---------------------------------------------------------------- landscape
elev = 0.65 * smooth_noise(60) + 0.25 * smooth_noise(20) + 0.10 * smooth_noise(6)
yy, xx = np.mgrid[0:SIZE, 0:SIZE] / SIZE
elev = elev * 0.7 + 0.3 * (1 - (0.6 * yy + 0.4 * (1 - xx)))  # lowland to the south-east
elev = (elev - elev.min()) / (elev.max() - elev.min())

gy, gx = np.gradient(elev * 900)  # hillshade from the north-west
shade = np.clip(0.75 + 0.9 * (-gx * 0.7 - gy * 0.7) / 40, 0.55, 1.15)

WATER, TOWN, FIELD, BEECH, SPRUCE, MEADOW = range(6)
cover = np.full((SIZE, SIZE), SPRUCE, dtype=np.uint8)

beech_mask = (elev < 0.42) & (smooth_noise(15) > 0.45)
cover[beech_mask] = BEECH
meadow = (smooth_noise(10) > 0.80) & (elev > 0.3)
cover[meadow] = MEADOW

# farmland: rectangular fields in the low south-east corner
farm = (elev < 0.28) & (xx > 0.45) & (yy > 0.5)
field_id = ((np.floor(xx * 24 + 0.3 * np.floor(yy * 14)) * 31 + np.floor(yy * 14)) % 97).astype(int)
cover[farm] = FIELD

# reservoir: a valley blob
lake = gaussian_filter(((xx - 0.22) ** 2 / 0.010 + (yy - 0.70) ** 2 / 0.003 < 1).astype(float), 3) > 0.5
cover[lake] = WATER

# village
town = ((xx - 0.78) ** 2 + (yy - 0.36) ** 2 < 0.0025) & (smooth_noise(3) > 0.35)
cover[town] = TOWN

# roads (thin lines) drawn into the town class for colour, kept as non-vegetation
road = np.zeros((SIZE, SIZE), bool)
for t in np.linspace(0, 1, 2000):
    r, c = int((0.95 - 0.6 * t + 0.05 * np.sin(t * 9)) * SIZE), int((0.05 + 0.9 * t) * SIZE)
    road[max(r - 1, 0): r + 1, max(c - 1, 0): c + 1] = True
    r2, c2 = int((0.1 + 0.8 * t) * SIZE), int((0.78 + 0.06 * np.sin(t * 6)) * SIZE)
    road[max(r2 - 1, 0): r2 + 1, max(c2 - 1, 0): c2 + 1] = True
cover[road & (cover != WATER)] = TOWN

# ---------------------------------------------------------------- dieback model
spruce = cover == SPRUCE
seeds = np.zeros((SIZE, SIZE), bool)
for _ in range(9):
    r, c = rng.integers(40, SIZE - 40, 2)
    if spruce[r, c]:
        seeds[r, c] = True
seeds[200, 120] = seeds[150, 300] = seeds[330, 380] = True
dist = distance_transform_edt(~seeds) * PX_M / 1000  # km to nearest outbreak origin
spread = dist + 1.4 * smooth_noise(12) + 0.6 * smooth_noise(4)
onset = np.full((SIZE, SIZE), 0, dtype=int)  # 0 = never affected
yr = np.floor(2019 + spread / 0.9).astype(int)
resistant = smooth_noise(18) > 0.72  # some higher, wetter stands survive
hit = spruce & (yr <= 2024) & ~resistant
onset[hit] = yr[hit]
salvage_delay = np.where(smooth_noise(8) > 0.45, 1, 99)  # ~half salvaged a year after dying
salvage_delay[(smooth_noise(25) > 0.6)] = 2

field_crop_phase = rng.uniform(0, 1, 97)


def ndvi_on(date: dt.date) -> np.ndarray:
    y = date.year
    doy = date.timetuple().tm_yday
    season = np.clip(np.sin((doy - 95) / 210 * np.pi), 0, 1)  # 0 in early Apr, peak mid-Jul
    out = np.zeros((SIZE, SIZE))

    out[cover == WATER] = -0.05
    out[cover == TOWN] = 0.18
    out[cover == MEADOW] = 0.35 + 0.40 * season
    out[cover == BEECH] = 0.30 + 0.55 * np.clip(np.sin((doy - 110) / 190 * np.pi), 0, 1) ** 0.6

    # crops: green-up then harvest, phase shifted by field and year
    phase = field_crop_phase[field_id] + 0.17 * (y - 2017)
    harvest = 185 + (phase % 1) * 50
    green = np.clip((doy - 100) / 60, 0, 1) * (doy < harvest) + 0.25 * (doy >= harvest)
    f = cover == FIELD
    out[f] = (0.20 + 0.65 * green)[f]

    # spruce: evergreen with a mild cycle, then dieback trajectory
    healthy = np.full((SIZE, SIZE), 0.74 + 0.08 * season)
    t = (y + doy / 365) - (onset + 0.45)  # years since visible decline began (mid-year)
    dying = np.clip(t, 0, 1)
    dead = healthy - 0.36 * dying
    cut_t = t - salvage_delay
    cleared = np.where(cut_t > 0, 0.22 + np.clip(cut_t, 0, 6) * 0.06 + 0.12 * season, dead)
    s = spruce & (onset > 0)
    out[spruce] = healthy[spruce]
    out[s] = np.where(cut_t[s] > 0, cleared[s], dead[s])
    # 2018 drought stress: slight dip everywhere in spruce
    if y == 2018:
        out[spruce] -= 0.04 * season

    out += rng.normal(0, 0.025, out.shape)
    return out


def cloud_mask(i: int) -> np.ndarray:
    """True where cloud or shadow covers the pixel on that date."""
    p = rng.random()
    if p < 0.38:
        return np.zeros((SIZE, SIZE), bool)  # clear day
    if p < 0.55:
        return np.ones((SIZE, SIZE), bool)  # fully overcast
    cover_frac = rng.uniform(0.1, 0.85)
    field = gaussian_filter(rng.standard_normal((SIZE, SIZE)), rng.uniform(10, 30))
    thr = np.quantile(field, 1 - cover_frac)
    cloud = field > thr
    shadow = np.roll(cloud, (12, -18), axis=(0, 1))
    return cloud | shadow


PALETTE = {
    "spruce": ((70, 60, 50), (26, 52, 34)),
    "beech": ((120, 105, 80), (58, 92, 44)),
    "meadow": ((150, 140, 100), (92, 128, 62)),
    "field": ((188, 168, 124), (88, 132, 58)),
    "dead": ((118, 98, 80), (118, 98, 80)),
}


def to_rgb(ndvi: np.ndarray) -> np.ndarray:
    v = np.nan_to_num(np.clip((ndvi - 0.15) / 0.7, 0, 1))[..., None]
    rgb = np.zeros((SIZE, SIZE, 3))

    def blend(key):
        lo, hi = (np.array(c, float) for c in PALETTE[key])
        return lo + (hi - lo) * v

    rgb[:] = blend("spruce")
    for cls, key in ((BEECH, "beech"), (MEADOW, "meadow"), (FIELD, "field")):
        m = cover == cls
        rgb[m] = blend(key)[m]
    # dead or cleared spruce reads grey-brown, regrowth drifts back towards green
    s = spruce & (np.nan_to_num(ndvi) < 0.62)
    w = np.clip((0.62 - np.nan_to_num(ndvi)) / 0.3, 0, 1)[..., None]
    rgb[s] = (rgb * (1 - w) + np.array([132, 112, 92]) * w)[s]
    rgb[cover == WATER] = (28, 44, 58)
    rgb[cover == TOWN] = (158, 152, 146)
    rgb *= shade[..., None]
    rgb += rng.normal(0, 4, rgb.shape)
    return np.clip(rgb, 0, 255).astype(np.uint8)


def main(out: Path) -> None:
    dates: list[dt.date] = []
    for y in YEARS:
        d = dt.date(y, 4, 1)
        while d <= dt.date(y, 10, 31):
            dates.append(d)
            d += dt.timedelta(days=5)

    rows = SIZE // CELL
    series = np.full((len(dates), rows, rows), np.nan, dtype=np.float32)
    summer: dict[int, list[np.ndarray]] = {y: [] for y in YEARS}

    for i, d in enumerate(dates):
        nd = ndvi_on(d)
        nd[cloud_mask(i)] = np.nan
        series[i] = cell_series(nd, CELL)
        if dt.date(d.year, 6, 10) <= d <= dt.date(d.year, 8, 31):
            summer[d.year].append(nd.astype(np.float32))

    composites = []
    for y in YEARS:
        stack = np.stack(summer[y])
        clear = np.isfinite(stack).sum(axis=0)
        with np.errstate(all="ignore"):
            med = np.nanmedian(stack, axis=0)
        composites.append(
            {"year": y, "rgb": to_rgb(med), "ndvi": med, "clear_obs": int(np.median(clear))}
        )
        print(y, "summer scenes", len(stack), "median clear obs/pixel", int(np.median(clear)))

    write_dataset(
        out,
        meta={
            "simulated": True,
            "title": "Forest change, upper Harz",
            "place": "Simulated landscape modelled on the upper Harz, Germany",
            "source": "Simulated Sentinel-2-like observations (20 m, every 5 days, April to October)",
            "bbox": BBOX,
            "pixelSizeM": PX_M,
            "baselineYears": [2017, 2018],
            "lossThreshold": 0.15,
        },
        composites=composites,
        dates=[d.isoformat() for d in dates],
        series=series,
        cell=CELL,
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(__file__).parents[1] / "web/public/data")
    main(ap.parse_args().out)
