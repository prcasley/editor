# Example brief and answer

A synthetic two-storey house: a front photo taken square-on from the street, a corner photo showing the right side, and a listing that says 1,800 sq ft. No photo shows the back or the left side.

## What the photos gave

| Photo | Facades | View | Used for |
| --- | --- | --- | --- |
| 1 | front | square-on | width, storey heights, front openings, balcony |
| 2 | front + right | oblique | right-side windows (count only), roof type and pitch on the right gable end |
| listing | — | — | gross floor area, 1,800 sq ft (measured) |

Scale: the entry door is read as 2.1 m tall in photo 1. The front is 4.67 door heights wide, about 9.8 m, and the eave is 2.9 door heights (about 6.1 m) above the door's threshold, which matches 3.1 m + 2.9 m storeys. Depth is not visible; 1,800 sq ft ≈ 167 m² over 2 storeys and 9.8 m of width gives about 8.5 m.

Area check before the call: 9.8 × 8.5 × 2 = 166.6 m², 0.4% under the listing. Consistent.

## The call

```json
{
  "name": "14 Elm Court",
  "footprint": {
    "shape": "rectangle",
    "width": { "value": 9.8, "confidence": 0.8, "basis": "front photo, scaled from the 2.1 m entry door" },
    "depth": { "value": 8.5, "confidence": 0.4, "basis": "no side photo; listing area / width / 2 storeys" }
  },
  "stories": [
    { "height": { "value": 3.1, "confidence": 0.7, "basis": "sill and head lines against the door" } },
    { "height": { "value": 2.9, "confidence": 0.6, "basis": "eave 1.9 door heights above the upper sills" } }
  ],
  "wallThickness": { "value": 0.3, "source": "default", "basis": "typical brick veneer on frame" },
  "wallMaterial": "siding-lap-white",
  "grade": { "foundationHeight": { "value": 0.54, "confidence": 0.7, "basis": "three entry steps" } },
  "roof": {
    "type": "gable",
    "ridge": "along-front",
    "pitch": { "value": 34, "confidence": 0.6, "basis": "about 8/12 on the right gable end" },
    "overhang": 0.4,
    "material": "roof-greyshingles"
  },
  "facades": [
    {
      "facade": "front",
      "material": "flooring-rusticbrick",
      "openings": [
        { "kind": "door", "width": 0.9, "height": 2.1, "style": "paneled-glass" },
        { "kind": "window", "count": 2, "spacing": 5.6, "width": 1.2, "height": 1.4, "windowType": "double-hung" },
        { "kind": "window", "stories": [1], "count": 3, "width": 1.0, "height": 1.2, "windowType": "double-hung" }
      ]
    },
    {
      "facade": "right",
      "openings": [{ "kind": "window", "stories": [0, 1], "count": 2, "width": 0.9, "height": 1.2 }]
    }
  ],
  "balconies": [{ "facade": "front", "story": 1, "width": 2.4, "depth": 1.0 }],
  "knownFloorArea": { "value": "1800 sq ft", "source": "measured", "basis": "listing" }
}
```

The width, depth and heights carry their confidence and basis. The wall thickness is an assumption, so it says `default`. The listing area is the only `measured` value. The back and left facades are left out because no photo shows them.

## The answer (abridged)

```json
{
  "ok": true,
  "counts": { "levels": 2, "walls": 8, "doors": 1, "windows": 9, "balconies": 1 },
  "floorArea": {
    "footprintSqMeters": 83.3,
    "grossSqMeters": 166.6,
    "knownSqMeters": 167.23,
    "differencePercent": -0.4,
    "check": "consistent"
  },
  "estimates": [
    { "field": "wallThickness", "value": 0.3, "unit": "m", "source": "default", "basis": "typical brick veneer on frame" },
    { "field": "footprint.depth", "value": 8.5, "unit": "m", "source": "estimated", "confidence": 0.4, "basis": "no side photo; listing area / width / 2 storeys" },
    { "field": "facades[0].openings[1].sillHeight", "value": 0.9, "unit": "m", "source": "default" },
    { "field": "facades[0].openings[2].spacing", "value": 3.2667, "unit": "m", "source": "default", "basis": "equal bays across the facade" },
    { "field": "roof.pitch", "value": 34, "unit": "deg", "source": "estimated", "confidence": 0.6, "basis": "about 8/12 on the right gable end" }
  ],
  "foundationHeight": 0.54,
  "paintedWalls": 8,
  "message": "Drafted 2 storeys: 8 walls, 1 door, 9 windows, 1 balcony or terrace and a roof; 29 values estimated or assumed (see estimates)"
}
```

The full answer also lists the level, wall, door, window, zone, floor-plate and ceiling ids per storey, the roof ids, and all 29 estimates.

## What to tell the user

- Built: two storeys, 8 walls, 1 door, 9 windows, a front balcony, a 34° gable roof, brick on the front and white lap siding elsewhere, the ground floor 0.54 m above the ground.
- Area: 166.6 m² modelled against the listing's 167 m², consistent.
- Estimated from photos: the width (good), the storey heights (fair), the roof pitch (fair), and the depth (weak: no side photo, derived from the listing).
- Not seen: the back and left facades have no openings in the model.
- Most useful next measurement: the building's depth, or a photo of the back.
