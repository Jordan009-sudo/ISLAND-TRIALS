const config = window.ISLAND_TRIALS_SUPABASE;
const form = document.querySelector("#lobby-auth-form");
const authMessage = document.querySelector("#lobby-auth-message");
const lobbyHome = document.querySelector("#lobby-home");
const accountPanel = document.querySelector("#lobby-account");
const roomPanel = document.querySelector("#room-panel");
const rosterElement = document.querySelector("#lobby-roster");
const roomMessage = document.querySelector("#room-message");
const homeMessage = document.querySelector("#lobby-home-message");
const BOT_NAMES = ["Maya", "Theo", "Nia", "Jasper", "Sofia", "Malik", "Ivy", "Rafael", "Zoe", "Andre", "Lena", "Kai", "Parker"];

let client = null;
let user = null;
let channel = null;
let roomCode = null;
let hostId = null;
let bots = [];
let humans = [];
let roomStarted = false;
let playerId = null;
let inviteRoom = new URLSearchParams(location.search).get("room") || location.pathname.match(/^\/game\/(\d+)\/?$/)?.[1] || sessionStorage.getItem("island-trials-pending-room") || "";
if (inviteRoom) sessionStorage.removeItem("island-trials-pending-room");

function playerName(account) {
  return account.user_metadata?.display_name || account.user_metadata?.username || account.email?.split("@")[0] || "Player";
}

function showAccountState() {
  const signedIn = Boolean(user);
  document.querySelector("#lobby-auth").hidden = signedIn;
  accountPanel.hidden = !signedIn;
  lobbyHome.hidden = Boolean(channel);
  document.querySelector("#lobby-player-name").textContent = playerName(user || {});
  document.querySelector("#lobby-username").value = signedIn ? playerName(user) : "";
}

function showMessage(text) {
  roomMessage.textContent = text;
}

function getPlayerId() {
  if (user) return user.id;
  if (!playerId) {
    playerId = sessionStorage.getItem("island-trials-guest-id") || crypto.randomUUID();
    sessionStorage.setItem("island-trials-guest-id", playerId);
  }
  return playerId;
}

function getDisplayName() {
  return user ? playerName(user) : `Guest-${getPlayerId().slice(0, 4).toUpperCase()}`;
}

function getRoomPlayers() {
  if (!channel) return [];
  const state = channel.presenceState();
  const seen = new Set();
  return Object.values(state).flatMap((entries) => entries)
    .filter((entry) => {
      if (!entry.player_id || seen.has(entry.player_id)) return false;
      seen.add(entry.player_id);
      return true;
    })
    .map((entry) => ({ id: entry.player_id, name: entry.name, isGuest: entry.is_guest, isHost: entry.player_id === hostId }));
}

function broadcastRoomState() {
  if (!channel || getPlayerId() !== hostId) return;
  channel.send({
    type: "broadcast",
    event: "room-state",
    payload: { roomCode, hostId, bots, started: roomStarted },
  });
}

function renderRoster() {
  const players = getRoomPlayers();
  humans = players;
  const total = players.length + bots.length;
  document.querySelector("#room-count").textContent = `${total} / 14`;
  rosterElement.replaceChildren();
  players.forEach((player, index) => {
    const item = document.createElement("li");
    item.className = "lobby-roster-player";
    const team = index % 2 === 0 ? "SUN" : "TIDE";
    item.innerHTML = `<span class="castaway-dot">•</span><span class="castaway-name"></span><span class="lobby-seat-tag">${team}</span>`;
    item.querySelector(".castaway-name").textContent = player.name;
    if (player.isHost) item.append(Object.assign(document.createElement("span"), { className: "lobby-host-tag", textContent: "HOST" }));
    rosterElement.append(item);
  });
  bots.forEach((bot, index) => {
    const item = document.createElement("li");
    item.className = "lobby-roster-player lobby-roster-bot";
    const label = document.createElement("span");
    label.className = "castaway-name";
    label.textContent = bot.name;
    item.append(Object.assign(document.createElement("span"), { className: "castaway-dot", textContent: "•" }), label);
    item.append(Object.assign(document.createElement("span"), { className: "lobby-seat-tag", textContent: index % 2 === 0 ? "SUN" : "TIDE" }));
    rosterElement.append(item);
  });
  const isHost = user?.id === hostId;
  document.querySelector("#start-with-players").hidden = !isHost;
  document.querySelector("#fill-with-bots").hidden = !isHost;
  document.querySelector("#start-with-players").disabled = players.length < 2 || total > 14 || roomStarted;
  document.querySelector("#fill-with-bots").disabled = total >= 14 || roomStarted;
  document.querySelector("#leave-room").hidden = isHost;
  if (roomStarted) showMessage("This room has already started.");
  else if (players.length < 2) showMessage("Waiting for at least one more player to join.");
  else showMessage(isHost ? "Wait for players, start with the people here, or fill the seats with bots." : "You’re in. Waiting for the host to start the season.");
}

