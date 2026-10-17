#!/usr/bin/env python3
"""Build the map-example commute (East Village -> Hunter College) from real NYC open data.

Inputs, downloaded next to this script:
  gtfs_subway.zip         https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip            (MTA static GTFS)
  mta_stations.json       https://data.ny.gov/resource/39hk-dx4f.json?$limit=1000         (MTA Subway Stations)
  citibike_stations.json  https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json  (Citi Bike GBFS)
Bike/foot paths come from the FOSSGIS OSRM servers (routing.openstreetmap.de), fetched with curl.
Usage: python3 build_example.py example-data.js
"""
import csv, io, json, math, os, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]


def hav(a, b):
    """Metres between two [lat, lon] points."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def path_len(p):
    return sum(hav(p[i], p[i + 1]) for i in range(len(p) - 1))


def point_along(p, dist):
    """Point `dist` metres along path p, plus the index of the vertex before it."""
    for i in range(len(p) - 1):
        seg = hav(p[i], p[i + 1])
        if dist <= seg:
            t = dist / seg if seg else 0
            return [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t], i
        dist -= seg
    return p[-1], len(p) - 2


# ---------------------------------------------------------------- stations (Lexington Av line)
mta = {s["gtfs_stop_id"]: s for s in json.load(open(os.path.join(HERE, "mta_stations.json")))}
TRUNK = ["636", "635", "634", "633", "632", "631", "630", "629", "628"]  # Astor Pl -> 68 St-Hunter College
stations = []
for sid in TRUNK:
    s = mta[sid]
    routes = s["daytime_routes"].split()
    stations.append({
        "id": sid, "name": s["stop_name"], "routes": routes,
        "express": "4" in routes,  # the 4/5 skip every station that doesn't list them
        "pos": [float(s["gtfs_latitude"]), float(s["gtfs_longitude"])],
    })
by = {s["id"]: s for s in stations}
astor, union, gc, s59, s68 = by["636"], by["635"], by["631"], by["629"], by["628"]

# ---------------------------------------------------------------- line geometry (GTFS shapes)
want = {"6..N01R": [], "4..N06R": []}
with zipfile.ZipFile(os.path.join(HERE, "gtfs_subway.zip")).open("shapes.txt") as f:
    for row in csv.DictReader(io.TextIOWrapper(f, "utf-8")):
        if row["shape_id"] in want:
            want[row["shape_id"]].append((int(row["shape_pt_sequence"]), float(row["shape_pt_lat"]), float(row["shape_pt_lon"])))
for k, v in want.items():
    if not v:
        sys.exit(f"shape {k} not found in shapes.txt")
    want[k] = [[la, lo] for _, la, lo in sorted(v)]


def clip(path, a, b):
    """Sub-path between the vertices nearest a and b, with the ends snapped to a and b."""
    i = min(range(len(path)), key=lambda n: hav(path[n], a))
    j = min(range(len(path)), key=lambda n: hav(path[n], b))
    seg = path[min(i, j): max(i, j) + 1]
    if i > j:
        seg = seg[::-1]
    return [a] + seg[1:-1] + [b]


six = clip(want["6..N01R"], astor["pos"], s68["pos"])
express = clip(want["4..N06R"], union["pos"], s59["pos"])
six_to_union = clip(want["6..N01R"], astor["pos"], union["pos"])
six_59_68 = clip(want["6..N01R"], s59["pos"], s68["pos"])
six_union_59 = clip(want["6..N01R"], union["pos"], s59["pos"])

# ---------------------------------------------------------------- home, Citi Bike dock, school
home = [40.72335, -73.98163]  # a made-up East Village block near Avenue B
docks = json.load(open(os.path.join(HERE, "citibike_stations.json")))["data"]["stations"]
dock = min(docks, key=lambda d: hav([d["lat"], d["lon"]], home))
dock_pos = [dock["lat"], dock["lon"]]
school = [40.768601, -73.964704]  # 695 Park Ave (Hunter College), from NYC GeoSearch


def osrm(a, b, profile):
    # curl uses the system trust store; this Python build ships without CA certificates,
    # and turning verification off is not an acceptable workaround.
    url = (f"https://routing.openstreetmap.de/routed-{profile}/route/v1/driving/"
           f"{a[1]},{a[0]};{b[1]},{b[0]}?overview=full&geometries=geojson")
    out = subprocess.run(["curl", "-sS", "-m", "30", "-A", "CommuteLab-map-example/0.1", url],
                         check=True, capture_output=True, text=True).stdout
    rt = json.loads(out)["routes"][0]
    return [[la, lo] for lo, la in rt["geometry"]["coordinates"]], rt["distance"], rt["duration"]


walk, walk_m, walk_s = osrm(home, dock_pos, "foot")
if walk_m > 2 * hav(home, dock_pos):  # router snapped the mid-block home point onto a detour
    walk, walk_m = [home, dock_pos], hav(home, dock_pos)
    walk_s = walk_m / 1.3 + 60  # walking pace plus about a minute to undock
bike_a, bike_a_m, bike_a_s = osrm(dock_pos, astor["pos"], "bike")
bike_b, bike_b_m, bike_b_s = osrm(dock_pos, union["pos"], "bike")

# ---------------------------------------------------------------- the moment both maps show
# Mid-ride on the 4/5 express, about half-way between Grand Central and 59 St (abeam 51 St).
d_union_gc = path_len(clip(express, union["pos"], gc["pos"]))
d_gc_59 = path_len(clip(express, gc["pos"], s59["pos"]))
live, k = point_along(express, d_union_gc + 0.5 * d_gc_59)
ridden_express = express[: k + 1] + [live]
ahead_express = [live] + express[k + 1:]

phases = {  # seconds; walk and bike from the router, the rest typical of this corridor
    "walk": round(walk_s), "bike": round(bike_a_s), "wait": 190, "train1": 101,
    "transfer": 80, "train2": round((d_union_gc + 0.5 * d_gc_59) / 12.5),
}
clock = phases["bike"] + phases["wait"] + phases["train1"] + phases["transfer"] + phases["train2"]

data = {
    "title": "Home → Hunter College",
    "home": home, "school": school,
    "dock": {"name": dock["name"], "pos": dock_pos},
    "stations": stations,
    "lines": {
        "six": {"route": "6", "color": "#00933C", "path": six},
        "express": {"route": "4 5", "color": "#00933C", "path": express},
    },
    "bike": {"astor": bike_a, "union": bike_b, "astorMeters": round(bike_a_m), "unionMeters": round(bike_b_m)},
    "walk": walk,
    "trail": [
        {"phase": "walk", "path": walk},
        {"phase": "bike", "path": bike_a},
        {"phase": "train", "path": six_to_union},
        {"phase": "train", "path": ridden_express},
    ],
    "waits": [
        {"at": astor["pos"], "station": astor["name"], "label": "Wait", "sec": phases["wait"]},
        {"at": union["pos"], "station": union["name"], "label": "Transfer", "sec": phases["transfer"]},
    ],
    "ahead": [ahead_express, six_59_68],
    "ruledOut": {"bikeUnion": bike_b, "localUnion59": six_union_59},
    "live": live,
    "phases": phases,
    "clock": clock,
    "strategies": [
        {"id": "1A", "color": "#ff9f43", "label": "Astor Pl · 6 → 4/5 express → 6", "alive": True},
        {"id": "1B", "color": "#ff5e7e", "label": "Astor Pl · 6 local all the way", "alive": False},
        {"id": "2", "color": "#3dc1d3", "label": "Union Sq · 4/5 express → 6", "alive": False},
    ],
}
with open(OUT, "w") as f:
    f.write("// Generated by build_example.py from MTA GTFS, data.ny.gov, Citi Bike GBFS and FOSSGIS OSRM.\n")
    f.write("window.EXAMPLE = " + json.dumps(data, separators=(",", ":")) + ";\n")

print(f"dock: {dock['name']} ({hav(home, dock_pos):.0f} m from home)")
print(f"walk {walk_m:.0f} m/{walk_s:.0f}s | bike->Astor {bike_a_m:.0f} m/{bike_a_s:.0f}s | bike->Union {bike_b_m:.0f} m/{bike_b_s:.0f}s")
print(f"6 path pts {len(six)} | express pts {len(express)} | clock T+{clock // 60}:{clock % 60:02d}")
print("stations:", ", ".join(f"{s['name']}{' (express)' if s['express'] else ''}" for s in stations))
