// planner.js
export class RoutePlanner {
  constructor() {
    this.nodes = {};     // id -> { pos:[x,y,z], floor:"platform"/"mezzanine"/... }
    this.edges = [];     // {from,to,ada,type,dist,crowd}
    this.adj = {};       // id -> [{to, edge}]
  }

  setGraphData(nodes, edges) {
    this.nodes = nodes || {};
    this.edges = (edges || []).map((e) => this._normalizeEdge(e));

    // compute dist if missing
    for (let i = 0; i < this.edges.length; i++) {
      const ed = this.edges[i];
      if (ed.dist === null) ed.dist = this._computeDist(ed.from, ed.to);
      if (ed.crowd === null) ed.crowd = 0; // default crowd (0..1)
    }

    this.adj = this._buildAdj(this.edges);
  }

  nodeExists(id) {
    return Object.prototype.hasOwnProperty.call(this.nodes, id);
  }

  _normalizeNodeId(s) {
    return (s || "").trim().toUpperCase();
  }

  _normalizeEdge(e) {
    const from = this._normalizeNodeId(e.from);
    const to = this._normalizeNodeId(e.to);

    return {
      from,
      to,
      ada: e.ada === true,
      type: (e.type || "corridor"),
      dist: (typeof e.dist === "number") ? e.dist : null,
      crowd: (typeof e.crowd === "number") ? e.crowd : null
    };
  }

  _computeDist(a, b) {
    const na = this.nodes[a];
    const nb = this.nodes[b];
    if (!na || !nb || !na.pos || !nb.pos) return 1;

    const dx = na.pos[0] - nb.pos[0];
    const dy = na.pos[1] - nb.pos[1];
    const dz = na.pos[2] - nb.pos[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _buildAdj(edges) {
    const adj = {};
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];

      if (!adj[e.from]) adj[e.from] = [];
      if (!adj[e.to]) adj[e.to] = [];

      // ✅ undirected / bidirectional
      adj[e.from].push({ to: e.to, edge: e });
      adj[e.to].push({ to: e.from, edge: e });
    }
    return adj;
  }

  _edgeWeight(e, criteria) {
    if (criteria === "least_crowds") {
      const alpha = 3.0; // how strongly crowd affects cost
      const crowd = (e.crowd === undefined ? 0 : e.crowd);
      return e.dist * (1.0 + alpha * crowd);
    }
    return e.dist; // shortest
  }

  planRoute({ start, goal, criteria = "shortest", ada = false }) {
    start = this._normalizeNodeId(start);
    goal = this._normalizeNodeId(goal);

    if (!this.nodeExists(start) || !this.nodeExists(goal)) {
      return { path: null, reason: "Unknown start/goal node." };
    }

    // Dijkstra
    const dist = {};
    const prev = {};
    const visited = {};
    const pq = [];

    dist[start] = 0;
    pq.push({ node: start, d: 0 });

    while (pq.length > 0) {
      // extract min
      let best = 0;
      for (let i = 1; i < pq.length; i++) {
        if (pq[i].d < pq[best].d) best = i;
      }
      const cur = pq.splice(best, 1)[0];
      const u = cur.node;
      if (visited[u]) continue;
      visited[u] = true;
      if (u === goal) break;

      const neigh = this.adj[u] || [];
      for (let i = 0; i < neigh.length; i++) {
        const v = neigh[i].to;
        const e = neigh[i].edge;

        if (ada && e.ada !== true) continue;

        const w = this._edgeWeight(e, criteria);
        const nd = dist[u] + w;

        if (dist[v] === undefined || nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          pq.push({ node: v, d: nd });
        }
      }
    }

    if (dist[goal] === undefined) {
      return { path: null, reason: "No path under current constraints." };
    }

    // reconstruct path
    const path = [];
    let cur = goal;
    while (cur !== undefined) {
      path.push(cur);
      if (cur === start) break;
      cur = prev[cur];
    }
    path.reverse();

    const floorKey = (this.nodes[start] && this.nodes[start].floor) ? this.nodes[start].floor : null;
    return { path, cost: dist[goal], floorKey };
  }
}
