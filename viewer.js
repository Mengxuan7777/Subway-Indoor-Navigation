// viewer.js
// - Floor mode: renders station model (station.glb) by floors, ALWAYS original materials (opaque)
// - Graph mode: renders nodes/edges from JSON as Three.js objects + node labels
// - Graph mode overlays station model behind the graph with transparent "ghost" materials
// - Fixes shared-material bug by storing original material state PER MATERIAL (WeakMap)
// - Supports:
//    * mode: "floor" | "graph"
//    * view: "top" | "perspective"  (for both modes)
//    * levels: single floor OR "All" (showAllLevels)

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";


export class StationViewer {
  constructor({
    container = document.body,
    statusEl = null,
    stationUrl,
    floorPrefix = "floor_"
  }) {
    this.container = container;
    this.statusEl = statusEl;

    this.stationUrl = stationUrl;
    this.floorPrefix = (floorPrefix || "floor_").toLowerCase();

    /* =========================
       STATE
    ========================= */
    this.mode = "floor";         // "floor" | "graph"
    this.view = "top";           // "top" | "perspective"
    this.showAllLevels = false;  // false=single floor, true=all floors
    this.activeFloorIndex = 0;

    this.stationFloorGroups = [];      // [THREE.Group]
    this.stationFloorKeyByIndex = [];  // ["platform","mezzanine",...]

    this.graphFloorGroups = {};        // floorKey -> THREE.Group
    this.graphBuilt = false;

    this.edgeLineByKey = {};           // "A|B" -> THREE.Line
    this.nodeMeshById = {};            // "NM" -> THREE.Mesh
    this.nodeLabelById = {};           // "NM" -> THREE.Sprite
    this.edgeGlowByKey = {}; 

    // ✅ Fix: store original state PER MATERIAL to avoid shared-material ghost persistence
    this._origMatByMaterial = new WeakMap();

    /* =========================
       THREE: scene/renderer
    ========================= */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.appendChild(this.renderer.domElement);

    // lighting (station geometry)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(60, 120, 40);
    this.scene.add(dir);

    /* =========================
       CAMERAS
    ========================= */
    this.perspCam = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      5000
    );
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    this.camera = this.orthoCam;

    // Top (ortho) params
    this.ORTHO_HALF_H = 80;
    this.TOP_CAM_HEIGHT = 200;

    // Perspective params
    this.PERSP_FOV = 45;
    this.PERSP_CAM_HEIGHT = 160;
    this.PERSP_TILT_Z = 90;

    /* =========================
       CONTROLS
    ========================= */
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.screenSpacePanning = true;

    // Ortho uses zoom
    this.controls.minZoom = 0.35;
    this.controls.maxZoom = 6.0;

    // Perspective uses distance
    this.controls.minDistance = 25;
    this.controls.maxDistance = 900;

    /* =========================
       LOADER
    ========================= */
    this.loader = new GLTFLoader();

    /* =========================
       GRAPH COLORS
    ========================= */
    this.COLOR_EDGE_BASE = 0x555555;
    this.COLOR_EDGE_ROUTE = 0x00b7ff;
    this.COLOR_NODE_BASE = 0x111111;
    this.COLOR_NODE_ROUTE = 0x00b7ff;
    
    this.COLOR_EDGE_BLOCKED = 0x222222;
    this.COLOR_EDGE_CONSTRUCTION = 0xff9900;
    this.COLOR_HAZARD_GLOW = 0xff0000;
    this.GLOW_WIDTH_EXTRA = 6;     // glow line is wider than base
    this.GLOW_MAX_OPACITY = 0.65;  // max glow strength

    this.DASH_SIZE = 1.5;
    this.GAP_SIZE  = 1.0;


    /* =========================
       STATION GHOST (graph mode only)
    ========================= */
    this.GRAPH_SHOW_STATION_GHOST = true;
    this.GHOST_OPACITY = 0.18;
    this.GHOST_DEPTH_WRITE = false;
    this.GHOST_DEPTH_TEST = true;

