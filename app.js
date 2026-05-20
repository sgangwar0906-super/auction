const $ = (id) => document.getElementById(id);
let state = null;
let hostToken = localStorage.getItem("iplHostToken") || "";
let hostRoom = localStorage.getItem("iplHostRoom") || "";
let teamId = localStorage.getItem("iplTeamId") || "";
let teamRoom = localStorage.getItem("iplTeamRoom") || "";
let roomCode = new URLSearchParams(location.search).get("room") || localStorage.getItem("iplRoom") || "";
let events = null;
let lastResultId = "";
let soundReady = false;

function fmt(value) {
  return Number(value || 0).toLocaleString("en-IN");
}

function fmtMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 10000000) {
    const cr = amount / 10000000;
    return `${Number.isInteger(cr) ? cr : cr.toFixed(2)} cr`;
  }
  if (amount >= 100000) {
    const lakh = amount / 100000;
    return `${Number.isInteger(lakh) ? lakh : lakh.toFixed(2)} lakh`;
  }
  return fmt(amount);
}

function unlockSound() {
  soundReady = true;
}

function playResultSound(type) {
  if (!soundReady) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = type === "sold" ? 720 : 260;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.42);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch (error) {
    soundReady = false;
  }
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(hostToken ? { "x-host-token": hostToken } : {}),
      ...(options.headers || {})
    }
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  });
}

function connect(code) {
  if (events) events.close();
  roomCode = code.toUpperCase();
  localStorage.setItem("iplRoom", roomCode);
  history.replaceState(null, "", `?room=${roomCode}`);
  events = new EventSource(`/api/rooms/${roomCode}/events`);
  events.onmessage = (event) => {
    state = JSON.parse(event.data);
    render();
    if (state.lastResult?.id && state.lastResult.id !== lastResultId) {
      lastResultId = state.lastResult.id;
      showResult(state.lastResult);
    }
  };
}

function teamName(id) {
  return state?.teams.find((team) => team.id === id)?.name || "None";
}

function myTeam() {
  return state?.teams.find((team) => team.id === teamId);
}

function render() {
  if (!state) return;
  $("setup").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("roomPill").textContent = `Room ${state.code}`;
  const isHost = Boolean(hostToken && hostRoom === state.code);
  $("hostPanel").classList.toggle("hidden", !isHost);
  $("skipBtn").classList.toggle("hidden", !isHost);
  $("pauseBtn").classList.toggle("hidden", !isHost || !["live", "paused"].includes(state.status));
  $("startBtn").classList.toggle("hidden", !isHost || state.status !== "lobby");
  $("shareLink").value = `${location.origin}${location.pathname}?room=${state.code}`;

  const p = state.active;
  $("activeSet").textContent = p ? p.set : state.status;
  $("activeName").textContent = p ? p.name : state.players.length ? "Auction complete" : "Upload players to begin";
  $("activeRole").textContent = p ? p.role : "No active player";
  $("activeBase").textContent = p ? `Base ${fmtMoney(p.basePrice)}` : "Base 0";
  $("currentBid").textContent = fmtMoney(state.currentBid);
  $("highestBidder").textContent = teamName(state.highestBidder);
  $("message").textContent = state.message || "";

  const mine = myTeam();
  const canBid = state.status === "live" && p && mine && state.highestBidder !== teamId;
  $("bidBtn").disabled = !canBid;
  $("skipBtn").disabled = !p || !["live", "paused"].includes(state.status);
  $("pauseBtn").disabled = !p;
  $("pauseBtn").textContent = state.status === "paused" ? "Resume Auction" : "Pause Auction";
  $("startBtn").disabled = !state.players.length;
  $("bidBtn").textContent = mine ? `Bid as ${mine.name}` : "Join to Bid";

  $("leaderboardTitle").textContent = state.status === "finished" ? "Final Leaderboard" : "Teams";
  $("leaderboard").innerHTML = [...state.teams]
    .sort((a, b) => state.status === "finished" ? b.points - a.points || a.spent - b.spent : a.name.localeCompare(b.name))
    .map((team, index) => `
      <div class="row">
        <span class="badge">${state.status === "finished" ? index + 1 : team.players}</span>
        <div><strong>${team.name}</strong><br><small>${team.players} players - ${fmtMoney(team.remaining)} left</small></div>
        <strong>${state.status === "finished" ? `${fmt(team.points)} pts` : fmtMoney(team.spent)}</strong>
      </div>
    `).join("") || `<p class="hint">Waiting for teams to join.</p>`;

  $("queue").innerHTML = state.players.map((player, index) => `
    <div class="row">
      <span class="badge">${index + 1}</span>
      <div><strong>${player.name}</strong><br><small>${player.set} - ${player.role} - ${fmtMoney(player.basePrice)}</small></div>
      <span class="status">${player.status}${player.soldTo ? `: ${teamName(player.soldTo)}` : ""}</span>
    </div>
  `).join("") || `<p class="hint">Upload an Excel or CSV player list.</p>`;

  $("playersList").innerHTML = state.players.map((player, index) => `
    <div class="row">
      <span class="badge">${index + 1}</span>
      <div><strong>${player.name}</strong><br><small>${player.set} - ${player.role} - base ${fmtMoney(player.basePrice)}</small></div>
      <span class="status">${state.status === "finished" ? `${fmt(player.points)} pts` : player.status}</span>
    </div>
  `).join("") || `<p class="hint">Upload an Excel or CSV player list.</p>`;
}

