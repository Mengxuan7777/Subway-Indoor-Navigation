// graphData.js
export const NODES = {
  "NM":  { floor: "mezzanine", pos: [10, 8, 0],  ada: true },
  "EX1": { floor: "mezzanine", pos: [40, 8, 10], ada: true },
  "DS1": { floor: "platform",  pos: [0, 0, 0],   ada: true }
};

export const EDGES = [
  { from: "NM",  to: "EX1", dist: 30, crowd: 0.2, ada: true },
  { from: "DS1", to: "NM",  dist: 25, crowd: 0.8, ada: true }
];