async function enterRoom(code, create = false) {
  if (!client || (create && !user)) return;
  if (channel) await leaveRoom(false);
  roomCode = String(code);
  playerId = getPlayerId();
  if (create) {
    hostId = user.id;
  } else {
    const { data, error } = await client.from("game_rooms").select("id, host_id, status").eq("id", Number(roomCode)).maybeSingle();
    if (error || !data || data.status !== "waiting") {
      showAccountState();
      homeMessage.textContent = error?.message || "That room was not found or has already started.";
      return;
    }
    hostId = data.host_id;
  }
  bots = [];
  roomStarted = false;
  roomPanel.hidden = false;
  lobbyHome.hidden = true;
  showMessage("Connecting to room…");

  channel = client.channel(`island-room:${roomCode}`, {
    config: { presence: { key: playerId }, broadcast: { ack: true } },
  });
  channel
    .on("presence", { event: "sync" }, () => {
      renderRoster();
      if (playerId === hostId) broadcastRoomState();
    })
    .on("broadcast", { event: "room-state" }, ({ payload }) => {
      if (playerId === hostId || payload.roomCode !== roomCode) return;
      hostId = payload.hostId;
      bots = payload.bots || [];
      roomStarted = Boolean(payload.started);
      renderRoster();
    })
    .on("broadcast", { event: "room-request" }, ({ payload }) => {
      if (playerId === hostId && payload.action === "state") broadcastRoomState();
    })
    .on("broadcast", { event: "game-start" }, ({ payload }) => {
      if (payload.roomCode === roomCode) loadRoomGame(payload.gameConfig?.hostId);
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ player_id: playerId, name: getDisplayName(), is_guest: !user });
        if (!create) channel.send({ type: "broadcast", event: "room-request", payload: { action: "state" } });
        renderRoster();
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") showMessage("Could not connect. Check Realtime is enabled for this Supabase project.");
    });
}

async function loadRoomGame(expectedHostId) {
  const { data, error } = await client
    .from("game_rooms")
    .select("host_id, status, game_config")
    .eq("id", Number(roomCode))
    .maybeSingle();
  if (error || !data || data.status !== "started" || data.host_id !== expectedHostId || !data.game_config) {
    showMessage(error?.message || "The host has not published this game's roster yet.");
    return;
  }
  startGame(data.game_config);
}

function startGame(gameConfig) {
  if (roomStarted && !gameConfig) return;
  roomStarted = true;
  const sharedConfig = gameConfig || {
    roomCode,
    hostId,
    humans: getRoomPlayers(),
    bots,
  };
  const sessionConfig = {
    ...sharedConfig,
    localUserId: playerId,
    isGuest: !user,
    participants: (sharedConfig.participants || []).map((participant, index) => ({
      ...participant,
      threat: participant.threat ?? 2 + ((index * 3 + 1) % 8),
      social: participant.social ?? 3 + ((index * 5 + 2) % 7),
      points: participant.points ?? 0,
    })),
  };
  try {
    sessionStorage.setItem("island-trials-room", JSON.stringify(sessionConfig));
  } catch {
    showMessage("This browser blocked room storage. Allow site storage and try again.");
    return;
  }
  location.href = `/game/${encodeURIComponent(sessionConfig.roomCode)}`;
}

async function leaveRoom(showHome = true) {
  if (channel) await client.removeChannel(channel);
  channel = null;
  roomCode = null;
  hostId = null;
  bots = [];
  roomStarted = false;
  roomPanel.hidden = true;
  if (showHome) {
    lobbyHome.hidden = false;
    renderRoster();
  }
}

async function beginRoomGame(fillBots = false) {
  if (user?.id !== hostId || humans.length < 1 || (!fillBots && humans.length < 2) || humans.length + bots.length > 14) return;
  if (fillBots) {
    const takenNames = new Set([...humans.map((human) => human.name), ...bots.map((bot) => bot.name)]);
    while (humans.length + bots.length < 14) {
      const name = BOT_NAMES.find((candidate) => !takenNames.has(candidate)) || `Island Bot ${bots.length + 1}`;
      bots.push({ id: `bot-${crypto.randomUUID()}`, name, isBot: true });
      takenNames.add(name);
    }
    renderRoster();
  }
  const allPlayers = [
    ...humans.map((player) => ({ ...player, isBot: false })),
    ...bots.map((bot) => ({ ...bot, isBot: true })),
  ].map((player, index) => ({ ...player, tribeId: index % 2 === 0 ? "sun" : "tide" }));
  const gameConfig = { roomCode, hostId, humans, participants: allPlayers, bots, pointsPerFruit: 10, startedAt: Date.now() };
  roomStarted = true;
  const { error } = await client.from("game_rooms")
    .update({ status: "started", game_config: gameConfig })
    .eq("id", Number(roomCode));
  if (error) {
    roomStarted = false;
    showMessage(`Room start failed: ${error.message}`);
    renderRoster();
    return;
  }
  broadcastRoomState();
  const result = await channel.send({ type: "broadcast", event: "game-start", payload: { roomCode, gameConfig } });
  if (result !== "ok") {
    roomStarted = false;
    showMessage("Could not start the room. Check the Realtime connection and try again.");
    renderRoster();
    return;
  }
  startGame(gameConfig);
}

