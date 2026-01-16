import argparse
import json
import os
import random
import time
import requests

HERE = os.path.dirname(__file__)
# Use the script directory as the repo root so data/edges.json resolves to
# <repo>/data/edges.json when the script lives in the repo root.
ROOT = os.path.abspath(HERE)
EDGES_PATH = os.path.join(ROOT, "data", "edges.json")

def normalize(n):
    return (n or "").strip().upper()

def backend_edge_id(a, b):
    return f"{normalize(a)}__{normalize(b)}"

def build_payload(edges, version):
    out = {"graphVersion": version, "edges": {}}
    for e in edges:
        a = e.get("from")
        b = e.get("to")
        if not a or not b: 
            continue
        # symmetric update for both directions
        id1 = backend_edge_id(a, b)
        id2 = backend_edge_id(b, a)

        # random crowd, occasional hazards, speed factor influenced by crowd
        crowd = round(random.random(), 3)
        hazard = 0.0
        # small chance of hazard; higher crowd increases hazard chance slightly
        if random.random() < 0.03 + 0.1 * crowd:
            hazard = round(random.uniform(0.5, 1.0), 3)

        speed_factor = round(1.0 + 0.5 * crowd + (0.5 if random.random() < 0.05 else 0.0), 3)
        status = "blocked" if hazard > 0.9 else "open"

        st = {"status": status, "crowdLevel": crowd, "speedFactor": speed_factor, "hazardLevel": hazard}
        out["edges"][id1] = st
        out["edges"][id2] = st
    return out

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--backend", default="http://127.0.0.1:5000", help="Backend base URL")
    p.add_argument("--interval", type=float, default=30.0, help="Seconds between updates")
    p.add_argument("--seed", type=int, default=None, help="Random seed")
    args = p.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    if not os.path.exists(EDGES_PATH):
        print("Missing edges.json at", EDGES_PATH); return

    with open(EDGES_PATH, "r", encoding="utf-8") as f:
        edges = json.load(f)

    ver = 1
    url = args.backend.rstrip("/") + "/api/state/update"
    print("Posting state to", url, "every", args.interval, "s")

    while True:
        payload = build_payload(edges, ver)
        try:
            r = requests.post(url, json=payload, timeout=5)
            if r.ok:
                print(f"ver={ver} posted ok, edges={len(payload['edges'])}")
            else:
                print(f"POST failed: {r.status_code} {r.text}")
        except Exception as e:
            print("Error posting:", e)
        ver += 1
        time.sleep(args.interval)

if __name__ == "__main__":
    main()