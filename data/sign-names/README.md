# Sign name reference list (build-time only)

Snapshot of the English sign names and superseded list published by
Road Sign Factory (https://roadsignfactory.hk/sign-index, source repo
https://github.com/G1213123/TrafficSign), fetched 2026-09-08 from
`https://roadsignfactory.hk/data/descriptions.json` and `/data/superseded.json`,
byte-for-byte.

The text is a transcription of the Transport Department's Index Plan
(CT174/51) Description column; the repository carries **no licence file**, so
this snapshot is used only as a build-time reference by
`scripts/build-sign-catalogue.mjs`: to validate the OCR'd `No.`↔`Description`
bind (a description that matches a *different* code exposes a digit misread)
and to fill in wording where our own OCR is noisy. Nothing in `app/` imports
it, and it is never served.

`descriptions.json` — `{ "<number>[suffix]": "<ENGLISH NAME>" }` keyed by the
Index Plan number without the `TS` prefix (`"639L"`, `"2663R"`; `"2701-URBAN"`,
`"2701-NT"`, `"2701-LANTAU"` correspond to TD's `TS2701U/N/L`).
`superseded.json` — numbers whose rows are grey-shaded ("superseded or deleted")
on the sheets.

To refresh: re-download both files and update the date above.
