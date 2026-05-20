const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const rooms = new Map();
const AUCTION_MS = 15000;
const RESULT_MS = 1000;

const ORDER = [
  "marquee batsmen set-1",
  "marquee wk batsmen set-1",
  "marquee all rounders set-1",
  "marquee bowlers set-1",
  "batsmen set-2",
  "wk batsmen set-2",
  "all rounders set-2",
  "bowlers set-2",
  "batsmen set-3",
  "wk batsmen set-3",
  "all rounders set-3",
  "bowlers set-3"
];

function id(size = 6) {
  return crypto.randomBytes(size).toString("hex").slice(0, size).toUpperCase();
}

function money(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  let num = Number(raw.replace(/[^\d.]/g, ""));
  if (raw.includes("cr")) num *= 10000000;
  if (raw.includes("lakh") || raw.includes("lac")) num *= 100000;
  return Number.isFinite(num) ? num : 0;
}

function norm(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeSet(value) {
  const raw = norm(value)
    .replace(/bowlerse/g, "bowlers")
    .replace(/wicket[-\s]*keeper/g, "wk")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "unsorted";

  const words = new Set(raw.split(" "));
  const setNo = (raw.match(/\bset\s*(\d+)\b/) || [])[1] || (words.has("marquee") ? "1" : "");
  const number = setNo || "1";
  const isSetOne = number === "1";
  const prefix = isSetOne ? "marquee " : "";

  if (words.has("wk") || raw.includes("wicket keeper")) return `${prefix}wk batsmen set-${number}`;
  if (words.has("all") && (words.has("rounder") || words.has("rounders"))) return `${prefix}all rounders set-${number}`;
  if (words.has("bowler") || words.has("bowlers")) return `${prefix}bowlers set-${number}`;
  if (words.has("batsman") || words.has("batsmen") || words.has("batter") || words.has("batters")) return `${prefix}batsmen set-${number}`;
  return raw;
}

function send(res, status, data, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((v) => String(v).trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((v) => String(v).trim())) rows.push(row);
  return rows;
}

function xmlText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : "";
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function unzip(buffer) {
  const files = {};
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset++;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.slice(start, start + compressedSize);
    if (compressedSize > 0) {
      files[name] = method === 8 ? zlib.inflateRawSync(data).toString("utf8") : data.toString("utf8");
    }
    offset = start + compressedSize;
  }
  return files;
}

function parseXlsx(buffer) {
  const files = unzip(buffer);
  const shared = [];
  const sharedXml = files["xl/sharedStrings.xml"] || "";
  for (const match of sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(decodeXml(match[1]));
  }

  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = files["xl/workbook.xml"] || "";
  const rels = files["xl/_rels/workbook.xml.rels"] || "";
  const firstSheet = workbook.match(/<sheet[^>]*r:id="([^"]+)"/);
  if (firstSheet) {
    const rel = rels.match(new RegExp(`<Relationship[^>]*Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`));
    if (rel) sheetPath = path.posix.join("xl", rel[1].replace(/^\/?xl\//, ""));
  }

  const sheet = files[sheetPath];
  if (!sheet) throw new Error("No worksheet found in this Excel file.");
  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || "";
      let col = 0;
      for (const char of ref) col = col * 26 + char.charCodeAt(0) - 64;
      const target = Math.max(0, col - 1);
      while (row.length < target) row.push("");
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      const raw = xmlText(cellMatch[2], "v") || xmlText(cellMatch[2], "t");
      row[target] = type === "s" ? shared[Number(raw)] || "" : decodeXml(raw);
    }
    if (row.some((v) => String(v).trim())) rows.push(row);
  }
  return rows;
}

function rowsToPlayers(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => norm(h));
  const index = (...names) => {
    const found = headers.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    return found >= 0 ? found : -1;
  };
  const nameI = index("name", "player");
  const baseI = index("base price", "base prize", "price", "prize", "base");
  const setI = index("set", "auction set");
  const roleI = index("role");
  const pointsI = index("points", "point");
  if (nameI < 0) throw new Error("The sheet needs a player name column.");
  return rows.slice(1).map((row, i) => ({
    id: `P${i + 1}-${id(4)}`,
    name: String(row[nameI] || "").trim(),
    basePrice: money(row[baseI]),
    set: normalizeSet(row[setI] || row[roleI]),
    role: String(row[roleI] || "").trim() || "Player",
    points: money(row[pointsI]),
    status: "waiting",
    soldTo: null,
    soldFor: 0
  })).filter((p) => p.name);
}

function sortPlayers(players) {
  const rank = new Map(ORDER.map((name, i) => [name, i]));
  const buckets = new Map();
  for (const player of players) {
    const key = rank.get(player.set) ?? 99;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(player);
  }
  for (const bucket of buckets.values()) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [bucket[i], bucket[j]] = [bucket[j], bucket[i]];
    }
  }
  return [...buckets.keys()].sort((a, b) => a - b).flatMap((key) => buckets.get(key));
}

