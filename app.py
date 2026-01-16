import json
import math
import os
from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional, Any

from flask import Flask, request, jsonify
from flask_cors import CORS


# -----------------------------
# Config
# -----------------------------
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
NODES_PATH = os.path.join(DATA_DIR, "nodes.json")
EDGES_PATH = os.path.join(DATA_DIR, "edges.json")

BASE_SPEED_MPS = 1.2   # baseline walking speed for time computation
V_MAX_MPS = 1.6        # admissible upper-bound speed for heuristic


# -----------------------------
# Graph Structures
# -----------------------------
@dataclass(frozen=True)
class Arc:
    edge_id: str
    u: str
    v: str
    ada: bool
    edge_type: str
    length_m: float


def euclid_3d(a: List[float], b: List[float]) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    dz = a[2] - b[2]
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def load_graph(nodes_path: str, edges_path: str) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, List[str]], Dict[str, Arc]]:
    """
    Returns:
      nodes: { node_id: {"pos":[x,y,z], "floor":... , ...} }
      adj:   { node_id: [edge_id, edge_id, ...] }  # outgoing arcs
      arcs:  { edge_id: Arc(...) }
    """
    with open(nodes_path, "r", encoding="utf-8") as f:
        nodes = json.load(f)

    with open(edges_path, "r", encoding="utf-8") as f:
        edges = json.load(f)

    adj: Dict[str, List[str]] = {}
    arcs: Dict[str, Arc] = {}

    def add_arc(u: str, v: str, ada: bool, edge_type: str):
        # directional edge id
        edge_id = f"{u}__{v}"
        if u not in nodes or v not in nodes:
            # skip invalid references
            return
        length_m = euclid_3d(nodes[u]["pos"], nodes[v]["pos"])
        arc = Arc(edge_id=edge_id, u=u, v=v, ada=bool(ada), edge_type=str(edge_type), length_m=length_m)
        arcs[edge_id] = arc
        if u not in adj:
            adj[u] = []
        adj[u].append(edge_id)

    # edges are bidirectional by default: add both directions
    for e in edges:
        u = e.get("from")
        v = e.get("to")
        ada = e.get("ada", False)
        edge_type = e.get("type", "corridor")
        if not isinstance(u, str) or not isinstance(v, str):
            continue
        add_arc(u, v, ada, edge_type)
        add_arc(v, u, ada, edge_type)

    # ensure every node has adjacency list
    for nid in nodes.keys():
        if nid not in adj:
            adj[nid] = []

    return nodes, adj, arcs


# -----------------------------
# Live State (simulation-ready)
# -----------------------------
# This holds dynamic state keyed by directional edge_id: "U__V"
# You can update it from your simulator (crowd every minute, emergencies, construction, etc.)
LIVE_STATE: Dict[str, Dict[str, Any]] = {
    "graphVersion": 1,
    "edges": {
        # example:
        # "UP2__UP3": {"status": "open", "crowdLevel": 0.4, "speedFactor": 1.0, "hazardLevel": 0.0}
    }
}


def get_edge_state(edge_id: str) -> Dict[str, Any]:
    st = LIVE_STATE["edges"].get(edge_id)
    if st is None:
        # default state
        return {"status": "open", "crowdLevel": 0.0, "speedFactor": 1.0, "hazardLevel": 0.0}
    # fill defaults if missing
    return {
        "status": st.get("status", "open"),
        "crowdLevel": float(st.get("crowdLevel", 0.0)),
        "speedFactor": float(st.get("speedFactor", 1.0)),
        "hazardLevel": float(st.get("hazardLevel", 0.0)),
    }


# -----------------------------
# Constraints + Cost
# -----------------------------
def arc_allowed(arc: Arc, constraints: Dict[str, Any]) -> bool:
    # live blocking (emergency)
    st = get_edge_state(arc.edge_id)
    if st["status"] == "blocked":
        return False

    avoid_stairs = bool(constraints.get("avoidStairs", False))
    require_elevator = bool(constraints.get("requireElevator", False))
    # keep avoidHazards as a flag for cost (soft) unless you want hard-blocking
    # avoid_hazards = bool(constraints.get("avoidHazards", False))

    # Hard constraint: avoid stairs
    if avoid_stairs and arc.edge_type.lower() == "stairs":
        return False

    # Hard constraint: ADA / elevator-only mode
    # Here we interpret "requireElevator" as "only traverse ADA-compliant edges"
    if require_elevator and (not arc.ada):
        return False

    return True


