// chat.js
export class ChatController {
  constructor() {
    this.chatLog = document.getElementById("chatLog");
    this.chatInput = document.getElementById("chatInput");
    this.locInput = document.getElementById("locInput");
    this.destInput = document.getElementById("destInput");
    this.sendBtn = document.getElementById("sendBtn");
    this.chips = document.querySelectorAll(".chip");

    this.criteria = "shortest";
    this.listeners = { request: [] };
  }

  onRequest(fn) {
    this.listeners.request.push(fn);
  }

  _emitRequest(req) {
    for (let i = 0; i < this.listeners.request.length; i++) {
      this.listeners.request[i](req);
    }
  }

  addMsg(text, who) {
    const div = document.createElement("div");
    div.className = "msg " + who;
    div.textContent = text;
    this.chatLog.appendChild(div);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  normalizeNodeId(s) {
    return (s || "").trim().toUpperCase();
  }

  parseFreeText(text) {
    const t = (text || "").trim();
    if (!t) return;

    const upper = t.toUpperCase();
    const tokens = upper.split(/[^A-Z0-9_]+/).filter((x) => x.length > 0);

    let from = "";
    let to = "";
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "FROM" && i + 1 < tokens.length) from = tokens[i + 1];
      if (tokens[i] === "TO" && i + 1 < tokens.length) to = tokens[i + 1];
    }

    if (from) this.locInput.value = from;
    if (to) this.destInput.value = to;

    if (upper.indexOf("ADA") !== -1) this.criteria = "ada";
    else if (upper.indexOf("LEAST") !== -1 || upper.indexOf("CROWD") !== -1) this.criteria = "least_crowds";
    else if (upper.indexOf("SHORT") !== -1) this.criteria = "shortest";
  }

  bind() {
    // chips
    for (let i = 0; i < this.chips.length; i++) {
      this.chips[i].addEventListener("click", (e) => {
        const crit = e.target.getAttribute("data-crit");
        if (crit) this.criteria = crit;
        this.addMsg("Criteria set: " + this.criteria, "bot");
      });
    }

    // send
    this.sendBtn.addEventListener("click", () => {
      const free = (this.chatInput.value || "").trim();
      if (free) {
        this.addMsg(free, "user");
        this.parseFreeText(free);
        this.chatInput.value = "";
      }

      const start = this.normalizeNodeId(this.locInput.value);
      const goal = this.normalizeNodeId(this.destInput.value);
      const req = {
        start,
        goal,
        criteria: this.criteria,
        ada: (this.criteria === "ada"),
        freeText: free 
      };
      this._emitRequest(req);
    });

    this.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.sendBtn.click();
    });

    this.addMsg("Ask me the route to your destination with certain criteria.", "bot");
  }
}