function publicRoom(room) {
  const active = room.players[room.currentIndex] || null;
  const teams = [...room.teams.values()].map((team) => {
    const roster = room.players.filter((p) => p.soldTo === team.id);
    return {
      id: team.id,
      name: team.name,
      budget: team.budget,
      spent: roster.reduce((sum, p) => sum + p.soldFor, 0),
      remaining: team.budget - roster.reduce((sum, p) => sum + p.soldFor, 0),
      points: roster.reduce((sum, p) => sum + p.points, 0),
      players: roster.length,
      squad: roster.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        set: p.set,
        soldFor: p.soldFor,
        points: p.points
      }))
    };
  });
  return {
    code: room.code,
    status: room.status,
    budget: room.budget,
    bidStep: room.bidStep,
    order: ORDER,
    teams,
    maxTeams: 20,
    players: room.players,
    active,
    currentBid: room.currentBid,
    highestBidder: room.highestBidder,
    timerEndsAt: room.timerEndsAt,
    pausedRemainingMs: room.pausedRemainingMs || null,
    lastResult: room.lastResult,
    message: room.message
  };
}

function broadcast(room) {
  const payload = `data: ${JSON.stringify(publicRoom(room))}\n\n`;
  for (const res of room.clients) res.write(payload);
}

function clearClock(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.timerEndsAt = null;
}

function clearResultDelay(room) {
  if (room.resultTimer) clearTimeout(room.resultTimer);
  room.resultTimer = null;
}

function pauseClock(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.pausedRemainingMs = Math.max(1000, (room.timerEndsAt || Date.now()) - Date.now());
  room.timerEndsAt = null;
}

function nextUnsold(room) {
  clearClock(room);
  clearResultDelay(room);
  room.currentBid = 0;
  room.highestBidder = null;
  room.currentIndex += 1;
  while (room.players[room.currentIndex] && room.players[room.currentIndex].status !== "waiting") {
    room.currentIndex += 1;
  }
  if (!room.players[room.currentIndex]) {
    room.status = "finished";
    room.message = "Auction complete.";
  } else {
    const player = room.players[room.currentIndex];
    room.currentBid = player.basePrice;
    room.message = `${player.name} is up next.`;
    if (room.status === "live") startClock(room);
  }
}

function settleActive(room, forcedUnsold = false) {
  const player = room.players[room.currentIndex];
  if (!player || player.status !== "waiting") return;
  clearClock(room);
  if (!room.highestBidder || forcedUnsold) {
    player.status = "unsold";
    room.message = forcedUnsold ? `${player.name} marked unsold by host.` : `${player.name} went unsold.`;
    room.lastResult = {
      id: `${player.id}-${Date.now()}`,
      type: "unsold",
      player: player.name,
      team: null,
      amount: 0
    };
  } else {
    player.status = "sold";
    player.soldTo = room.highestBidder;
    player.soldFor = room.currentBid;
    const team = room.teams.get(room.highestBidder);
    room.message = `${player.name} sold to ${team.name} for ${room.currentBid}.`;
    room.lastResult = {
      id: `${player.id}-${Date.now()}`,
      type: "sold",
      player: player.name,
      team: team.name,
      amount: room.currentBid
    };
  }
  broadcast(room);
  const settledId = player.id;
  room.resultTimer = setTimeout(() => {
    const current = room.players[room.currentIndex];
    if (current && current.id === settledId && current.status !== "waiting") {
      nextUnsold(room);
      broadcast(room);
    }
  }, RESULT_MS);
}

function sellActive(room) {
  settleActive(room);
}

function startClock(room, durationMs = AUCTION_MS) {
  clearClock(room);
  room.pausedRemainingMs = null;
  room.timerEndsAt = Date.now() + durationMs;
  room.timer = setTimeout(() => sellActive(room), durationMs);
}

function requireRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Room not found.");
  return room;
}

function requireHost(room, token) {
  if (!token || token !== room.hostToken) throw new Error("Host access required.");
}

