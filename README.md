# CommuteLab

Hands-free commute benchmarking for New York. Open it at your front door and commute: from GPS
speed, position and station geofences it works out each phase (walk, bike, platform wait, train,
transfer, arrival), which of your options you took, and how that trip compares with your others.

CommuteLab's three screens (Corridor, Benchmark, Ledger) run on CommuteBench's detection engine
and simulator, with real MTA stations and lines and real Citi Bike docks.

## Run it

```sh
npm install
npm run dev        # http://127.0.0.1:5173 (this Mac only)
npm test           # engine + NYC route tests (node --test)
npm run build      # type-check and build to dist/
npm run data       # refresh the MTA + Citi Bike snapshot in public/data (add -- --fresh to re-download)
```

The preset trip is East Village → Hunter College, with three options on the Lexington Av line:
1A (bike to Astor Pl, 6 → 4/5 express → 6), 1B (6 local all the way) and 2 (bike to Union Sq,
4/5 express → 6). It comes with 42 sample trips so every chart works on first launch.

## The screens

- **Corridor**: the street map (MapLibre, OpenFreeMap tiles) by default, or an auto-drawn subway
  diagram via the Map / Diagram switch. **Sim GPS** runs a simulated you on the option you pick
  (the detector is not told which) at 1x/20x/60x, with buttons for a walk errand, a red light,
  a signal crawl or a late train. **Real GPS** uses this device's location. The sheet shows the
  benchmark clock, how far ahead or behind your typical day you are, which options are still
  possible, and (FULL) every phase plus a race against your typical day on each option.
- **Benchmark**: recommended route (median and bad-day P90), phase breakdown, head-to-head win
  rates, a trend chart, and the quirk findings (express→local gamble, red-light cost) when the
  route has them. Filter to all, recorded or real-GPS trips.
- **Ledger**: a commute calendar (tap a day to open that trip) and the trip list. Each trip opens
  a receipt with its phases, rank and, for simulated trips, whether the detector got it right.
- **Thresholds** (header): the crossover simulator from CommuteLab, now fed by your real phase
  medians.

## Adding a destination

Ledger → New Dest (or the destination menu). Search home and destination by address (NYC
GeoSearch) or drop pins. Pick your Citi Bike dock (nearest is preselected) or your own bike. Then,
for each way you get there, tap the station you bike to, any station where you change trains and the
one you get off at. The app finds the trains between each pair from the GTFS schedule. Tap
several trains on a ride to mean "whichever comes first". Express and local, skipped stations,
track shapes, run times and headways all come from the data. Detection settings live under
Advanced on the review step.

## How detection works

| Phase | Rule (defaults, editable per route) |
| --- | --- |
| Walk buffer | Everything before you ride off; never counted |
| Bike, T = 0 | ≥ 7.5 mph held 8 s (your cycling trigger); T0 backdated to the last standstill |
| Red light | A bike stop ≥ 5 s |
| Platform wait | 6 s inside an origin station's fence below walking speed |
| Train | ≥ 6.5 m/s held 5 s; departure backdated to the last standstill |
| Express vs local | Running through a station's fence without stopping |
| Transfer | Every option still possible changes here; or you rode an express and an option changes here; or ≥ 75 s standing still. A quick cross-platform change is found afterwards, when the next train runs express past stations your first train would have stopped at |
| Arrived | Stopped at the last station of every option still possible; or walked out of a station where one of your options ends |

## What leaves this device

Typed addresses go to NYC Planning's GeoSearch. Home, dock and station coordinates go to the
FOSSGIS OSRM servers once, when a new route's bike and walking paths are drawn. Map tiles come from
OpenFreeMap. Trips, routes and settings stay in this browser's localStorage. None of these
services need an API key.

## Using it on a phone

Browsers only allow GPS on HTTPS pages (127.0.0.1 counts as secure, so it works on this Mac). For
a phone, serve `dist/` from any HTTPS static host, or open the dev server through an HTTPS
tunnel. The dev server binds to 127.0.0.1 on purpose, with no login, so do not expose it to a
network as it is.

## Known limits

- GPS is weak underground, so stops and pass-throughs are clearest at street level and on
  elevated lines. Use End Trip if an underground arrival is missed.
- Mobile browsers pause GPS in background tabs. The app keeps the screen awake while tracking and
  offers to resume an unfinished trip after a reload; a native wrapper would fix this fully.
- A train held at a change station for over 75 s looks like you got off.
- Sample trips are simulated from the schedule, not observed, and are labelled as samples.

## Layout

```
scripts/build-nyc-data.mjs  GTFS + data.ny.gov + GBFS -> public/data/*.json
src/engine/                 detection engine, world model, simulator, analytics (pure JS)
src/nyc/build-route.js      taps on real stations -> an engine route
src/hooks/useTrip.ts        engine + simulator / GPS for one trip
src/components/             Corridor, StreetMap, DiagramMap, Benchmark, Ledger, RouteSetup, sheets, charts
tests/                      engine.test.js (fictional route), nyc.test.js (real data)
map-examples/               the two map-style prototypes
```

Data: MTA static GTFS and MTA Subway Stations (data.ny.gov), Citi Bike GBFS. Map data ©
OpenStreetMap contributors, tiles by OpenFreeMap / OpenMapTiles.