def arc_cost(arc: Arc, weights: Dict[str, float]) -> float:
    """
    Weighted cost per arc.
    Accessibility is enforced via constraints (arc_allowed), NOT as a penalty.
    All terms are non-negative.
    """
    st = get_edge_state(arc.edge_id)

    # geometry
    length_m = arc.length_m

    # base time
    base_time_s = length_m / BASE_SPEED_MPS

    # construction slowdown: speedFactor=2.0 => 2x slower
    time_s = base_time_s * max(1.0, st["speedFactor"])

    # optional crowd slowdown in time (keep monotonic and non-negative)
    alpha = 0.8
    crowd_level = max(0.0, min(1.0, st["crowdLevel"]))
    time_s = time_s * (1.0 + alpha * crowd_level)

    # separate soft penalties (also monotonic, non-negative)
    crowd_pen = crowd_level * length_m

    hazard_level = max(0.0, min(1.0, st["hazardLevel"]))
    risk_pen = hazard_level * length_m

    # weights with defaults
    w_time = float(weights.get("time", 0.0))
    w_dist = float(weights.get("distance", 0.0))
    w_crowd = float(weights.get("crowd", 0.0))
    w_risk = float(weights.get("risk", 0.0))

    cost = (
        w_time * time_s
        + w_dist * length_m
        + w_crowd * crowd_pen
        + w_risk * risk_pen
    )
    return float(cost)


def heuristic(node_id: str, goal_id: str, nodes: Dict[str, Dict[str, Any]], weights: Dict[str, float]) -> float:
    """
    Admissible heuristic that combines multiple weights:
      h = w_time * (straight_line_distance / max_speed) + w_distance * straight_line_distance
    
    This remains admissible because:
    - Straight-line distance is the shortest possible path
    - V_MAX_MPS is the maximum possible speed (optimistic)
    - Risk and crowd cannot be predicted from position alone, so we assume 0 (optimistic but valid)
    """
    if node_id not in nodes or goal_id not in nodes:
        return 0.0

    dist = euclid_3d(nodes[node_id]["pos"], nodes[goal_id]["pos"])

    w_time = float(weights.get("time", 0.0))
    w_dist = float(weights.get("distance", 0.0))
    
    # Combine time and distance components
    # (crowd and risk weights are not used here since we can't predict them from geometry alone)
    h = w_time * (dist / V_MAX_MPS) + w_dist * dist
    
    return float(h)


# -----------------------------
# A* Search
# -----------------------------
def astar_route(
    start: str,
    goal: str,
    nodes: Dict[str, Dict[str, Any]],
    adj: Dict[str, List[str]],
    arcs: Dict[str, Arc],
    constraints: Dict[str, Any],
    weights: Dict[str, float],
) -> Tuple[List[str], List[str], float]:
    """
    Returns:
      path_nodes: [start, ..., goal]
      path_edges: [edge_id, edge_id, ...] directional
      total_cost
    Raises ValueError if no path.
    """
    if start not in nodes:
        raise ValueError(f"Unknown start node: {start}")
    if goal not in nodes:
        raise ValueError(f"Unknown goal node: {goal}")

    # Priority queue: (fScore, tie, node_id)
    import heapq
    open_heap: List[Tuple[float, int, str]] = []
    tie = 0

    g_score: Dict[str, float] = {start: 0.0}
    came_from_node: Dict[str, str] = {}
    came_from_edge: Dict[str, str] = {}

    f0 = heuristic(start, goal, nodes, weights)
    heapq.heappush(open_heap, (f0, tie, start))

    in_open: Dict[str, bool] = {start: True}
    closed: Dict[str, bool] = {}

    while open_heap:
        _, _, current = heapq.heappop(open_heap)
        in_open[current] = False

        if current == goal:
            # reconstruct
            path_nodes: List[str] = [current]
            path_edges: List[str] = []
            while current in came_from_node:
                e_id = came_from_edge[current]
                prev = came_from_node[current]
                path_edges.append(e_id)
                path_nodes.append(prev)
                current = prev
            path_nodes.reverse()
            path_edges.reverse()
            return path_nodes, path_edges, g_score[goal]

        closed[current] = True

        for e_id in adj.get(current, []):
            arc = arcs[e_id]

            if not arc_allowed(arc, constraints):
                continue

            neighbor = arc.v
            if closed.get(neighbor, False):
                continue

            tentative_g = g_score[current] + arc_cost(arc, weights)

            if (neighbor not in g_score) or (tentative_g < g_score[neighbor]):
                came_from_node[neighbor] = current
                came_from_edge[neighbor] = e_id
                g_score[neighbor] = tentative_g
                f_score = tentative_g + heuristic(neighbor, goal, nodes, weights)

                if not in_open.get(neighbor, False):
                    tie += 1
                    heapq.heappush(open_heap, (f_score, tie, neighbor))
                    in_open[neighbor] = True
                else:
                    # push duplicate; standard lazy PQ strategy
                    tie += 1
                    heapq.heappush(open_heap, (f_score, tie, neighbor))

    raise ValueError("No path found under current constraints/state")