    /* =========================
       NODE LABELS (graph mode)
    ========================= */
    this.SHOW_NODE_LABELS = true;
    this.LABEL_TEXT_COLOR = "#111";
    this.LABEL_BG_COLOR = "rgba(255,255,255,0.75)";
    this.LABEL_BORDER_COLOR = "rgba(0,0,0,0.15)";
    this.LABEL_FONT = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    this.LABEL_Y_OFFSET = 3;
    this.LABEL_SCALE = 3;
    // Keep label padding consistent across create + update redraw
    this.LABEL_PAD_X = 2;
    this.LABEL_PAD_Y = 2;
    this.LABEL_RADIUS = 6;    
    // Label highlight style for route
    this.LABEL_BG_ROUTE = "rgba(0,255,255,0.95)";   // cyan bg
    this.LABEL_TEXT_ROUTE = "#003333";              // darker text
    this.LABEL_BORDER_ROUTE = "rgba(0,120,120,1)";

    // Route highlight style
    this.ROUTE_COLOR = 0x00ffff;          // cyan
    this.EDGE_WIDTH_BASE = 3;             // px
    this.EDGE_WIDTH_ROUTE = 5;           // px
    this.NODE_SCALE_BASE = 1.0;
    this.NODE_SCALE_ROUTE = 1.35;

    // Track current route so crowd updates don't overwrite it
    this.routeEdgeKeys = new Set(); // Set<string>
    this.routeNodeIds  = new Set(); // Set<string>

    window.addEventListener("resize", () => this.onResize());

