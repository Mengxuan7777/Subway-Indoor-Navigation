// crowd_sim.js
// Type-aware crowd simulation for edges.json
// Produces crowdByEdgeKey: { "A|B": 0..1 } and updates smoothly over time.

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function edgeKey(a, b) {
  const A = String(a || "").trim().toUpperCase();
  const B = String(b || "").trim().toUpperCase();
  return (A < B) ? `${A}|${B}` : `${B}|${A}`;
}

// deterministic random per key + time bucket
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class CrowdSimulator {
  constructor(opts = {}) {
    this.updateMs = typeof opts.updateMs === "number" ? opts.updateMs : 60000; // 1 min
    this.smoothing = typeof opts.smoothing === "number" ? opts.smoothing : 0.85; // 0..1 higher=smoother
    this.globalBase = typeof opts.globalBase === "number" ? opts.globalBase : 0.20; // 0..1
    this.enableRush = opts.enableRush !== false;

    // edgeKey -> { value, meta }
    this._state = {};
    this._timer = null;

    // baseline + spikiness by type (tweak these freely)
    this.typeParams = {
      platform: { base: 0.18, volatility: 0.14 },
      stairs:   { base: 0.28, volatility: 0.22 },
      elevator: { base: 0.32, volatility: 0.26 },
      gate:     { base: 0.38, volatility: 0.30 },
      unknown:  { base: 0.22, volatility: 0.18 }
    };
  }

  setEdges(edgesArray) {
    this._state = {};

    for (let i = 0; i < edgesArray.length; i++) {
      const e = edgesArray[i];
      if (!e) continue;

      const k = edgeKey(e.from, e.to);
      const type = (e.type || "unknown").toLowerCase();
      const ada = !!e.ada;

      const p = this.typeParams[type] || this.typeParams.unknown;

      // ADA edges often have elevator segments; if ADA=false, can be stairs -> more bursty crowd
      const adaAdj = ada ? -0.03 : +0.05;

      // stable initial value per edge
      const rnd0 = mulberry32(hashToSeed("init:" + k));
      const init = clamp01(this.globalBase + p.base + adaAdj + (rnd0() - 0.5) * 0.10);

      this._state[k] = {
        value: init,
        meta: { type, ada }
      };
    }
  }

  getCrowdMap() {
    const out = {};
    const keys = Object.keys(this._state);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      out[k] = this._state[k].value;
    }
    return out;
  }

  start(onUpdate) {
    this.stop();
    this._tick(onUpdate);
    this._timer = setInterval(() => this._tick(onUpdate), this.updateMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _rushFactor(date) {
    // Two daily peaks: ~08:30 and ~18:00 (NYC commute style)
    const t = date.getHours() * 60 + date.getMinutes();
    const g = (x, mu, s) => Math.exp(-((x - mu) * (x - mu)) / (2 * s * s));
    const morning = g(t, 8 * 60 + 30, 90);
    const evening = g(t, 18 * 60, 90);
    return clamp01(morning + evening); // ~0..1
  }

  _tick(onUpdate) {
    const now = new Date();
    const rush = this.enableRush ? this._rushFactor(now) : 0;

    // time bucket: changes once per minute (matches update frequency)
    const bucket = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;

    const keys = Object.keys(this._state);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const st = this._state[k];
      const type = st.meta.type || "unknown";
      const ada = st.meta.ada;

      const p = this.typeParams[type] || this.typeParams.unknown;

      // deterministic noise per edge per minute bucket
      const rnd = mulberry32(hashToSeed(k + "|" + bucket));
      const noise = (rnd() - 0.5) * 2; // -1..1

      // Type-based target + rush boost + per-edge noise
      // Rush affects gates/elevators more (bottlenecks).
      const rushBoost =
        (type === "gate" ? 0.35 :
         type === "elevator" ? 0.30 :
         type === "stairs" ? 0.22 :
         0.16) * rush;

      const adaAdj = ada ? -0.03 : +0.05;

      const target = clamp01(this.globalBase + p.base + adaAdj + rushBoost + p.volatility * noise);

      // Smooth update (EMA)
      st.value = clamp01(this.smoothing * st.value + (1 - this.smoothing) * target);
    }

    if (typeof onUpdate === "function") onUpdate(this.getCrowdMap(), now);
  }
}
