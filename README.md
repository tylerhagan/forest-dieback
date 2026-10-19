# Forest Change Explorer

A working prototype that answers one question for a forest or land-monitoring officer:

> Where has the forest died, since when, and how sure can we be?

It uses real Copernicus Sentinel-2 imagery of the upper Harz (Brocken, Schierke and Braunlage), where bark beetle and drought killed much of the spruce from 2018 onwards. The area is about 9.6 by 9.6 km, observed 384 times between April and October from 2017 to 2025.

Run it locally:

```sh
cd web && python3 -m http.server 8000
# open http://localhost:8000
```

No build step and no dependencies. The front end is plain JavaScript, canvas and SVG.

## What you can do

- **Scrub through the years on the loss chart itself.** The timeline is also the answer: each year's bar is the forest that died that year, coloured by year, with a line underneath for how many cloud-free views that summer had. Data quality is visible before you read any result.
- **Switch between three views of the same place.** True colour imagery, a vegetation index (NDVI), and canopy loss coloured by the year it started. Playing the timeline on the loss view shows the dieback spreading.
- **Compare against the baseline.** A swipe divider puts 2017 on one side and the selected year on the other.
- **Read any point.** Hovering shows coordinates, the vegetation index and the canopy state under the pointer.
- **Tap any spot to see its history.** A filmstrip shows the same 600 m of ground in every summer, so you can see the forest die and the ground turn green again. The chart shows every cloud-free observation for that 200 m square, ticks for the views lost to cloud, the summer medians, the baseline band and the detected loss year. Dragging across the chart moves the map through time, so the map and the chart are one control.
- **Select an area and get a verdict.** "43% of the forest (409 ha) had lost its canopy by 2021. Most of it went in 2020 and 2021." This comes with a breakdown of loss by year and a confidence level that explains itself in plain language.

## Design decisions

**Start from the question, not the imagery.** Earth observation tools usually start with scenes, bands and layers. The person I designed for starts with a question about a place and needs an answer they can defend. So the page leads with a verdict in a sentence, and the imagery, index and chart are the evidence behind it.

**Make uncertainty part of the answer.** Cloud is the normal state of central European skies: only 175 of the 384 acquisitions for the default spot are usable. Rather than hide this, the prototype shows it in three places: the per-year quality bars on the timeline, the grey cloud ticks on the chart, and the confidence rating, which states how many clear views it rests on. Gaps are never filled in or interpolated.

**One bad summer is not loss.** The 2018 to 2020 droughts stressed forest that did not die. A drop only counts when it persists into the next clear summer. This filters out drought stress and haze, at the cost of not being able to confirm loss in the most recent year. The method notes say so.

**Green again does not mean forest again.** This was the most interesting finding from working with the real data. After the spruce died, grass, shrubs and young trees made the ground green again within a few years, and NDVI climbed back towards its old values. A naive "has it recovered?" rule reported the damage shrinking from 2022, which is wrong. The prototype keeps regreened loss on the map, faded, and reports it separately: "52% of that area looks green again in 2025, most likely grass, shrubs or young trees rather than recovered forest."

**Name things the way the user would.** "Canopy loss", "cloud-free views", "summer composite" and "confidence" rather than "NDVI delta", "SCL mask" or "valid pixel count". Technical terms appear in the method notes for people who want them.

**Mobile is a real target.** Field staff check things on phones. The layout stacks to one column, the map supports pinch and drag, and tapping a spot scrolls its history into view.

## How the data is built

`pipeline/sentinel2.py` reads Sentinel-2 L2A from Microsoft Planetary Computer (free, no account needed):

1. Search every scene over the area from April to October, 2017 to 2025, with less than 80% scene cloud.
2. Read red, green, blue and near-infrared at 20 m for the area only (windowed reads from cloud-optimised GeoTIFFs), correcting for the 2022 change in processing baseline.
3. Mask anything the scene classification layer does not mark as vegetation, bare soil or water.
4. Average NDVI into 200 m cells per scene for the time series, and take per-summer (10 June to 31 August) medians for the composites.

```sh
pip install pystac-client planetary-computer rasterio pyproj numpy pillow
python pipeline/sentinel2.py --out web/data
```

This takes a few minutes. `pipeline/simulate.py` writes a simulated dataset in the same format for offline work, and the page labels it as simulated.

The analysis that turns this into loss years, regreening and confidence runs in the browser (`web/src/app.js`), so the thresholds can be tuned and the result checked live.

## Limits and next steps

- **NDVI alone cannot tell causes apart.** Bark beetle, felling, storm damage and drought look alike. I would add a shortwave-infrared moisture index, which separates young growth from mature canopy better, and canopy height data where it exists.
- **20 m pixels miss single trees.** Higher-resolution imagery, such as PlanetScope at 3 m with near-daily revisits, would sharpen the edges and fill many of the cloud gaps.
- **Areas are rectangles.** A real tool would accept administrative or property boundaries, and would export a short report for the file.
- **Thresholds are fixed.** They are reasonable defaults for spruce, but an expert user should be able to adjust them and see the map update.

Contains modified Copernicus Sentinel data 2017 to 2025.
