import argparse
import json
import os
import time
import datetime
import requests
from typing import List


def normalize(s: str) -> str:
    return (s or "").strip().upper()


def backend_edge_id(a: str, b: str) -> str:
    return f"{normalize(a)}__{normalize(b)}"


def read_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def post_state(backend: str, state_payload: dict):
    url = backend.rstrip("/") + "/api/state/update"
    r = requests.post(url, json=state_payload, timeout=10)
    r.raise_for_status()
    return r


def snapshot_state(backend: str) -> dict:
    url = backend.rstrip("/") + "/api/state"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    return r.json()


def call_route(backend: str, start: str, goal: str, *, constraints: dict, weights: dict):
    """Call backend /api/route using correct field names."""
    url = backend.rstrip("/") + "/api/route"
    payload = {
        "startNode": start,
        "endNode": goal,
        "constraints": constraints or {},
        "weights": weights or {},
    }
    r = requests.post(url, json=payload, timeout=15)
    r.raise_for_status()
    return r.json()


def parse_user_with_llm(llm_url: str, start: str, goal: str, user_sentence: str):
    payload = {"start": start, "goal": goal, "user": user_sentence}
    r = requests.post(llm_url, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def route_nodes_from_response(resp: dict) -> List[str]:
    if not resp:
        return []
    if isinstance(resp, dict):
        if "pathNodes" in resp and isinstance(resp["pathNodes"], list):
            return resp["pathNodes"]
        if "pathEdges" in resp and isinstance(resp["pathEdges"], list):
            nodes = []
            for e in resp["pathEdges"]:
                parts = e.split("__")
                if len(parts) == 2:
                    if not nodes:
                        nodes.append(parts[0])
                    nodes.append(parts[1])
            if nodes:
                return nodes
        if "nodes" in resp and isinstance(resp["nodes"], list):
            return resp["nodes"]
        if "route" in resp and isinstance(resp["route"], dict) and "nodes" in resp["route"]:
            return resp["route"]["nodes"]
        if "edges" in resp and isinstance(resp["edges"], list):
            nodes = []
            for e in resp["edges"]:
                parts = e.split("__")
                if len(parts) == 2:
                    if not nodes:
                        nodes.append(parts[0])
                    nodes.append(parts[1])
            return nodes
    return []


def edges_from_nodes(nodes: List[str]) -> List[str]:
    return [backend_edge_id(a, b) for a, b in zip(nodes, nodes[1:])]


def levenshtein(a: List[str], b: List[str]) -> int:
    n, m = len(a), len(b)
    if n == 0:
        return m
    if m == 0:
        return n
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[:]
        dp[0] = i
        ai = a[i - 1]
        for j in range(1, m + 1):
            cost = 0 if ai == b[j - 1] else 1
            dp[j] = min(prev[j] + 1, dp[j - 1] + 1, prev[j - 1] + cost)
    return dp[m]


def lcs_len(a: List[str], b: List[str]) -> int:
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if a[i] == b[j]:
                dp[i][j] = 1 + dp[i + 1][j + 1]
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])
    return dp[0][0]