    // init view settings
    this._applyViewToControls();
    this._updateOrthoFrustum(this.ORTHO_HALF_H);
  }

  /* =========================================================
     PUBLIC API
  ========================================================= */

  async loadStation() {
    this.setStatus("Loading station…");
    const gltf = await this._loadGLTF(this.stationUrl);
    const root = gltf.scene;

    const floors = this._collectGroupsByPrefix(root, this.floorPrefix);

    for (let i = 0; i < floors.length; i++) {
      const floorNode = floors[i];
      const g = new THREE.Group();
      g.name = floorNode.name || `floor_${i}`;
      g.add(floorNode);

      this.stationFloorGroups.push(g);
      this.stationFloorKeyByIndex.push(this._keyFromName(g.name, this.floorPrefix));
      this.scene.add(g);
    }

    // Ensure all materials are captured (optional but helps)
    // We don't change anything here—just ensures WeakMap is populated on first ghost if needed.

    this.setStatus(`Station loaded: ${this.stationFloorGroups.length} floor(s).`);

    // default state
    this.mode = "floor";
    this.view = "top";
    this.showAllLevels = false;
    this.activeFloorIndex = 0;

    this.applyVisibility();
    this.recenter();
  }

  buildGraphFromData(nodes, edges) {
    this._clearGraphOverlay();

    const nodesObj = nodes || {};
    const nodeIds = Object.keys(nodesObj);
    if (nodeIds.length === 0) {
      this.graphBuilt = false;
      return;
    }

    // ensure floor groups from node floors
    for (let i = 0; i < nodeIds.length; i++) {
      const id = nodeIds[i];
      const fk = this._safeFloorKey(nodesObj[id] && nodesObj[id].floor);
      this._ensureGraphFloorGroup(fk);
    }
    this._ensureGraphFloorGroup("unknown");

    // node meshes + labels
    const nodeGeom = new THREE.SphereGeometry(0.9, 14, 14);

    for (let i = 0; i < nodeIds.length; i++) {
      const rawId = nodeIds[i];
      const id = String(rawId).trim().toUpperCase();
      const data = nodesObj[rawId];

      if (!data || !data.pos || data.pos.length < 3) continue;

      const fk = this._safeFloorKey(data.floor);
      const group = this.graphFloorGroups[fk] || this.graphFloorGroups["unknown"];

      const mat = new THREE.MeshBasicMaterial({
        color: this.COLOR_NODE_BASE,
        depthTest: false
      });

      const mesh = new THREE.Mesh(nodeGeom, mat);
      mesh.position.set(data.pos[0], data.pos[1], data.pos[2]);
      mesh.renderOrder = 2000;
      mesh.userData = { nodeId: id };

      this.nodeMeshById[id] = mesh;
      group.add(mesh);

      if (this.SHOW_NODE_LABELS) {
        const label = this._makeLabelSprite(id);
        label.position.copy(mesh.position);
        label.position.y += this.LABEL_Y_OFFSET;
        label.renderOrder = 3000;
        group.add(label);
        this.nodeLabelById[id] = label;
      }
    }

    // edges
    const edgeArr = Array.isArray(edges) ? edges : [];
    for (let i = 0; i < edgeArr.length; i++) {
      const e = edgeArr[i];
      if (!e) continue;

      const a = String(e.from || "").trim().toUpperCase();
      const b = String(e.to || "").trim().toUpperCase();
      if (!a || !b) continue;

      // support nodes.json keys that might not be uppercase
      const na = nodesObj[a] || nodesObj[a.toLowerCase()] || null;
      const nb = nodesObj[b] || nodesObj[b.toLowerCase()] || null;
      if (!na || !nb || !na.pos || !nb.pos) continue;

      const fa = this._safeFloorKey(na.floor);
      const fb = this._safeFloorKey(nb.floor);
      const fk = (fa === fb) ? fa : "unknown";
      const group = this.graphFloorGroups[fk] || this.graphFloorGroups["unknown"];

      const p1 = new THREE.Vector3(na.pos[0], na.pos[1], na.pos[2]);
      const p2 = new THREE.Vector3(nb.pos[0], nb.pos[1], nb.pos[2]);

      const geom = new LineGeometry();
      geom.setPositions([
        p1.x, p1.y, p1.z,
        p2.x, p2.y, p2.z
      ]);
      
      const mat = new LineMaterial({
        color: this.COLOR_EDGE_BASE,
        linewidth: this.EDGE_WIDTH_BASE,          // ✅ WIDTH IN PIXELS
        transparent: true,
        depthTest: false
      });

      // REQUIRED for correct scaling
      mat.resolution.set(window.innerWidth, window.innerHeight);

      const line = new Line2(geom, mat);
      line.computeLineDistances();
      line.renderOrder = 1900;

      line.userData = { from: a, to: b, ada: !!e.ada, type: e.type || "corridor" };

      this.edgeLineByKey[this._edgeKey(a, b)] = line;
      group.add(line);

      // --- Hazard glow overlay line (initially hidden) ---
      const glowMat = new LineMaterial({
        color: this.COLOR_HAZARD_GLOW,
        linewidth: this.EDGE_WIDTH_BASE + this.GLOW_WIDTH_EXTRA,
        transparent: true,
        opacity: 0.0,
        depthTest: false,
        blending: THREE.AdditiveBlending
      });
      glowMat.resolution.set(window.innerWidth, window.innerHeight);

      const glowLine = new Line2(geom, glowMat);
      glowLine.computeLineDistances();
      glowLine.renderOrder = 1850; // behind base line but above station ghost
      glowLine.visible = false;

      glowLine.userData = line.userData; // same metadata

      const key = this._edgeKey(a, b);
      this.edgeGlowByKey[key] = glowLine;
      group.add(glowLine);

    }

    this.graphBuilt = true;
    this.applyVisibility();
  }

  setMode(newMode) {
    this.mode = (newMode === "graph") ? "graph" : "floor";
    this.applyVisibility();
    this.recenter();
  }

  setActiveFloor(idx) {
    this.activeFloorIndex = this._clamp(idx, 0, Math.max(0, this.stationFloorGroups.length - 1));
    this.applyVisibility();
    this.recenter();
  }

  setActiveFloorByKey(key) {
    const k = String(key || "").toLowerCase();
    for (let i = 0; i < this.stationFloorKeyByIndex.length; i++) {
      if (this.stationFloorKeyByIndex[i] === k) {
        this.activeFloorIndex = i;
        this.applyVisibility();
        this.recenter();
        return;
      }
    }
  }

  toggleView() {
    this.view = (this.view === "top") ? "perspective" : "top";
    this._applyViewToControls();
    this.recenter();
  }

  setView(v) {
    this.view = (v === "perspective") ? "perspective" : "top";
    this._applyViewToControls();
    this.recenter();
  }

  recenter() {
    if (this.view === "top") this._setTopViewToVisibleContent();
    else this._setPerspectiveViewToVisibleContent();
  }

  clearRoute() {
    // clear sets
    this.routeEdgeKeys.clear();
    this.routeNodeIds.clear();

    // reset edges
    const ekeys = Object.keys(this.edgeLineByKey);
    for (let i = 0; i < ekeys.length; i++) {
      const line = this.edgeLineByKey[ekeys[i]];
      if (!line || !line.material) continue;

      if (line.material.color) line.material.color.setHex(this.COLOR_EDGE_BASE);
      line.material.linewidth = this.EDGE_WIDTH_BASE;
    }

    // reset nodes
    const nkeys = Object.keys(this.nodeMeshById);
    for (let i = 0; i < nkeys.length; i++) {
      const m = this.nodeMeshById[nkeys[i]];
      if (!m || !m.material) continue;

      if (m.material.color) m.material.color.setHex(this.COLOR_NODE_BASE);
      m.scale.set(this.NODE_SCALE_BASE, this.NODE_SCALE_BASE, this.NODE_SCALE_BASE);
    }

    // reset labels
    for (let i = 0; i < nkeys.length; i++) {
      const id = nkeys[i];
      const label = this.nodeLabelById[id];
      if (!label || !label.userData || !label.userData.baseStyle) continue;

      const s = label.userData.baseStyle;
      this._updateLabelStyle(label, s.bg, s.text, s.border);
    }

  }

  highlightRoute(pathNodes, options = {}) {
    if (!this.graphBuilt) return;
    if (!Array.isArray(pathNodes) || pathNodes.length < 2) return;

    this.setMode("graph");

    if (options.floorKey && !this.showAllLevels) {
      this.setActiveFloorByKey(options.floorKey);
    }

    // reset previous route highlight (but keep crowd colors to be re-applied by next tick)
    // If you want to keep current crowd colors immediately, don't reset all edges here.
    // We'll reset only nodes + route edges we touched.
    this.clearRoute();

    // nodes cyan + bigger + label highlight
    for (let i = 0; i < pathNodes.length; i++) {
      const id = String(pathNodes[i]).toUpperCase();

      const mesh = this.nodeMeshById[id];
      if (mesh && mesh.material) {
        mesh.material.color.setHex(this.ROUTE_COLOR);
        mesh.scale.set(this.NODE_SCALE_ROUTE, this.NODE_SCALE_ROUTE, this.NODE_SCALE_ROUTE);
      }

      const label = this.nodeLabelById[id];
      if (label) {
        this._updateLabelStyle(
          label,
          this.LABEL_BG_ROUTE,
          this.LABEL_TEXT_ROUTE,
          this.LABEL_BORDER_ROUTE
        );
      }

      this.routeNodeIds.add(id);
    }


    // edges cyan + thicker, and LOCK them
    for (let i = 0; i < pathNodes.length - 1; i++) {
      const a = String(pathNodes[i]).toUpperCase();
      const b = String(pathNodes[i + 1]).toUpperCase();

      const k = this._edgeKey(a, b);
      const line = this.edgeLineByKey[k];
      if (!line || !line.material) continue;

      if (line.material.color) line.material.color.setHex(this.ROUTE_COLOR);
      line.material.linewidth = this.EDGE_WIDTH_ROUTE;

      this.routeEdgeKeys.add(k);
    }
  }

  /**
   * crowdByEdgeKey: { "A|B": 0..1 }
   * Route edges are "locked" cyan and won't be overwritten.
   */
  setCrowdColors(crowdByEdgeKey, options = {}) {
    const min = (typeof options.min === "number") ? options.min : 0;
    const max = (typeof options.max === "number") ? options.max : 1;
    const missingColor = (options.missingColor != null) ? options.missingColor : this.COLOR_EDGE_BASE;

    const keys = Object.keys(this.edgeLineByKey);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const line = this.edgeLineByKey[k];
      if (!line || !line.material || !line.material.color) continue;

      // ✅ Do NOT overwrite highlighted route edges
      if (this.routeEdgeKeys.has(k)) continue;

      const raw = crowdByEdgeKey ? crowdByEdgeKey[k] : undefined;
      if (typeof raw !== "number" || isNaN(raw)) {
        line.material.color.setHex(missingColor);
        line.material.linewidth = this.EDGE_WIDTH_BASE;
        continue;
      }

      const t = this._clamp((raw - min) / (max - min || 1), 0, 1);
      // green (0.33) -> orange (~0.08)
      const hueGreen = 0.33;
      const hueOrange = 0.08;
      const hue = hueGreen + (hueOrange - hueGreen) * t;
      const col = new THREE.Color().setHSL(hue, 1.0, 0.5);

      line.material.color.copy(col);
      line.material.linewidth = this.EDGE_WIDTH_BASE;
    }
  }

