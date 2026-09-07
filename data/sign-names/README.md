# Sign name reference list (build-time only)

Snapshot of the English sign names and superseded list published by
Road Sign Factory (https://roadsignfactory.hk/sign-index, source repo
https://github.com/G1213123/TrafficSign), fetched 2026-09-08 from
`https://roadsignfactory.hk/data/descriptions.json` and `/data/superseded.json`,
byte-for-byte.

The text is a transcription of the Transport Department's Index Plan
(CT174/51) Description column; the repository carries **no licence file**, so
this snapshot is used only as a build-time reference by
`scripts/catalogue/names.mjs`: to validate the OCR'd `No.`↔`Description` bind
(a description that matches a *different* code exposes a digit misread) and to
fill in wording where our own OCR of the Description column is noisy.

Nothing in `app/` imports these files and they are not served. **The wording
can, however, reach the browser**: on a `fill` verdict — our OCR read the row
but too noisily to ship — the builder writes the list's wording into
`app/data/signCatalogue.json`, which *is* served. Both texts describe the same
public government document, and each shipped string is either our own read of
the sheet or a transcription of it; the underlying source is TD's, not this
repo's. Recorded here so the provenance isn't lost.

`descriptions.json` — `{ "<number>[suffix]": "<ENGLISH NAME>" }` keyed by the
Index Plan number without the `TS` prefix (`"639L"`, `"2663R"`; `"2701-URBAN"`,
`"2701-NT"`, `"2701-LANTAU"` correspond to TD's `TS2701U/N/L`). Note there is
**no bare key for a "(DOUBLE SIDES)" row** — those are keyed only by their two
faces, which carry identical text, so a lookup for a bare base has to fall
through to `<n>L` (`names.mjs` does).
`superseded.json` — numbers whose rows are grey-shaded ("superseded or deleted")
on the sheets. The builder detects the shading itself from the page geometry and
logs any disagreement with this list.

**Known defect: the list can slip a row.** Verified against the printed page,
(TS 2601 - 2717) numbers the Mid-Levels escalator pair **2629**, the single
escalator sign 2630, PASSING PLACE AHEAD 2631, TEST BRAKE HERE 2632, LANE
DIRECTIONS 2633 and ROUTE(3) CONFIRMATION 2634 — the list assigns each of those
to the NEXT number (2630, 2631, 2632, 2633, 2634, 2635). So every row across
that stretch "matches" its successor's entry. This is why the builder never lets
a match one number away withhold a pictogram (`shift-suspect` rather than
`code-misread` in `names.mjs`): the TD sheet is the authority for the
number↔sign bind, and this file is only a cross-check.

To refresh: re-download both files and update the date above.
