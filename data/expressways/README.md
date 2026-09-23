# Expressways

`designation.json` lists the roads designated as expressways under s.123(1) of the Road Traffic Ordinance (Cap. 374). It has one clause per item of **G.N. 8028 of 19 October 2018**, transcribed from TD's traffic advice *Determination and Delineation of Boundaries of Expressways* (tnid 83396, 26 Oct 2025, vendored in `data/zone-notices/notices_on_expressways.json` by `node scripts/fetch-zone-notices.mjs --feed Notices_on_Expressways`). `scripts/expressways.mjs` classifies it onto CENTERLINE. `build-road-rules.mjs` draws it as the `expressway` layer and closes it to public light buses in the cut-off search.

## Why it is curated

- **No field in TD's road network marks an expressway**, and the ban that matters here has almost no PROHIBITION rows. Cap. 374Q reg 4 admits only the vehicles it lists, and a public light bus is not one of them. So TD posts no "PLB Proh" on most of Fanling Highway, Yuen Long Highway or San Tin Highway. Measured 2026-09-24: of ~440 km of expressway-named centreline, the cut-off layer shaded 54 km and PLB rows covered 15 km.
- **The legal boundary is a plan deposited in the Land Registry** (EX-HK-1b … EX-NT-22), and those plans are not published. Where an item names a stretch ("from its junction with X to its junction with Y"), a ring is drawn by hand at that junction. Three items name a point the network has no node for: (e) Wong Chu Road, (m) "Wo Che Estate", and (o) "sections of Ma On Shan Road". For those, the ring edge sits where the TS353/TS354 plates stand, and the clause says so.
- **Tunnels.** Tai Lam, Nam Wan and Scenic Hill tunnels carry their highway's name in CENTERLINE. They are excluded by a ring limited to `ELEVATION < 0`. Nam Wan's exclusion comes from the Road Users' Code list ("excluding Nam Wan Tunnel"), not from the notice. The TS354 plates at both of its portals agree.

## What is not drawn

- **Slip roads.** s.123(1) designates "any access thereto or exit therefrom", but CENTERLINE's unnamed links cannot tell a ramp from a carriageway. A walk over unnamed one-way links took Castle Peak Road's own westbound pieces at Siu Lam as Tuen Mun Road ramps, and stranded 1,043 km of the north-west New Territories. So ramps are withheld. An exit ramp still comes out of the cut-off search as cut off, because only the expressway reaches it.
- **Exemptions without evidence.** A clause's `plb` records a reg 24 authorisation, and needs TD's own data or a gazetted notice behind it. Two exist, both evidenced by TD's own part-time rows: Kwun Tong Bypass (rows 101802/101804/101918/101922, PLBs 10am–1am) and the Island Eastern Corridor east of the Eastern Harbour Crossing (row 279707, Mon–Fri 10am–4pm). Published routings say red minibuses use Tsuen Wan Road between Tai Chung Road and Kwai Chung Road. No notice or row says so, so it is not applied.

## Audit

Run `node scripts/audit-expressways.mjs` after every TD refresh and after every edit here. First findings (2026-09-24):

- **Plates.** 425 TS353/TS354 plates. Most stand at a boundary node or on an unnamed ramp.
- **Plates beside named roads.** Most of these are ramp ends at local junctions. Eight stand at Heung Yuen Wai Highway, a tunnel area and not a designated expressway (its PLB ban is G.N. 3396/2019).
- **Section 4** found no part-time PLB row that the file fails to record.

`scripts/audit-cutoff-notices.mjs` applies the same closures, so its known-zones check reads what the map shows.
