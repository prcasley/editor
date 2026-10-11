# Scale cues for reading buildings from photos

Typical sizes to anchor a photo's scale. They are conventions, not measurements of the building in front of you: a value read from one of them is `estimated`, with its basis, never `measured`. Cross-check with a second cue in the same plane before relying on it.

## Doors

| Element | Typical size |
| --- | --- |
| Exterior door leaf, North America | 2.03 m (6′8″) tall; 0.81–0.91 m (32–36″) wide |
| Exterior door leaf, Europe | 2.0–2.1 m tall; 0.9–1.0 m wide |
| Door with frame and trim | add about 0.1–0.15 m to the width and height of the leaf |
| Double entry door | 1.5–1.8 m wide |
| Sliding patio door | 1.8–2.4 m wide, 2.03–2.1 m tall |
| Single garage door | 2.4–2.7 m (8–9 ft) wide, 2.1–2.4 m (7–8 ft) tall |
| Double garage door | 4.9 m (16 ft) wide, 2.1 m tall |

## Storeys and vertical cues

| Element | Typical size |
| --- | --- |
| Floor to floor, homes | 2.9–3.1 m (2.7 m in tract housing, 3.3 m in older homes) |
| Floor to floor, offices and retail | 3.6–4.2 m; ground-floor retail up to 4.5–5 m |
| Floor to floor, warehouses and industrial | 6–12 m clear height; count the dock doors instead |
| Window sill above the floor | 0.9 m (kitchen 1.0–1.1 m, bathroom 1.2–1.5 m, floor-to-ceiling 0) |
| Window head above the floor | about 2.1 m, level with the door heads |
| Stair riser | 0.17–0.19 m; count the entry steps for the floor's height above the ground |
| Handrail | 0.9–1.0 m |
| Interior ceiling height | 2.4–2.7 m in homes, so floor to floor is about 0.3 m more |

## Facade materials

| Element | Typical size |
| --- | --- |
| Brick, US modular | 3 courses ≈ 203 mm (8″); a brick is about 194 × 57 mm on the face |
| Brick, UK and EU | 75 mm per course (65 mm brick + 10 mm joint); 4 courses ≈ 0.3 m |
| Concrete block (CMU) | 200 mm per course, 400 mm long |
| Lap siding exposure | 100–180 mm per board (4–7″) |
| Board and batten | battens at 300–400 mm centres |
| Wall thickness, frame with siding | about 0.15–0.2 m |
| Wall thickness, brick veneer on frame | about 0.25–0.3 m |
| Wall thickness, solid masonry | 0.3–0.4 m |

## Windows

| Element | Typical size |
| --- | --- |
| Double-hung or casement window | 0.6–1.2 m wide, 0.9–1.5 m tall |
| Picture or sliding window | 1.2–2.4 m wide |
| Basement window at grade | 0.8 m wide, 0.4–0.6 m tall |
| Dormer window | 0.6–0.9 m wide |

## Context

| Element | Typical size |
| --- | --- |
| Car length / height | 4.5 m / 1.5 m |
| Person | 1.7 m |
| Parking stall | 2.5 m wide |
| Sidewalk slab | 1.2–1.5 m square |

## Roof pitch

Pitch is rise over a 12 run on a gable end or a roof edge seen square-on.

| Rise / 12 | Degrees |
| --- | --- |
| 2 | 9.5 |
| 4 | 18.4 |
| 6 | 26.6 |
| 8 | 33.7 |
| 10 | 39.8 |
| 12 | 45 |

A flat roof is about 1–2°; give it `type: "flat"` and no pitch.

## Depth without a side view

When no photo shows a side facade, the depth is the weakest number in the brief. In order of preference:

1. a measured figure: a lot plan, a drawing, a listing's footprint;
2. the known gross floor area divided by the width and the storey count;
3. a typical proportion (detached homes are often 0.7–1.0 times as deep as they are wide), with a confidence of 0.3 or less.

Say which one you used in the depth's `basis`.
