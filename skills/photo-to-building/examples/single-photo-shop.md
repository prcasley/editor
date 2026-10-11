# Example: one street photo, no measurements

User request:

> This is one street photo of a small shop with a flat roof. I have no measurements at all. Make a quick 3D draft.

Expected workflow:

1. Inventory: one square-on photo of the front; right, back and left not visible; no known figures.
2. Scale: the glazed shop door reads as 2.1 m including its frame; the shopfront is 3.1 door heights wide (about 6.5 m) and the parapet 2.0 door heights above the pavement (about 4.2 m, one tall retail storey).
3. Brief: a rectangle 6.5 m wide (confidence 0.7) and 12 m deep (confidence 0.2, basis "typical shop depth; no side view"); one storey of 4.2 m; roof `flat`; on the front a door at `offset` 1.0 m and one 4 m shop window at `offset` 4.2 m with a 0.5 m sill (both measured from the left corner, so they do not overlap); no openings elsewhere.
4. No known floor area, so the answer's `floorArea.check` is `not_given`; ask for one.
5. Call `draft_building_from_brief`, then report the counts, the estimates with their confidence, that the three unseen facades have no openings, and that the depth is the weakest number.

The answer must not call any dimension measured, invent side windows, or claim the roof has a parapet the model does not draw.