function showResult(result) {
  playResultSound(result.type);
  $("resultType").textContent = result.type === "sold" ? "Sold" : "Unsold";
  $("resultTitle").textContent = result.player;
  $("resultBody").textContent = result.type === "sold"
    ? `Sold to ${result.team} for ${fmtMoney(result.amount)}.`
    : "Unsold. No team bought this player.";
  $("resultModal").classList.remove("hidden");
}

function tick() {
  if (state?.status === "paused") {
    $("timer").textContent = "Paused";
    return;
  }
  if (!state?.timerEndsAt) {
    $("timer").textContent = "--";
    return;
  }
  $("timer").textContent = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
}

$("hostForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  unlockSound();
  const form = new FormData(event.currentTarget);
  const room = await api("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ budget: form.get("budget"), bidStep: form.get("bidStep") })
  });
  hostToken = room.hostToken;
  hostRoom = room.code;
  localStorage.setItem("iplHostToken", hostToken);
  localStorage.setItem("iplHostRoom", hostRoom);
  connect(room.code);
});

$("joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  unlockSound();
  const form = new FormData(event.currentTarget);
  const code = String(form.get("code")).toUpperCase();
  const data = await api(`/api/rooms/${code}/join`, {
    method: "POST",
    body: JSON.stringify({ teamName: form.get("teamName") })
  });
  teamId = data.teamId;
  teamRoom = code;
  localStorage.setItem("iplTeamId", teamId);
  localStorage.setItem("iplTeamRoom", teamRoom);
  connect(code);
});

$("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !state) return;
  const res = await fetch(`/api/rooms/${state.code}/players`, {
    method: "POST",
    headers: {
      "x-host-token": hostToken,
      "x-file-name": file.name
    },
    body: await file.arrayBuffer()
  });
  const data = await res.json();
  if (!res.ok) alert(data.error || "Upload failed.");
});

$("startBtn").addEventListener("click", () => {
  unlockSound();
  api(`/api/rooms/${state.code}/start`, { method: "POST", body: "{}" }).catch((e) => alert(e.message));
});

$("skipBtn").addEventListener("click", () => {
  unlockSound();
  api(`/api/rooms/${state.code}/skip`, { method: "POST", body: "{}" }).catch((e) => alert(e.message));
});

$("pauseBtn").addEventListener("click", () => {
  unlockSound();
  const action = state.status === "paused" ? "resume" : "pause";
  api(`/api/rooms/${state.code}/${action}`, { method: "POST", body: "{}" }).catch((e) => alert(e.message));
});

$("bidBtn").addEventListener("click", () => {
  unlockSound();
  api(`/api/rooms/${state.code}/bid`, {
    method: "POST",
    body: JSON.stringify({ teamId })
  }).catch((e) => alert(e.message));
});

$("copyLink").addEventListener("click", () => navigator.clipboard.writeText($("shareLink").value));
$("playersBtn").addEventListener("click", () => {
  $("playersPanel").classList.toggle("hidden");
  $("playersBtn").textContent = $("playersPanel").classList.contains("hidden") ? "Show Players List" : "Hide Players List";
});
$("closeResult").addEventListener("click", () => $("resultModal").classList.add("hidden"));

setInterval(tick, 250);
if (roomCode) {
  $("joinForm").elements.code.value = roomCode;
  if (hostRoom === roomCode || teamRoom === roomCode) connect(roomCode);
}
