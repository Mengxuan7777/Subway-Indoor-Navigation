// main.js
// Wires together: viewer (Three.js), planner (routing), chat UI.
// Adds "All" option in floor dropdown to show all levels.

import { StationViewer } from "./viewer.js";
import { RoutePlanner } from "./planner.js";
import { ChatController } from "./chat.js";
import { CrowdSimulator } from "./crowd_sim.js";


/* =========================
   DOM
========================= */
const statusEl = document.getElementById("status");
const modeBtn  = document.getElementById("modeToggle");
const floorSel = document.getElementById("floorSelect");
const recenterBtn = document.getElementById("recenterBtn");

// Optional: if you added a view toggle button in HTML
const viewBtn = document.getElementById("viewToggle"); // can be null if not in HTML

function setStatus(s) {
  if (statusEl) statusEl.textContent = s;
}

/* =========================
   Config
========================= */
const STATION_URL = "./assets/station.glb";
const NODES_URL   = "./data/nodes.json";
const EDGES_URL   = "./data/edges.json";

/* =========================
   Instances
========================= */
const viewer = new StationViewer({
  container: document.body,
  statusEl,
  stationUrl: STATION_URL,
  floorPrefix: "floor_"
});

const planner = new RoutePlanner();
const chat = new ChatController();

/* =========================
   Helpers
========================= */
async function loadJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return await res.json();
}

function rebuildFloorDropdown() {
  floorSel.innerHTML = "";

  // "All" option
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All";
  floorSel.appendChild(optAll);

  // Individual floors (from station model)
  for (let i = 0; i < viewer.stationFloorGroups.length; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = viewer.stationFloorGroups[i].name;
    floorSel.appendChild(opt);
  }

  // default
  floorSel.value = "0";
  viewer.showAllLevels = false;
  viewer.setActiveFloor(0);
}

function syncFloorDropdown() {
  floorSel.value = viewer.showAllLevels ? "all" : String(viewer.activeFloorIndex);
}

function updateModeButtonText() {
  if (!modeBtn) return;
  modeBtn.textContent = (viewer.mode === "floor") ? "Switch to Graph Mode" : "Switch to Floor Plan";
}

function updateViewButtonText() {
  if (!viewBtn) return;
  viewBtn.textContent = (viewer.view === "top") ? "Top View" : "Perspective View";
}

/* =========================
   UI Bindings
========================= */
function bindUI() {
  if (modeBtn) {
    modeBtn.addEventListener("click", () => {
      viewer.setMode(viewer.mode === "floor" ? "graph" : "floor");
      updateModeButtonText();
      syncFloorDropdown();
    });
  }

  if (floorSel) {
    floorSel.addEventListener("change", (e) => {
      const v = String(e.target.value);

      if (v === "all") {
        viewer.showAllLevels = true;
        viewer.applyVisibility();
        viewer.recenter();
        return;
      }

      const idx = parseInt(v, 10);
      if (!isNaN(idx)) {
        viewer.showAllLevels = false;
        viewer.setActiveFloor(idx);
      }
    });
  }

  if (recenterBtn) {
    recenterBtn.addEventListener("click", () => {
      viewer.recenter();
    });
  }

  if (viewBtn) {
    viewBtn.addEventListener("click", () => {
      viewer.toggleView();
      updateViewButtonText();
    });
    updateViewButtonText();
  }

  updateModeButtonText();
}

/* =========================
   Chat -> Plan -> Visualize
========================= */
function bindChat() {
  // ChatController is expected to call this callback with:
  // { start, goal, criteria, ada }
  chat.onRequest((req) => {
    const start = (req.start || "").trim().toUpperCase();
    const goal  = (req.goal || "").trim().toUpperCase();

    if (!planner.nodeExists(start)) {
      chat.addMsg("Unknown start node: " + start, "bot");
      return;
    }
    if (!planner.nodeExists(goal)) {
      chat.addMsg("Unknown destination node: " + goal, "bot");
      return;
    }

    const result = planner.planRoute({
      start,
      goal,
      criteria: req.criteria || "shortest",
      ada: !!req.ada
    });

    if (!result.path) {
      chat.addMsg("No route found. " + (result.reason || ""), "bot");
      return;
    }

    // Show route in graph mode, optionally switch floor (unless user selected All)
    viewer.highlightRoute(result.path, {
      floorKey: (viewer.showAllLevels ? null : result.floorKey)
    });

    updateModeButtonText();
    syncFloorDropdown();

    chat.addMsg("Route: " + result.path.join(" → "), "bot");
  });

  chat.bind();
}

/* =========================
   Init + Render loop
========================= */
async function init() {
  setStatus("Loading station…");
  await viewer.loadStation();

  // Build dropdown once floors exist
  rebuildFloorDropdown();
  bindUI();

  setStatus("Loading nodes/edges…");
  const nodes = await loadJSON(NODES_URL);
  const edges = await loadJSON(EDGES_URL);

  planner.setGraphData(nodes, edges);
  viewer.buildGraphFromData(nodes, edges);

  // --- Simulate crowd and color edges every minute ---
  const crowdSim = new CrowdSimulator({
    updateMs: 3000,     // 1 minute (use 3000 while testing)
    smoothing: 0.18,     // smoother transitions
    globalBase: 0.50,    // overall baseline
    enableRush: true
  });

  crowdSim.setEdges(edges);

  // initial apply + continuous updates
  crowdSim.start((crowdByEdge, now) => {
    viewer.setCrowdColors(crowdByEdge);  // your viewer.js colors edges green->red

    // optional status line
    // setStatus(`Crowd updated ${now.toLocaleTimeString()} (sim)`);
  });


  setStatus(`Ready. Nodes: ${Object.keys(nodes).length} | Edges: ${edges.length}`);

  bindChat();
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  viewer.render();
}

init().catch((e) => {
  console.error(e);
  setStatus("❌ Init failed: " + (e && e.message ? e.message : e));
});