async function api(req, res) {
  try {
    if (req.method === "POST" && req.url === "/api/rooms") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const code = id();
      const room = {
        code,
        hostToken: id(18),
        status: "lobby",
        budget: money(body.budget) || 100000000,
        bidStep: money(body.bidStep) || 1000000,
        teams: new Map(),
        players: [],
        currentIndex: -1,
        currentBid: 0,
        highestBidder: null,
        timer: null,
        timerEndsAt: null,
        resultTimer: null,
        pausedRemainingMs: null,
        clients: new Set(),
        lastResult: null,
        message: "Room created."
      };
      rooms.set(code, room);
      return send(res, 200, { ...publicRoom(room), hostToken: room.hostToken });
    }

    if (req.method === "GET" && req.url.startsWith("/api/rooms/") && req.url.endsWith("/events")) {
      const code = req.url.split("/")[3];
      const room = requireRoom(code);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      room.clients.add(res);
      res.write(`data: ${JSON.stringify(publicRoom(room))}\n\n`);
      req.on("close", () => room.clients.delete(res));
      return;
    }

    if (req.method === "GET" && req.url.match(/^\/api\/rooms\/[^/]+$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/join$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const teamName = String(body.teamName || "").trim();
      if (!teamName) throw new Error("Team name is required.");
      if (room.teams.size >= 20) throw new Error("This room already has 20 teams.");
      if ([...room.teams.values()].some((t) => norm(t.name) === norm(teamName))) throw new Error("Team name already taken.");
      const team = { id: id(10), name: teamName, budget: room.budget };
      room.teams.set(team.id, team);
      room.message = `${team.name} joined.`;
      broadcast(room);
      return send(res, 200, { teamId: team.id, room: publicRoom(room) });
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/players$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      requireHost(room, req.headers["x-host-token"]);
      const filename = req.headers["x-file-name"] || "";
      const buffer = await readBody(req);
      const rows = filename.toLowerCase().endsWith(".csv") ? csvRows(buffer.toString("utf8")) : parseXlsx(buffer);
      room.players = sortPlayers(rowsToPlayers(rows));
      room.currentIndex = -1;
      room.status = "lobby";
      room.pausedRemainingMs = null;
      clearResultDelay(room);
      room.message = `${room.players.length} players loaded.`;
      room.lastResult = null;
      nextUnsold(room);
      room.status = "lobby";
      clearClock(room);
      broadcast(room);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/start$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      requireHost(room, req.headers["x-host-token"]);
      if (!room.players.length) throw new Error("Upload players before starting.");
      room.status = "live";
      if (room.currentIndex < 0) nextUnsold(room);
      if (room.players[room.currentIndex]) startClock(room);
      room.message = "Auction started.";
      broadcast(room);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/pause$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      requireHost(room, req.headers["x-host-token"]);
      if (room.status !== "live") throw new Error("Only a live auction can be paused.");
      const player = room.players[room.currentIndex];
      if (!player || player.status !== "waiting" || !room.timerEndsAt) throw new Error("Wait for the next player before pausing.");
      pauseClock(room);
      room.status = "paused";
      room.message = "Auction paused by host.";
      broadcast(room);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/resume$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      requireHost(room, req.headers["x-host-token"]);
      if (room.status !== "paused") throw new Error("Auction is not paused.");
      room.status = "live";
      if (room.players[room.currentIndex]) startClock(room, room.pausedRemainingMs || AUCTION_MS);
      room.message = "Auction resumed by host.";
      broadcast(room);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/skip$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      requireHost(room, req.headers["x-host-token"]);
      const player = room.players[room.currentIndex];
      if (!player) throw new Error("No active player.");
      if (room.status === "paused") room.status = "live";
      settleActive(room, true);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/sell$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      requireHost(room, req.headers["x-host-token"]);
      const player = room.players[room.currentIndex];
      if (!player) throw new Error("No active player.");
      if (player.status !== "waiting") throw new Error("Wait for the next player.");
      if (!room.highestBidder) throw new Error("There is no current bidder to sell to.");
      if (room.status === "paused") room.status = "live";
      settleActive(room);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/end$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      requireHost(room, req.headers["x-host-token"]);
      clearClock(room);
      clearResultDelay(room);
      room.status = "finished";
      room.timerEndsAt = null;
      room.pausedRemainingMs = null;
      room.currentBid = 0;
      room.highestBidder = null;
      room.message = "Auction ended by host.";
      broadcast(room);
      return send(res, 200, publicRoom(room));
    }

    if (req.method === "POST" && req.url.match(/^\/api\/rooms\/[^/]+\/bid$/)) {
      const room = requireRoom(req.url.split("/")[3]);
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const team = room.teams.get(body.teamId);
      const player = room.players[room.currentIndex];
      if (room.status !== "live") throw new Error(room.status === "paused" ? "Auction is paused." : "Auction is not live.");
      if (!team) throw new Error("Join with a team before bidding.");
      if (!player) throw new Error("No active player.");
      if (player.status !== "waiting") throw new Error("Wait for the next player.");
      const roster = room.players.filter((p) => p.soldTo === team.id);
      const remaining = team.budget - roster.reduce((sum, p) => sum + p.soldFor, 0);
      const nextBid = Math.max(player.basePrice, room.currentBid + (room.highestBidder ? room.bidStep : 0));
      if (nextBid > remaining) throw new Error("Not enough budget for this bid.");
      room.currentBid = nextBid;
      room.highestBidder = team.id;
      room.message = `${team.name} bids ${nextBid} for ${player.name}.`;
      startClock(room);
      broadcast(room);
      return send(res, 200, publicRoom(room));
    }

    send(res, 404, { error: "Not found." });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return api(req, res);
  const urlPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(PUBLIC, urlPath);
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(file, (error, data) => {
    if (error) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`IPL Auction Arena running at http://localhost:${PORT}`);
});