/**
 * edgeStateByKey: { "A|B": { status, speedFactor, hazardLevel } | null }
 *
 * Rules:
 * - Crowd controls base color (green->orange) via setCrowdColors()
 * - Construction: dashed line only (no color change)
 * - Hazard/Emergency: red glow overlay, and overrides crowd appearance (base turns red)
 * - Route edges remain cyan; hazard may glow on top of route (recommended)
 */
applyEdgeState(edgeStateByKey) {
  const keys = Object.keys(this.edgeLineByKey);

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];

    const line = this.edgeLineByKey[k];
    if (!line || !line.material || !line.material.color) continue;

    const glow = this.edgeGlowByKey[k];
    const st = edgeStateByKey ? edgeStateByKey[k] : null;

    // ---- Defaults each tick (important!) ----
    // Construction default: not dashed
    line.material.dashed = false;

    // Hazard default: off
    if (glow) {
      glow.visible = false;
      if (glow.material) glow.material.opacity = 0.0;
    }

    // If no state, keep whatever crowd already set
    if (!st) continue;

    // --- Construction (speedFactor > 1): dashed line, no color change ---
    const sf = (typeof st.speedFactor === "number") ? st.speedFactor : 1.0;
    if (sf > 1.5) {
      line.material.dashed = true;
      line.material.dashSize = this.DASH_SIZE;
      line.material.gapSize = this.GAP_SIZE;
    }

    // --- Hazard glow overlay (0..1) ---
    const hz = (typeof st.hazardLevel === "number") ? st.hazardLevel : 0.0;
    const hazard = this._clamp(hz, 0, 1);

    if (hazard > 0.001) {
      // If it's a route edge: keep cyan base, but allow red glow overlay
      if (this.routeEdgeKeys.has(k)) {
        if (glow && glow.material) {
          glow.visible = true;
          glow.material.opacity = Math.min(this.GLOW_MAX_OPACITY, hazard * this.GLOW_MAX_OPACITY);
        }
        continue;
      }

      // Non-route edge: hazard overrides crowd => base line becomes red
      line.material.color.setHex(this.COLOR_HAZARD_GLOW);
      line.material.linewidth = this.EDGE_WIDTH_BASE;

      if (glow && glow.material) {
        glow.visible = true;
        glow.material.opacity = Math.min(this.GLOW_MAX_OPACITY, hazard * this.GLOW_MAX_OPACITY);
        glow.material.linewidth = this.EDGE_WIDTH_BASE + this.GLOW_WIDTH_EXTRA;
      }
    }
  }
}


  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.renderer.setSize(w, h);

    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();

    this._updateOrthoFrustum(this.ORTHO_HALF_H);

    // Update line material resolution for thick lines (base + glow)
    const ekeys = Object.keys(this.edgeLineByKey);
    for (let i = 0; i < ekeys.length; i++) {
      const line = this.edgeLineByKey[ekeys[i]];
      if (line && line.material && line.material.resolution) {
        line.material.resolution.set(w, h);
      }
    }

    const gkeys = Object.keys(this.edgeGlowByKey);
    for (let i = 0; i < gkeys.length; i++) {
      const glow = this.edgeGlowByKey[gkeys[i]];
      if (glow && glow.material && glow.material.resolution) {
        glow.material.resolution.set(w, h);
      }
    }

  }

  /* =========================================================
     VISIBILITY
  ========================================================= */

  applyVisibility() {
    const activeFloorKey = this.stationFloorKeyByIndex[this.activeFloorIndex] || "unknown";

    if (this.mode === "floor") {
      // ✅ IMPORTANT: restore original materials across ALL floors (shared materials!)
      for (let i = 0; i < this.stationFloorGroups.length; i++) {
        this._restoreOriginalMaterial(this.stationFloorGroups[i]);
      }
    }

    // ---- station floors ----
    for (let i = 0; i < this.stationFloorGroups.length; i++) {
      const g = this.stationFloorGroups[i];
      const isActive = (i === this.activeFloorIndex);

      if (this.mode === "floor") {
        // model mode: ALWAYS original materials
        g.visible = this.showAllLevels ? true : isActive;
      } else {
        // graph mode: optional ghost overlay
        const showGhost = this.GRAPH_SHOW_STATION_GHOST && (this.showAllLevels ? true : isActive);
        g.visible = showGhost;

        if (g.visible) this._applyGhostMaterial(g, this.GHOST_OPACITY);
      }
    }

    // ---- graph floors ----
    const fks = Object.keys(this.graphFloorGroups);
    for (let i = 0; i < fks.length; i++) {
      const fk = fks[i];
      const gg = this.graphFloorGroups[fk];
      if (!gg) continue;

      if (this.mode !== "graph") {
        gg.visible = false;
      } else {
        if (this.showAllLevels) {
          gg.visible = true;
        } else {
          gg.visible = (fk === activeFloorKey || fk === "unknown");
        }
      }
    }

    // labels only in graph mode
    this._setLabelsVisible(this.mode === "graph");
  }

  /* =========================================================
     VIEW SWITCHING (TOP vs PERSPECTIVE)
  ========================================================= */

  _applyViewToControls() {
    if (this.view === "top") {
      this.camera = this.orthoCam;
      this.controls.object = this.orthoCam;

      this.controls.enableRotate = false;

      this.controls.minZoom = 0.35;
      this.controls.maxZoom = 6.0;

      this._updateOrthoFrustum(this.ORTHO_HALF_H);
    } else {
      this.camera = this.perspCam;
      this.controls.object = this.perspCam;

      this.controls.enableRotate = true;
      this.controls.minPolarAngle = 0.15;
      this.controls.maxPolarAngle = Math.PI * 0.48;

      this.controls.minDistance = 25;
      this.controls.maxDistance = 900;

      this.perspCam.fov = this.PERSP_FOV;
      this.perspCam.updateProjectionMatrix();
    }

    this.controls.update();
  }

  _setTopViewToVisibleContent() {
    const box = this._computeVisibleBounds();
    if (!box) return;

    const center = new THREE.Vector3();
    box.getCenter(center);

    this.orthoCam.position.set(center.x, center.y + this.TOP_CAM_HEIGHT, center.z);
    this.orthoCam.lookAt(center);

    this.controls.target.copy(center);
    this.controls.update();
  }

  _setPerspectiveViewToVisibleContent() {
    const box = this._computeVisibleBounds();
    if (!box) return;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.6 + 40;

    this.perspCam.position.set(
      center.x + dist * 0.35,
      center.y + this.PERSP_CAM_HEIGHT,
      center.z + dist * 0.55
    );
    this.perspCam.lookAt(center);

    this.controls.target.copy(center);
    this.controls.update();
  }

  _computeVisibleBounds() {
    const box = new THREE.Box3();
    let has = false;

    // In graph mode, prefer graph bounds for recenter.
    if (this.mode === "graph" && this.graphBuilt) {
      const fks = Object.keys(this.graphFloorGroups);
      for (let i = 0; i < fks.length; i++) {
        const g = this.graphFloorGroups[fks[i]];
        if (g && g.visible) {
          box.expandByObject(g);
          has = true;
        }
      }
    }

    if (!has) {
      for (let i = 0; i < this.stationFloorGroups.length; i++) {
        const g = this.stationFloorGroups[i];
        if (g && g.visible) {
          box.expandByObject(g);
          has = true;
        }
      }
    }

    if (!has) return null;
    return box;
  }

  _updateOrthoFrustum(halfH) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;

    this.orthoCam.left = -halfH * aspect;
    this.orthoCam.right = halfH * aspect;
    this.orthoCam.top = halfH;
    this.orthoCam.bottom = -halfH;

    this.orthoCam.updateProjectionMatrix();
  }

  /* =========================================================
     LABELS
  ========================================================= */

  _makeLabelSprite(text) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    ctx.font = this.LABEL_FONT;

    const paddingX = this.LABEL_PAD_X;
    const paddingY = this.LABEL_PAD_Y;

    const metrics = ctx.measureText(text);
    const textW = Math.ceil(metrics.width);
    const textH = 14; // ok for 12px font

    const w = textW + paddingX * 2;
    const h = textH + paddingY * 2;

    canvas.width = w;
    canvas.height = h;

    // background rounded rect
    ctx.font = this.LABEL_FONT;
    ctx.fillStyle = this.LABEL_BG_COLOR;
    ctx.strokeStyle = this.LABEL_BORDER_COLOR;
    ctx.lineWidth = 1;

    const r = this.LABEL_RADIUS;

    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // text
    ctx.fillStyle = this.LABEL_TEXT_COLOR;
    ctx.textBaseline = "middle";
    ctx.fillText(text, paddingX, h / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false
    });

    const sprite = new THREE.Sprite(mat);

    // Save base styles + text for later redraw
    sprite.userData = {
      baseStyle: {
        bg: this.LABEL_BG_COLOR,
        text: this.LABEL_TEXT_COLOR,
        border: this.LABEL_BORDER_COLOR
      },
      text
    };

    sprite.renderOrder = 3000;

    // World size scaling
    sprite.scale.set((w / 20) * this.LABEL_SCALE, (h / 20) * this.LABEL_SCALE, 1);

    return sprite;
  }

  _setLabelsVisible(visible) {
    const ids = Object.keys(this.nodeLabelById);
    for (let i = 0; i < ids.length; i++) {
      const s = this.nodeLabelById[ids[i]];
      if (s) s.visible = !!visible;
    }
  }

  _updateLabelStyle(sprite, bg, text, border) {
    if (!sprite || !sprite.material || !sprite.material.map) return;

    const canvas = sprite.material.map.image; // ✅ removed stray token
    const ctx = canvas.getContext("2d");

    const paddingX = this.LABEL_PAD_X;
    const r = this.LABEL_RADIUS;

    const textStr = sprite.userData && sprite.userData.text ? sprite.userData.text : "";
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // background
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(canvas.width - r, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, r);
    ctx.lineTo(canvas.width, canvas.height - r);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - r, canvas.height);
    ctx.lineTo(r, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // text
    ctx.font = this.LABEL_FONT;
    ctx.fillStyle = text;
    ctx.textBaseline = "middle";
    ctx.fillText(textStr, paddingX, canvas.height / 2);

    sprite.material.map.needsUpdate = true;
  }

  /* =========================================================
     MATERIALS: ghost + restore (PER MATERIAL, fixes shared mats)
  ========================================================= */

  _applyGhostMaterial(obj3d, opacity) {
    obj3d.traverse((o) => {
      if (!o.isMesh || !o.material) return;

      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m) continue;

        // ✅ store once per MATERIAL
        if (!this._origMatByMaterial.has(m)) {
          this._origMatByMaterial.set(m, {
            transparent: m.transparent,
            opacity: m.opacity,
            depthWrite: m.depthWrite,
            depthTest: m.depthTest
          });
        }

        m.transparent = true;
        m.opacity = opacity;
        m.depthWrite = this.GHOST_DEPTH_WRITE;
        m.depthTest = this.GHOST_DEPTH_TEST;
        m.needsUpdate = true;
      }
    });
  }

  _restoreOriginalMaterial(obj3d) {
    obj3d.traverse((o) => {
      if (!o.isMesh || !o.material) return;

      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m) continue;

        const saved = this._origMatByMaterial.get(m);
        if (!saved) continue;

        m.transparent = saved.transparent;
        m.opacity = saved.opacity;
        m.depthWrite = saved.depthWrite;
        m.depthTest = saved.depthTest;
        m.needsUpdate = true;
      }
    });
  }

  /* =========================================================
     INTERNAL HELPERS
  ========================================================= */

  setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg;
  }

  _clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  _collectGroupsByPrefix(root, prefixLower) {
    const floors = [];
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i];
      const n = (child.name || "").toLowerCase();
      if (n.startsWith(prefixLower)) floors.push(child);
    }
    return floors.length > 0 ? floors : [root];
  }

  _keyFromName(name, prefixLower) {
    const n = (name || "").toLowerCase();
    if (n.startsWith(prefixLower)) return n.slice(prefixLower.length);
    return n;
  }

  _safeFloorKey(v) {
    const fk = String(v || "").toLowerCase();
    return fk ? fk : "unknown";
  }

  _ensureGraphFloorGroup(floorKey) {
    const fk = this._safeFloorKey(floorKey);
    if (this.graphFloorGroups[fk]) return this.graphFloorGroups[fk];

    const g = new THREE.Group();
    g.name = "graph_" + fk;
    this.graphFloorGroups[fk] = g;
    this.scene.add(g);
    return g;
  }

  _edgeKey(a, b) {
    const A = String(a);
    const B = String(b);
    return (A < B) ? (A + "|" + B) : (B + "|" + A);
  }

  _clearGraphOverlay() {
    const fks = Object.keys(this.graphFloorGroups);
    for (let i = 0; i < fks.length; i++) {
      const g = this.graphFloorGroups[fks[i]];
      if (g) this.scene.remove(g);
    }
    this.graphFloorGroups = {};
    this.edgeLineByKey = {};
    this.nodeMeshById = {};
    this.nodeLabelById = {};
    this.graphBuilt = false;
    this.edgeGlowByKey = {};
  }

  _loadGLTF(url) {
    return new Promise((resolve, reject) => {
      this.loader.load(url, resolve, undefined, reject);
    });
  }
}