def jaccard(a: List[str], b: List[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    inter = sa.intersection(sb)
    uni = sa.union(sb)
    return len(inter) / len(uni)


def compute_travel_time(edges: List[str], state: dict, length_map: dict) -> float:
    t = 0.0
    for e in edges:
        s = state.get("edges", {}).get(e, {})
        speed = float(s.get("speedFactor", 1.0))
        length = float(length_map.get(e, 1.0))
        t += length / max(1e-6, speed)
    return t


def compute_total_risk(edges: List[str], state: dict) -> float:
    """Calculate total risk (sum of hazard levels) across all edges."""
    risk = 0.0
    for e in edges:
        s = state.get("edges", {}).get(e, {})
        risk += float(s.get("hazardLevel", 0.0))
    return risk


def compute_total_distance(edges: List[str], length_map: dict) -> float:
    """Calculate total distance (sum of edge lengths) across all edges."""
    distance = 0.0
    for e in edges:
        distance += float(length_map.get(e, 1.0))
    return distance


def build_length_map_from_data(root_dir: str) -> dict:
    path = os.path.join(root_dir, "data", "edges.json")
    if not os.path.exists(path):
        return {}
    data = read_json(path)
    out = {}
    if isinstance(data, dict):
        for k, v in data.items():
            out[k] = v.get("length", 1.0) if isinstance(v, dict) else 1.0
    elif isinstance(data, list):
        for e in data:
            a = e.get("from") or e.get("a") or e.get("u")
            b = e.get("to") or e.get("b") or e.get("v")
            if a and b:
                eid = backend_edge_id(a, b)
                out[eid] = e.get("length", 1.0)
                out[backend_edge_id(b, a)] = e.get("length", 1.0)
    return out


def compute_metrics(gt_nodes, llm_nodes, state_snapshot, length_map, gt_constraints=None, gt_weights=None, llm_constraints=None, llm_weights=None, gt_category=None, llm_category=None):
    gt_edges = edges_from_nodes(gt_nodes)
    llm_edges = edges_from_nodes(llm_nodes)
    lev = levenshtein(gt_edges, llm_edges)
    lcs = lcs_len(gt_edges, llm_edges)
    jac = jaccard(gt_edges, llm_edges)
    gt_time = compute_travel_time(gt_edges, state_snapshot, length_map)
    llm_time = compute_travel_time(llm_edges, state_snapshot, length_map)
    hazards_in_llm = sum(1 for e in llm_edges if state_snapshot.get("edges", {}).get(e, {}).get("hazardLevel", 0) > 0.3)
    gt_risk = compute_total_risk(gt_edges, state_snapshot)
    llm_risk = compute_total_risk(llm_edges, state_snapshot)
    gt_distance = compute_total_distance(gt_edges, length_map)
    llm_distance = compute_total_distance(llm_edges, length_map)

    # keep comparisons lightweight: record raw params and simple diffs
    gt_constraints = gt_constraints or {}
    gt_weights = gt_weights or {}
    llm_constraints = llm_constraints or {}
    llm_weights = llm_weights or {}

    # constraints diff: list keys where values differ
    constraints_diff = []
    all_c_keys = set(gt_constraints.keys()) | set(llm_constraints.keys())
    for k in sorted(all_c_keys):
        if gt_constraints.get(k) != llm_constraints.get(k):
            constraints_diff.append(k)

    # weights diff: per-key delta (llm - gt)
    weights_diff = {}
    all_w_keys = set(gt_weights.keys()) | set(llm_weights.keys())
    for k in sorted(all_w_keys):
        g = float(gt_weights.get(k, 0.0))
        l = float(llm_weights.get(k, 0.0))
        if g != l:
            weights_diff[k] = round(l - g, 10)  # Round to avoid floating point precision issues

    metrics = {
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "gt_nodes": gt_nodes,
        "llm_nodes": llm_nodes,
        "gt_edges_count": len(gt_edges),
        "llm_edges_count": len(llm_edges),
        "levenshtein_edges": lev,
        "lcs_edges": lcs,
        "lcs_fraction": (lcs / max(1, len(gt_edges))) if gt_edges else 0.0,
        "jaccard_edges": jac,
        "gt_time": gt_time,
        "llm_time": llm_time,
        "time_diff": llm_time - gt_time,
        "gt_risk": gt_risk,
        "llm_risk": llm_risk,
        "risk_diff": llm_risk - gt_risk,
        "gt_distance": gt_distance,
        "llm_distance": llm_distance,
        "distance_diff": llm_distance - gt_distance,
        "hazardous_edges_in_llm": hazards_in_llm,
        "gt_category": gt_category or "",
        "gt_constraints": gt_constraints,
        "gt_weights": gt_weights,
        "llm_category": llm_category or "",
        "llm_constraints": llm_constraints,
        "llm_weights": llm_weights,
        "constraints_diff_keys": constraints_diff,
        "weights_diff": weights_diff,
    }
    return metrics


def print_metrics(metrics: dict):
    print("--- Trial Results ---")
    print(f"GT nodes: {metrics.get('gt_nodes')}")
    print(f"LLM nodes: {metrics.get('llm_nodes')}")
    print(f"GT edges: {metrics.get('gt_edges_count')}  LLM edges: {metrics.get('llm_edges_count')}")
    print(f"Levenshtein (edges): {metrics.get('levenshtein_edges')}")
    print(f"LCS (edges): {metrics.get('lcs_edges')}  LCS_frac: {metrics.get('lcs_fraction'):.3f}")
    print(f"Jaccard (edges): {metrics.get('jaccard_edges'):.3f}")
    print(f"GT time: {metrics.get('gt_time'):.3f}  LLM time: {metrics.get('llm_time'):.3f}  time diff: {metrics.get('time_diff'):.3f}")
    print(f"GT risk: {metrics.get('gt_risk'):.3f}  LLM risk: {metrics.get('llm_risk'):.3f}  risk diff: {metrics.get('risk_diff'):.3f}")
    print(f"GT distance: {metrics.get('gt_distance'):.3f}  LLM distance: {metrics.get('llm_distance'):.3f}  distance diff: {metrics.get('distance_diff'):.3f}")
    print(f"Hazardous edges in LLM route (>0.3): {metrics.get('hazardous_edges_in_llm')}")
    print(f"GT category: {metrics.get('gt_category')}")
    print(f"LLM category: {metrics.get('llm_category')}")
    if metrics.get("constraints_diff_keys"):
        print(f"Constraint differences: {metrics.get('constraints_diff_keys')}")
    print(f"GT constraints: {metrics.get('gt_constraints')}")
    print(f"LLM constraints: {metrics.get('llm_constraints')}")
    print(f"GT weights: {metrics.get('gt_weights')}")
    print(f"LLM weights: {metrics.get('llm_weights')}")
    if metrics.get("weights_diff"):
        print(f"Weight deltas (llm-gt): {metrics.get('weights_diff')}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--backend", default="http://127.0.0.1:5000")
    p.add_argument("--state", help="Path to state JSON to post (optional)")
    p.add_argument("--scenario-id", help="Optional scenario identifier to record")
    p.add_argument("--user-text", help="User inquiry text to feed to the LLM/planner (literal)")
    p.add_argument("--user-from-scenarios", help="Path to scenarios.json to extract user text by scenario id")
    p.add_argument("--post-scenario", action="store_true", help="Post the scenario's snapshot (from --user-from-scenarios) to backend before trial")
    p.add_argument("--user-gen", help="Optional URL to call to generate user text; expects JSON {'user': '...'}")
    p.add_argument("--post-state", action="store_true", help="Post --state to backend before trial")
    p.add_argument("--start", help="Start node (optional; taken from scenario if omitted)")
    p.add_argument("--goal", help="Goal node (optional; taken from scenario if omitted)")
    p.add_argument("--user", default="")
    p.add_argument("--llm-parse", help="LLM parse endpoint that returns params JSON")
    p.add_argument("--root", default=".", help="Repo root for data/edges.json")
    p.add_argument("--out", default="tools/trial_results.json", help="Output JSON file to append metrics")
    args = p.parse_args()

    state_snapshot = None

    if args.state and args.post_state:
        state = read_json(args.state)
        print("Posting provided state to backend...")
        post_state(args.backend, state)
    # optional: post scenario snapshot from scenarios.json
    if args.post_scenario:
        if args.user_from_scenarios and args.scenario_id:
            try:
                scenarios = read_json(args.user_from_scenarios)
                s = None
                if isinstance(scenarios, dict):
                    s = scenarios.get(args.scenario_id)
                    if not s:
                        s = next((v for v in scenarios.values() if (v.get("id") == args.scenario_id or v.get("case_id") == args.scenario_id)), None)
                else:
                    s = next((x for x in scenarios if (x.get("id") == args.scenario_id or x.get("case_id") == args.scenario_id)), None)
                if s and s.get("snapshot"):
                    print(f"Posting snapshot for scenario {args.scenario_id} to backend...")
                    post_state(args.backend, s["snapshot"])
                else:
                    print(f"No snapshot found for scenario {args.scenario_id} in {args.user_from_scenarios}")
            except Exception as e:
                print("Failed to load/post scenario snapshot:", e)
        else:
            print("--post-scenario requires --user-from-scenarios and --scenario-id")
    # resolve start/goal from scenario if not provided
    start = args.start
    goal = args.goal
    scenario_entry = None
    if (not start or not goal) and args.user_from_scenarios and args.scenario_id:
        try:
            scenarios = read_json(args.user_from_scenarios)
            s = None
            if isinstance(scenarios, dict):
                s = scenarios.get(args.scenario_id)
                if not s:
                    s = next((v for v in scenarios.values() if (v.get("id") == args.scenario_id or v.get("case_id") == args.scenario_id)), None)
            else:
                s = next((x for x in scenarios if (x.get("id") == args.scenario_id or x.get("case_id") == args.scenario_id)), None)
            if s:
                scenario_entry = s
                # prefer explicit ground_truth fields if present
                gt = s.get("ground_truth") or {}
                if not start:
                    start = gt.get("startNode") or gt.get("start") or s.get("start")
                if not goal:
                    goal = gt.get("endNode") or gt.get("end") or s.get("goal")
        except Exception:
            pass

    if not start or not goal:
        print("--start and --goal are required (or provide --user-from-scenarios and --scenario-id with ground_truth)")
        return

    print("Snapshotting state from backend...")
    state_snapshot = snapshot_state(args.backend)

    length_map = build_length_map_from_data(args.root)

    print("Calling ground-truth planner...")
    try:
        gt_constraints = {}
        gt_weights = {}
        if scenario_entry:
            gt = scenario_entry.get("ground_truth") or {}
            gt_constraints = gt.get("constraints") or {}
            gt_weights = gt.get("weights") or {}
        gt_resp = call_route(args.backend, start, goal, constraints=gt_constraints, weights=gt_weights)
        gt_nodes = route_nodes_from_response(gt_resp)
    except Exception as e:
        print("Error calling GT planner endpoint:", e)
        gt_nodes = []

    # prepare user text: priority --user-text > --user-from-scenarios > --user-gen > args.user
    user_text = None
    if args.user_text:
        user_text = args.user_text
    elif args.user_from_scenarios and args.scenario_id:
        try:
            scenarios = read_json(args.user_from_scenarios)
            # scenarios may be list or dict; match either `id` or `case_id`
            s = None
            if isinstance(scenarios, dict):
                s = scenarios.get(args.scenario_id)
                if not s:
                    # search values for matching id or case_id
                    s = next((v for v in scenarios.values() if (v.get("id") == args.scenario_id or v.get("case_id") == args.scenario_id)), None)
            else:
                s = next((x for x in scenarios if (x.get("id") == args.scenario_id or x.get("case_id") == args.scenario_id)), None)
            if s:
                user_text = s.get("user") or s.get("query") or s.get("text")
        except Exception:
            user_text = None
    elif args.user_gen:
        try:
            r = requests.post(args.user_gen, json={"start": start, "goal": goal}, timeout=10)
            r.raise_for_status()
            gen = r.json()
            user_text = gen.get("user") or gen.get("text")
        except Exception:
            user_text = None
    else:
        user_text = args.user or None

    llm_params = {}
    llm_constraints = {}
    llm_weights = {}
    print(f"User text for LLM: {user_text}")
    if args.llm_parse and user_text:
        print(f"Querying LLM parse endpoint: {args.llm_parse}")
        try:
            parsed = parse_user_with_llm(args.llm_parse, start, goal, user_text)
            print(f"LLM parse response: {parsed}")
            if not isinstance(parsed, dict):
                print(f"WARNING: LLM parse response is not a dict, got type: {type(parsed)}")
                llm_params = {}
            else:
                llm_params = parsed
        except Exception as e:
            print(f"LLM parse failed with exception: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            llm_params = {}
    elif not args.llm_parse:
        print("No --llm-parse endpoint specified, skipping LLM parsing")
    elif not user_text:
        print("No user text available for LLM parsing")

    print("Calling LLM-guided planner...")
    try:
        llm_category = llm_params.get("category", "") if isinstance(llm_params, dict) else ""
        llm_constraints = llm_params.get("constraints", {}) if isinstance(llm_params, dict) else {}
        llm_weights = llm_params.get("weights", {}) if isinstance(llm_params, dict) else {}
        llm_resp = call_route(args.backend, start, goal, constraints=llm_constraints, weights=llm_weights)
        llm_nodes = route_nodes_from_response(llm_resp)
    except Exception as e:
        print("Error calling LLM planner endpoint:", e)
        llm_nodes = []

    gt_category = ""
    if scenario_entry:
        gt_category = scenario_entry.get("ground_truth", {}).get("category", "") or scenario_entry.get("category", "")

    metrics = compute_metrics(
        gt_nodes,
        llm_nodes,
        state_snapshot,
        length_map,
        gt_constraints=gt_constraints,
        gt_weights=gt_weights,
        llm_constraints=llm_constraints,
        llm_weights=llm_weights,
        gt_category=gt_category,
        llm_category=llm_category,
    )
    # augment metrics with scenario and user info
    if args.scenario_id:
        metrics["scenario_id"] = args.scenario_id
    metrics["user_text"] = user_text
    print_metrics(metrics)

    out = getattr(args, "out", None)
    if out:
        # append to JSON array in file, or create new
        try:
            if os.path.exists(out):
                with open(out, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                    if not isinstance(existing, list):
                        existing = [existing]
            else:
                existing = []
        except Exception:
            existing = []
        existing.append(metrics)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        print(f"Wrote metrics to {out}")


if __name__ == "__main__":
    main()