async function initialize() {
  if (!window.supabase?.createClient || !config?.url || !config?.key || config.url.includes("YOUR_PROJECT_REF") || config.key.includes("YOUR_SUPABASE")) {
    form.hidden = true;
    lobbyHome.hidden = false;
    document.querySelector("#join-room-form button[type=submit]").disabled = true;
    authMessage.textContent = "Configure Supabase in supabase-config.js before creating an online room.";
    return;
  }
  client = window.supabase.createClient(config.url, config.key);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    authMessage.textContent = "Signing in…";
    const { error } = await client.auth.signInWithPassword({
      email: document.querySelector("#lobby-email").value.trim(),
      password: document.querySelector("#lobby-password").value,
    });
    if (error) authMessage.textContent = error.message;
  });
  document.querySelector("#lobby-signup").addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    const username = document.querySelector("#lobby-signup-name").value.trim();
    if (username.length < 2 || username.length > 16) {
      authMessage.textContent = "Choose a username between 2 and 16 characters.";
      return;
    }
    authMessage.textContent = "Creating account…";
    const { error } = await client.auth.signUp({
      email: document.querySelector("#lobby-email").value.trim(),
      password: document.querySelector("#lobby-password").value,
      options: { data: { display_name: username } },
    });
    authMessage.textContent = error ? error.message : "Account created. Confirm your email, then sign in here.";
  });
  document.querySelector("#save-username").addEventListener("click", async () => {
    const username = document.querySelector("#lobby-username").value.trim();
    if (username.length < 2 || username.length > 16) {
      document.querySelector("#lobby-auth-message").textContent = "Choose a username between 2 and 16 characters.";
      return;
    }
    document.querySelector("#lobby-auth-message").textContent = "Saving username…";
    const { data, error } = await client.auth.updateUser({ data: { display_name: username } });
    if (error) {
      document.querySelector("#lobby-auth-message").textContent = error.message;
      return;
    }
    user = data.user;
    showAccountState();
    if (channel) await channel.track({ player_id: getPlayerId(), name: playerName(user), is_guest: false });
    document.querySelector("#lobby-auth-message").textContent = "Username saved.";
  });
  document.querySelector("#lobby-signout").addEventListener("click", async () => client.auth.signOut());
  async function createRoom() {
    if (!user) return;
    homeMessage.textContent = "Creating room…";
    const { data, error } = await client.from("game_rooms").insert({ host_id: user.id }).select("id").single();
    if (error) {
      homeMessage.textContent = `Room creation failed: ${error.message}`;
      return;
    }
    await enterRoom(String(data.id), true);
  }
  async function joinNextGame() {
    homeMessage.textContent = "Finding an open room…";
    const { data, error } = await client.from("game_rooms")
      .select("id")
      .eq("status", "waiting")
      .order("id", { ascending: true })
      .limit(1);
    if (error) {
      homeMessage.textContent = `Could not find an open game: ${error.message}`;
      return;
    }
    if (data?.length) {
      await enterRoom(String(data[0].id));
      return;
    }
    if (!user) {
      homeMessage.textContent = "No game is open. Sign in to start the next one.";
      return;
    }
    await createRoom();
  }
  document.querySelector("#join-room-form").addEventListener("submit", (event) => {
    event.preventDefault();
    joinNextGame();
  });
  document.querySelector("#start-with-players").addEventListener("click", () => beginRoomGame(false));
  document.querySelector("#fill-with-bots").addEventListener("click", () => beginRoomGame(true));
  document.querySelector("#leave-room").addEventListener("click", () => leaveRoom());
  document.querySelector("#copy-room-link").addEventListener("click", async () => {
    const url = new URL(`/game/${roomCode}`, location.origin);
    await navigator.clipboard.writeText(url.href);
    showMessage("Invite link copied. Anyone with the link can join.");
  });
  client.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      user = session?.user || null;
      showAccountState();
      if (user && channel) await channel.track({ player_id: getPlayerId(), name: playerName(user), is_guest: false });
      if (!user && channel) await leaveRoom();
      if (inviteRoom && !channel) {
        await enterRoom(inviteRoom);
        inviteRoom = "";
      }
    }, 0);
  });
  const { data, error } = await client.auth.getSession();
  if (error) authMessage.textContent = error.message;
  user = data.session?.user || null;
  showAccountState();
  if (inviteRoom) {
    await enterRoom(inviteRoom);
    inviteRoom = "";
  }
}

initialize();
