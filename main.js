// main.js
// Wires together: viewer (Three.js), planner (routing via backend), chat UI.
// Polls backend state to color edges.
// Uses LLM to extract constraints + weights, then calls backend A* via /api/route.

import { StationViewer } from "./viewer.js";
import { RoutePlanner } from "./planner.js";
import { ChatController } from "./chat.js";
import { callLLM } from "./llmClient.js";

/* =========================
   DOM
========================= */
const statusEl = document.getElementById("status");
const modeBtn = document.getElementById("modeToggle");
const floorSel = document.getElementById("floorSelect");
const recenterBtn = document.getElementById("recenterBtn");
const viewBtn = document.getElementById("viewToggle"); // optional

function setStatus(s) {
  if (statusEl) statusEl.textContent = s;
}

/* =========================
   Config
========================= */
const STATION_URL = "./assets/station.glb";
const NODES_URL = "./data/nodes.json";
const EDGES_URL = "./data/edges.json";

// Backend for A* + /api/state
const BACKEND_BASE_URL = "http://127.0.0.1:5000";

// Local LLM router (Gemini/DeepSeek/OpenAI)
const LLM_BASE_URL = "http://127.0.0.1:8000";
const LLM_PROVIDER = "openai"; // "openai" | "gemini" | "deepseek"
const LLM_MODEL = "gpt-5.2"; // e.g. "chatgpt-4", "gemini-pro", "deepseek-advanced"

const STATE_POLL_MS = 3000;

/* =========================
   Instances
========================= */
const viewer = new StationViewer({
  container: document.body,
  statusEl,
  stationUrl: STATION_URL,
  floorPrefix: "floor_"
});

const planner = new RoutePlanner({ backendBaseUrl: BACKEND_BASE_URL });
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
  if (!floorSel) return;

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
  if (!floorSel) return;
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
   LLM → constraints/weights
========================= */
function buildLLMPrompt(start, goal, userSentence) {
  // We want output that matches app.py /api/route directly.
  return (
    "You convert a navigation request into routing parameters.\n" +
    "StartNode: " + start + "\n" +
    "EndNode: " + goal + "\n" +
    "UserRequest: " + userSentence + "\n\n" +
    "Return ONLY JSON with EXACT schema:\n" +
    "{\n" +
    '  "constraints": {"avoidStairs": boolean, "requireElevator": boolean, "avoidHazards": boolean},\n' +
    '  "weights": {"time": number, "distance": number, "crowd": number, "risk": number}\n' +
    "}\n\n" +
    "Rules:\n" +
    "- All weights must be >= 0.\n" +
    "- If wheelchair/accessible/no stairs is mentioned: avoidStairs=true and requireElevator=true.\n" +
    "- If emergency/smoke/fire/hazard is mentioned: avoidHazards=true and risk should be the highest weight.\n" +
    "- If user says avoid crowds/least crowded: crowd should be the highest weight.\n" +
    "- Otherwise: time should be the highest weight.\n"
  );
}

function defaultRoutingParams() {
  return {
    constraints: { avoidStairs: false, requireElevator: false, avoidHazards: false },
    weights: { time: 1.0, distance: 0.1, crowd: 0.2, risk: 0.2 }
  };
}

function sanitizeParams(obj) {
  // Defensive parsing: ensure required objects exist and numbers are valid
  const out = defaultRoutingParams();

  if (obj && obj.constraints && typeof obj.constraints === "object") {
    out.constraints.avoidStairs = !!obj.constraints.avoidStairs;
    out.constraints.requireElevator = !!obj.constraints.requireElevator;
    out.constraints.avoidHazards = !!obj.constraints.avoidHazards;
  }

  function numOr0(x) {
    if (typeof x !== "number") return 0.0;
    if (x < 0) return 0.0;
    return x;
  }

  if (obj && obj.weights && typeof obj.weights === "object") {
    out.weights.time = numOr0(obj.weights.time);
    out.weights.distance = numOr0(obj.weights.distance);
    out.weights.crowd = numOr0(obj.weights.crowd);
    out.weights.risk = numOr0(obj.weights.risk);
  }

  return out;
}