# -----------------------------
# Flask App
# -----------------------------
app = Flask(__name__)
CORS(app)  # for local dev (frontend on different port)

NODES, ADJ, ARCS = load_graph(NODES_PATH, EDGES_PATH)


@app.get("/api/state")
def api_state():
    return jsonify({
        "graphVersion": LIVE_STATE["graphVersion"],
        "edges": LIVE_STATE["edges"]
    })


@app.post("/api/state/update")
def api_state_update():
    """
    Dev/admin endpoint to set live state (for scripted scenarios).
    If `mirrorUndirected` is true (default), the update is applied to both directions.
    """
    payload = request.get_json(force=True) or {}
    edges = payload.get("edges", {})
    if not isinstance(edges, dict):
        return jsonify({"error": "edges must be an object/dict"}), 400

    mirror = payload.get("mirrorUndirected", True)
    new_edges: Dict[str, Any] = {}

    def reverse_edge_id(eid: str) -> Optional[str]:
        if "__" not in eid:
            return None
        a, b = eid.split("__", 1)
        return f"{b}__{a}"

    for eid, st in edges.items():
        new_edges[eid] = st
        if mirror:
            rev = reverse_edge_id(eid)
            if rev is not None:
                new_edges[rev] = st

    LIVE_STATE["edges"] = new_edges

    if "graphVersion" in payload:
        LIVE_STATE["graphVersion"] = int(payload["graphVersion"])
    else:
        LIVE_STATE["graphVersion"] = int(LIVE_STATE["graphVersion"]) + 1

    return jsonify({"ok": True, "graphVersion": LIVE_STATE["graphVersion"], "mirrored": bool(mirror)})



@app.route("/api/route", methods=['POST'])
def api_route():
    """
    Body:
    {
      "startNode": "NM",
      "endNode": "EX4",
      "constraints": {...},
      "weights": {...},
      "clientKnownGraphVersion": 18
    }
    """
    payload = request.get_json(force=True) or {}

    start = payload.get("startNode", "")
    end = payload.get("endNode", "")
    constraints = payload.get("constraints", {}) or {}
    weights = payload.get("weights", {}) or {}

    if not isinstance(start, str) or not start:
        return jsonify({"error": "startNode is required"}), 400
    if not isinstance(end, str) or not end:
        return jsonify({"error": "endNode is required"}), 400
    if not isinstance(constraints, dict):
        return jsonify({"error": "constraints must be an object/dict"}), 400
    if not isinstance(weights, dict):
        return jsonify({"error": "weights must be an object/dict"}), 400

    try:
        path_nodes, path_edges, total_cost = astar_route(
            start=start,
            goal=end,
            nodes=NODES,
            adj=ADJ,
            arcs=ARCS,
            constraints=constraints,
            weights=weights,
        )
        return jsonify({
            "graphVersion": LIVE_STATE["graphVersion"],
            "pathNodes": path_nodes,
            "pathEdges": path_edges,
            "totalCost": total_cost
        })
    except ValueError as e:
        return jsonify({
            "graphVersion": LIVE_STATE["graphVersion"],
            "error": str(e)
        }), 404


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
