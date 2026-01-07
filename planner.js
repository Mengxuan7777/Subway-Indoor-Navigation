// planner.js (API client version)
// Calls Flask backend /api/route for routing (A* server-side)

export class RoutePlanner {
  constructor({ backendBaseUrl }) {
    this.backendBaseUrl = backendBaseUrl || "http://127.0.0.1:5000";
    this.nodes = {};
    this.edges = [];
    this.nodeSet = {};
  }

  setGraphData(nodes, edges) {
    this.nodes = nodes || {};
    this.edges = edges || [];
    this.nodeSet = {};
    var keys = Object.keys(this.nodes);
    for (var i = 0; i < keys.length; i++) this.nodeSet[keys[i].toUpperCase()] = true;
  }

  nodeExists(id) {
    id = (id || "").trim().toUpperCase();
    return this.nodeSet[id] === true;
  }

  async planRoute(params) {
    // params can be either your old style:
    // { start, goal, criteria, ada }
    // OR the new style:
    // { startNode, endNode, constraints, weights }

    var start = (params.start || params.startNode || "").trim().toUpperCase();
    var end = (params.goal || params.endNode || "").trim().toUpperCase();

    // Back-compat mapping
    var constraints = params.constraints || {};
    var weights = params.weights || {};

    // If old style is used, map it:
    if (!params.constraints) {
      var ada = !!params.ada;
      if (ada) {
        constraints.avoidStairs = true;
        constraints.requireElevator = true;
      }
      // criteria mapping
      if (params.criteria === "least_crowds") {
        weights = { crowd: 1.0, time: 0.4, risk: 0.2, distance: 0.1 };
      } else {
        weights = { time: 1.0, crowd: 0.2, risk: 0.2, distance: 0.1 };
      }
    }

    var body = {
      startNode: start,
      endNode: end,
      constraints: constraints,
      weights: weights
    };

    var r = await fetch(this.backendBaseUrl + "/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    var data = await r.json();
    if (!r.ok) {
      return { path: null, reason: data && data.error ? data.error : ("HTTP " + r.status) };
    }

    // Normalize to your previous frontend expectations
    return {
      path: data.pathNodes || null,
      cost: data.totalCost,
      floorKey: null,
      graphVersion: data.graphVersion,
      pathEdges: data.pathEdges || []
    };
  }
}