/* =========================
   Chat → LLM → Route → Visualize
========================= */
function bindChat() {
  chat.onRequest(async (req) => {
    const start = (req.start || "").trim().toUpperCase();
    const goal = (req.goal || "").trim().toUpperCase();

    if (!planner.nodeExists(start)) {
      chat.addMsg("Unknown start node: " + start, "bot");
      return;
    }
    if (!planner.nodeExists(goal)) {
      chat.addMsg("Unknown destination node: " + goal, "bot");
      return;
    }

    // Use actual free text if available; fallback to a synthetic sentence
    var userSentence = (req.freeText || "").trim();
    if (!userSentence) {
      userSentence =
        "Route from " + start +
        " to " + goal +
        " with criteria " + (req.criteria || "shortest") + ".";
    }

    chat.addMsg("Understanding request (LLM)…", "bot");

    // Defaults if LLM fails
    var routing = defaultRoutingParams();

    try {
      var system = "Return ONLY JSON. No markdown. No extra text.";
      var prompt = buildLLMPrompt(start, goal, userSentence);

      var llmText = await callLLM(LLM_BASE_URL, LLM_PROVIDER, LLM_MODEL, prompt, system);
      chat.addMsg("LLM output: " + llmText, "bot");

      var parsed = JSON.parse(llmText); // throws if invalid
      routing = sanitizeParams(parsed);
    } catch (e) {
      console.error(e);
      chat.addMsg("LLM failed: " + (e && e.message ? e.message : String(e)), "bot");
    }

    chat.addMsg("Planning route…", "bot");

    let result;
    try {
      result = await planner.planRoute({
        startNode: start,
        endNode: goal,
        constraints: routing.constraints,
        weights: routing.weights
      });
    } catch (e) {
      console.error(e);
      chat.addMsg("Route request failed: " + (e && e.message ? e.message : e), "bot");
      return;
    }

    if (!result || !result.path) {
      chat.addMsg("No route found. " + (result && result.reason ? result.reason : ""), "bot");
      return;
    }

    // Visualize the route
    viewer.highlightRoute(result.path, { floorKey: (viewer.showAllLevels ? null : result.floorKey) });
    updateModeButtonText();
    syncFloorDropdown();

    chat.addMsg("Route: " + result.path.join(" → "), "bot");
  });

  chat.bind();
}

/* =========================
   State polling for visualization
========================= */
function normalizeNodeId(s) {
  return (s || "").trim().toUpperCase();
}

function viewerEdgeKey(a, b) {
  a = normalizeNodeId(a);
  b = normalizeNodeId(b);
  return (a < b) ? (a + "|" + b) : (b + "|" + a);
}

function backendEdgeId(a, b) {
  a = normalizeNodeId(a);
  b = normalizeNodeId(b);
  return a + "__" + b;
}

function buildCrowdByEdgeFromState(edgesArray, stateEdges) {
  var crowdByEdgeKey = {};

  for (var i = 0; i < edgesArray.length; i++) {
    var e = edgesArray[i];
    var a = normalizeNodeId(e.from);
    var b = normalizeNodeId(e.to);

    var id1 = backendEdgeId(a, b);
    var id2 = backendEdgeId(b, a);

    var st = stateEdges[id1];
    if (!st) st = stateEdges[id2];

    var crowd = 0.0;
    if (st && typeof st.crowdLevel === "number") crowd = st.crowdLevel;

    if (crowd < 0) crowd = 0;
    if (crowd > 1) crowd = 1;

    var k = viewerEdgeKey(a, b);
    crowdByEdgeKey[k] = crowd;
  }

  return crowdByEdgeKey;
}

function buildEdgeStateByViewerKey(edgesArray, stateEdges) {
  var out = {};

  for (var i = 0; i < edgesArray.length; i++) {
    var e = edgesArray[i];
    var a = normalizeNodeId(e.from);
    var b = normalizeNodeId(e.to);

    var id1 = backendEdgeId(a, b);
    var id2 = backendEdgeId(b, a);

    var st = stateEdges[id1];
    if (!st) st = stateEdges[id2];

    var k = viewerEdgeKey(a, b);
    out[k] = st || null;
  }

  return out;
}

async function fetchBackendState() {
  var res = await fetch(BACKEND_BASE_URL + "/api/state", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed /api/state: HTTP " + res.status);
  return await res.json();
}

function startStatePolling(edgesArray) {
  var stopped = false;
  var inFlight = false;
  var lastVersion = null;

  async function tick() {
    if (stopped) return;
    if (inFlight) return;
    inFlight = true;

    try {
      var state = await fetchBackendState();

      var gv = state && state.graphVersion;
      var changed = (gv !== lastVersion);
      if (changed) lastVersion = gv;
      if (!changed) return;

      var stateEdges = (state && state.edges) ? state.edges : {};

      var crowdByEdgeKey = buildCrowdByEdgeFromState(edgesArray, stateEdges);
      viewer.setCrowdColors(crowdByEdgeKey);

      var edgeStateByKey = buildEdgeStateByViewerKey(edgesArray, stateEdges);
      viewer.applyEdgeState(edgeStateByKey);
    } catch (err) {
      console.error(err);
    } finally {
      inFlight = false;
    }
  }

  tick();
  var handle = setInterval(tick, STATE_POLL_MS);

  return function stop() {
    stopped = true;
    clearInterval(handle);
  };
}

/* =========================
   Init + Render loop
========================= */
async function init() {
  setStatus("Loading station…");
  await viewer.loadStation();

  rebuildFloorDropdown();
  bindUI();

  setStatus("Loading nodes/edges…");
  const nodes = await loadJSON(NODES_URL);
  const edges = await loadJSON(EDGES_URL);

  planner.setGraphData(nodes, edges);
  viewer.buildGraphFromData(nodes, edges);

  startStatePolling(edges);

  setStatus("Ready. Nodes: " + Object.keys(nodes).length + " | Edges: " + edges.length);

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
