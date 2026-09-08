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

## The same site also publishes per-sign PLATES — used as an image oracle only

`https://roadsignfactory.hk/data/signs.json` lists 1,176 per-sign SVGs
(`{ filename: "TS_3643L.svg", signNumber: "3643L" }`). They are **not** served at
`/data/svgs/` — that 404s; the site proxies them, and
`https://roadsignfactory.hk/api/proxy?asset=%2Fdata%2Fsvgs%2F<filename>` is the
only public route. `scripts/audit-sign-images.mjs` reads them, and **nothing
else does**: they are never cached in the repo, never served, never copied into
`public/signs/`. The no-licence position above applies with full force — unlike
the wording, which can reach the browser on a `fill` verdict, **no pixel of
theirs may ever ship**.

Why bother: `names.mjs` binds `No.`↔`Description`; nothing bound
`No.`↔`Pictogram`. A crop taken from the wrong row ships under a corroborated
description with every text defense satisfied. A 39-code sample caught TS256
(described "TOLL AREA", pictogram a "P" + lorry), TS776 (described "800M",
pictogram "STOP 100 m"), and TS2632 (right sign, but the crop bled the row's
ruling lines out either side) — all three with a passing name verdict.

Treat their plates as a **cross-check, never an authority**: they are redrawn in
the site's own editor rather than traced from the Index Plan, so a disagreement
means "read the printed sheet". Their key convention matches `descriptions.json`
— a "(DOUBLE SIDES)" row has no bare key, only `<n>L`/`<n>R`, so our bare base
compares against that pair — and the row slip documented above affects the
numbering of both files equally, though **not** the plates themselves: RSF's
`TS_2631.svg` is correctly "Passing Place Ahead" where its `descriptions.json`
entry for 2631 is the escalator sign. That independence is precisely what makes
the images worth checking against.

## `ruc.json` — the Transport Department's own bilingual sign names

Snapshot of the sign pictures and names published in the TD **Road Users'
Code**, chapter 8 ("The language of the road"), fetched 2026-09-09 by
`scripts/fetch-ruc-names.mjs` from the five sign-plate sections
(`signs_giving_orders_`, `signs_giving_warning_`, `signs_giving_information_`,
`temporary_signs_`, `direction_signs_`) of
`https://www.td.gov.hk/{en,tc}/road_safety/road_users_code/index/chapter_8_the_language_of_the_road/`.

Unlike the Road Sign Factory files above, this is **TD's own publication** — the
same department that publishes the Index Plan, describing the same signs. It is
the only public source that names these signs in Chinese, which is why it
exists: the Index Plan's Description column is English-only on every sheet, so
no amount of extractor work can ever yield a Chinese description.

`[{ section, src, tcSrc?, en, zh }]` in page order. `src` is the English
edition's image path; `tcSrc` appears only where the Chinese edition shows a
genuinely DIFFERENT PICTURE, which the basename decides and the directory does
not — all 189 pairs sharing a basename across the two language directories are
byte-identical, and both pairs with different basenames are different images.
Where they do differ the Chinese caption describes the Chinese edition's
picture, so that is the image the binder scores against. The images are cached
under gitignored
`data/raw/.ruc-cache` and are **never served and never copied into
`public/signs/`** — `scripts/bind-ruc-names.mjs` uses them only as a comparison
oracle, the same standing as RSF's plates.

**The page carries no sign numbers**, which is the whole difficulty: a name here
cannot be looked up against a `SIGNID`, it has to be bound to one on evidence.
The binder does that from the picture, and treats the English caption as
corroboration only — see below for why.

**Known defect: the two editions disagree with each other.** 71 of the 262
images are shared verbatim (the `tc` page links them out of `/filemanager/en/`),
and on several the two editions caption the SAME file with two different signs.
All three verified cases have the English wrong and the Chinese right:

| image | English caption | Chinese caption | what it actually is |
| --- | --- | --- | --- |
| `102c3_n.gif` | except for access if no alternative route | 可變速度限制 | a variable speed limit LED showing 70 |
| `104b6_n.gif` | way in for vehicles | 的士站時間字牌 | a taxi stand parking time plate |
| `104b7_n.gif` | no way in for vehicles | 公共小型巴士站時間字牌 | a PLB stand parking time plate |

So the English is least reliable on the `_n` rows — the ones TD revised most
recently — and a name-led bind would be wrong precisely where it matters. The
Code also slips rows in the other direction, captioning two different pictures
with one name (the pedestrian and cyclist warnings both read 「前面有行人在行車道
上」; the road-hump triangle and the enforcement camera both read 「前面有超速攝影
機」). `bind-ruc-names.mjs` withholds both sides of any such pair.

TD's transcription has its own typos, too: the "no cyclists" roundel is printed
「禁止單車或三輛車進入」 — 三輛車 ("three vehicles") for 三輪車 ("tricycle").
Corrections like that belong in `app/data/signDescriptions.json`, where a human
made them, not in this snapshot, which stays byte-faithful to the page.

To refresh: `node scripts/fetch-ruc-names.mjs --refresh` and update the date
above.
