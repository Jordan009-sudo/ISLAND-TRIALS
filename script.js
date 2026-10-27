const SIZE = 8;
const CHALLENGE_SECONDS = 60;
const DAY_SECONDS = 300;
const requestedRoomId = location.pathname.match(/^\/game\/(\d+)\/?$/)?.[1];
const soloRequested = new URLSearchParams(location.search).get("solo") === "1";
if (requestedRoomId) {
  let routeRoom = null;
  try {
    routeRoom = JSON.parse(sessionStorage.getItem("island-trials-room") || "null");
  } catch {
    routeRoom = null;
  }
    if (String(routeRoom?.roomCode) !== requestedRoomId) {
      sessionStorage.setItem("island-trials-pending-room", requestedRoomId);
      location.replace(`/Lobby.html?room=${requestedRoomId}`);
    }
}
const PIECES = [
  { name: "strawberry", icon: "🤍", color: "berry" },
  { name: "lemon", icon: "🍋", color: "lemon" },
  { name: "grapes", icon: "🍇", color: "grape" },
  { name: "orange", icon: "🍊", color: "orange" },
  { name: "blueberry", icon: "🫐", color: "blueberry" },
  { name: "kiwi", icon: "🥝", color: "kiwi" },
];

const boardElement = document.querySelector("#game-board");
const scoreElement = document.querySelector("#score");
const timeElement = document.querySelector("#time-left");
const dayTimeElement = document.querySelector("#day-time-left");
const movesElement = document.querySelector("#moves");
const messageElement = document.querySelector("#game-message");
const seasonDayElement = document.querySelector("#season-day");
const phaseLabelElement = document.querySelector("#phase-label");
const tribeRosterElement = document.querySelector("#tribe-roster");
const seasonLogElement = document.querySelector("#season-log");
const tribalPanelElement = document.querySelector("#tribal-panel");
const voteOptionsElement = document.querySelector("#vote-options");
const juryPanelElement = document.querySelector("#jury-panel");
const juryOptionsElement = document.querySelector("#jury-options");
const finalePanelElement = document.querySelector("#finale-panel");
const endDayButton = document.querySelector("#end-day");
const newSeasonButton = document.querySelector("#new-season");
const saveNowButton = document.querySelector("#save-now");
const saveStatusElement = document.querySelector("#save-status");

const SAVE_KEY = "island-trials-season-save";
const SAVE_VERSION = 3;
const CLOUD_SAVE_INTERVAL = 10000;
let roomConfig = null;
try {
  roomConfig = JSON.parse(sessionStorage.getItem("island-trials-room") || "null");
} catch {
  roomConfig = null;
}
const isMultiplayer = Boolean(roomConfig?.roomCode && roomConfig?.participants?.length >= 2);
let board = [];
let selected = null;
let score = 0;
let moves = 0;
let secondsLeft = CHALLENGE_SECONDS;
let daySecondsLeft = DAY_SECONDS;
let pointsPerFruit = 10;
let locked = false;
let ended = false;
let matchedCells = new Set();
let pointerStart = null;
let pointerMoved = false;
let ignorePointerClickUntil = 0;
let contestants = [];
let jurors = [];
let events = [];
let day = 1;
let phase = "challenge";
let dayStartedAt = Date.now();
let merged = false;
let playerImmune = false;
let tribeSupport = {};
let botImmunityWinner = null;
let pendingCouncil = null;
let juryTally = null;
let seasonWinnerId = null;
let supabaseClient = null;
let currentUser = null;
let cloudSaveTimer = null;
let queuedCloudSave = null;
let lastCloudSaveAt = 0;
let accountLoadToken = 0;
let accountLoading = false;
let roomChannel = null;
let roomChallengeScores = {};
let roomChallengeMoves = {};
let roomVotes = {};
let roomCouncilTimer = null;
let roomCouncilResolving = false;
let localPlayerEliminated = false;

const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
const randomPiece = () => Math.floor(Math.random() * PIECES.length);
const indexOf = (row, column) => row * SIZE + column;

function storageKeyForUser(user = currentUser) {
  return user ? `${SAVE_KEY}:${user.id}` : SAVE_KEY;
}

function queueCloudSave(saveData, immediate = false) {
  if (!currentUser || !supabaseClient) return;
  queuedCloudSave = saveData;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  const waitMs = immediate ? 0 : Math.max(0, CLOUD_SAVE_INTERVAL - (Date.now() - lastCloudSaveAt));
  cloudSaveTimer = setTimeout(flushCloudSave, waitMs);
}

async function flushCloudSave() {
  cloudSaveTimer = null;
  if (!currentUser || !supabaseClient || !queuedCloudSave) return;
  const userId = currentUser.id;
  const saveData = queuedCloudSave;
  queuedCloudSave = null;
  lastCloudSaveAt = Date.now();
  saveStatusElement.textContent = "SYNCING";
  const { error } = await supabaseClient.from("season_saves").upsert({
    user_id: userId,
    save_data: saveData,
    updated_at: new Date().toISOString(),
  });
  if (currentUser?.id === userId) {
    saveStatusElement.textContent = error ? "CLOUD SAVE FAILED" : "CLOUD SAVED";
    if (error) {
      const details = [error.code, error.message].filter(Boolean).join(": ");
      document.querySelector("#account-message").textContent = `Cloud save failed${details ? ` (${details})` : "."}`;
    }
  }
  if (queuedCloudSave) queueCloudSave(queuedCloudSave);
}

function saveGame(immediate = false) {
  if (!contestants.length || accountLoading || isMultiplayer) return;
  const saveData = {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    board,
    selected,
    score,
    moves,
    secondsLeft,
    daySecondsLeft,
    pointsPerFruit,
    ended,
    matchedCells: [...matchedCells],
    contestants,
    jurors,
    events,
    day,
    dayStartedAt,
    phase,
    merged,
    playerImmune,
    tribeSupport,
    botImmunityWinner,
    pendingCouncil,
    juryTally: juryTally ? [...juryTally.entries()] : null,
    seasonWinnerId,
    message: messageElement.textContent,
  };
  try {
    localStorage.setItem(storageKeyForUser(), JSON.stringify(saveData));
    saveStatusElement.textContent = currentUser ? "LOCAL SAVED" : "SAVED";
  } catch {
    saveStatusElement.textContent = "SAVE FAILED";
  }
  if (currentUser && !isMultiplayer) queueCloudSave(saveData, immediate);
}

function isRoomHost() {
  return isMultiplayer && roomConfig.localUserId === roomConfig.hostId;
}

function sendRoomEvent(event, payload) {
  if (!roomChannel) return;
  roomChannel.send({ type: "broadcast", event, payload: { roomCode: roomConfig.roomCode, ...payload } });
}

function broadcastRoomState(event = "season-state") {
  if (!isRoomHost()) return;
  sendRoomEvent(event, {
    contestants,
    jurors,
    events,
    day,
    dayStartedAt,
    phase,
    merged,
    playerImmune,
    tribeSupport,
    botImmunityWinner,
    pendingCouncil,
    juryTally: juryTally ? [...juryTally.entries()] : null,
    seasonWinnerId,
    roomChallengeScores,
    roomChallengeMoves,
    roomVotes,
    secondsLeft,
    daySecondsLeft,
    savedAt: Date.now(),
    message: messageElement.textContent,
  });
}

function applyRoomState(state) {
  if (!isMultiplayer || isRoomHost() || !state?.contestants) return;
  const away = Math.max(0, Math.floor((Date.now() - state.savedAt) / 1000));
  const isNewDay = state.day !== day;
  contestants = state.contestants;
  jurors = state.jurors || [];
  events = state.events || [];
  day = state.day;
  dayStartedAt = state.dayStartedAt || Date.now();
  if (isNewDay) {
    board = createPlayableBoard();
    selected = null;
    matchedCells = new Set();
  }
  phase = state.phase;
  merged = Boolean(state.merged);
  playerImmune = Boolean(state.playerImmune);
  tribeSupport = state.tribeSupport || {};
  botImmunityWinner = state.botImmunityWinner || null;
  pendingCouncil = state.pendingCouncil || null;
  juryTally = state.juryTally ? new Map(state.juryTally) : null;
  seasonWinnerId = state.seasonWinnerId || null;
  roomChallengeScores = state.roomChallengeScores || {};
  roomChallengeMoves = state.roomChallengeMoves || {};
  score = roomChallengeScores[getPlayer()?.id] || 0;
  moves = roomChallengeMoves[getPlayer()?.id] || 0;
  roomVotes = state.roomVotes || {};
  daySecondsLeft = Math.max(0, state.daySecondsLeft - (["challenge", "day"].includes(phase) ? away : 0));
  secondsLeft = Math.max(0, state.secondsLeft - (phase === "challenge" ? away : 0));
  localPlayerEliminated = !getPlayer()?.alive;
  ended = phase !== "challenge";
  locked = ended || localPlayerEliminated;
  messageElement.textContent = state.message || "Season state updated.";
  document.querySelector("#player-name").value = getPlayer()?.name || "Guest";
  tribalPanelElement.hidden = !pendingCouncil?.voterIds.includes(getPlayer()?.id);
  juryPanelElement.hidden = phase !== "jury" || !jurors.includes(getPlayer()?.id);
  finalePanelElement.hidden = phase !== "finale";
  if (pendingCouncil?.voterIds.includes(getPlayer()?.id)) {
    document.querySelector("#tribal-prompt").textContent = "Your vote is private. Choose a castaway.";
    renderVoteOptions(pendingCouncil.candidateIds);
  }
  if (phase === "jury" && juryTally && jurors.includes(getPlayer()?.id)) renderJuryOptions(getAlive());
  if (phase === "finale" && seasonWinnerId && juryTally) {
    document.querySelector("#winner-name").textContent = `${getContestant(seasonWinnerId)?.name || "A finalist"} wins!`;
    document.querySelector("#jury-result").textContent = [...juryTally.entries()]
      .map(([id, count]) => `${getContestant(id)?.name || "Castaway"}: ${count}`)
      .join(" · ");
  }
  render();
}

function initializeRoomGame() {
  if (!isMultiplayer || !window.supabase?.createClient) return;
  const config = window.ISLAND_TRIALS_SUPABASE;
  if (!config?.url || !config?.key || config.url.includes("YOUR_PROJECT_REF") || config.key.includes("YOUR_SUPABASE")) return;
  if (!supabaseClient) supabaseClient = window.supabase.createClient(config.url, config.key);
  roomChannel = supabaseClient.channel(`island-room:${roomConfig.roomCode}`, {
    config: { presence: { key: roomConfig.localUserId }, broadcast: { ack: true } },
  });
  roomChannel
    .on("broadcast", { event: "challenge-start" }, ({ payload }) => {
      if (payload.roomCode === roomConfig.roomCode && !isRoomHost()) startChallenge(true, payload.startedAt);
    })
    .on("broadcast", { event: "challenge-score" }, ({ payload }) => {
      if (payload.roomCode !== roomConfig.roomCode) return;
      roomChallengeScores[payload.playerId] = payload.score;
      roomChallengeMoves[payload.playerId] = payload.moves || 0;
      renderStats();
      if (isRoomHost()) broadcastRoomState("scoreboard");
    })
    .on("broadcast", { event: "player-vote" }, ({ payload }) => {
      if (payload.roomCode !== roomConfig.roomCode) return;
      roomVotes[payload.voterId] = payload.targetId;
      if (isRoomHost()) resolveRoomCouncilIfReady();
    })
    .on("broadcast", { event: "jury-vote" }, ({ payload }) => {
      if (payload.roomCode !== roomConfig.roomCode) return;
      roomVotes[payload.voterId] = payload.targetId;
      if (isRoomHost()) resolveRoomJuryIfReady();
    })
    .on("broadcast", { event: "room-request" }, ({ payload }) => {
      if (isRoomHost() && payload.roomCode === roomConfig.roomCode) broadcastRoomState();
    })
    .on("broadcast", { event: "season-state" }, ({ payload }) => {
      if (payload.roomCode === roomConfig.roomCode) applyRoomState(payload);
    })
    .on("broadcast", { event: "scoreboard" }, ({ payload }) => {
      if (payload.roomCode === roomConfig.roomCode) applyRoomState(payload);
    })
    .subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      await roomChannel.track({ player_id: roomConfig.localUserId, name: getPlayer()?.name || "Player" });
      if (isRoomHost()) broadcastRoomState();
      else sendRoomEvent("room-request", { action: "state" });
    });
}

function createBoard() {
  const nextBoard = [];
  for (let row = 0; row < SIZE; row++) {
    const nextRow = [];
    for (let column = 0; column < SIZE; column++) {
      let piece;
      do {
        piece = randomPiece();
      } while (
        (column >= 2 && piece === nextRow[column - 1] && piece === nextRow[column - 2]) ||
        (row >= 2 && piece === nextBoard[row - 1][column] && piece === nextBoard[row - 2][column])
      );
      nextRow.push(piece);
    }
    nextBoard.push(nextRow);
  }
  return nextBoard;
}

function findMatches(source) {
  const matches = new Set();
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const piece = source[row][column];
      let horizontal = 1;
      let vertical = 1;
      while (column + horizontal < SIZE && source[row][column + horizontal] === piece) horizontal++;
      while (row + vertical < SIZE && source[row + vertical][column] === piece) vertical++;
      if (horizontal >= 3) {
        for (let offset = 0; offset < horizontal; offset++) matches.add(indexOf(row, column + offset));
      }
      if (vertical >= 3) {
        for (let offset = 0; offset < vertical; offset++) matches.add(indexOf(row + offset, column));
      }
    }
  }
  return matches;
}

function hasPossibleMove(source) {
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      for (const [nextRow, nextColumn] of [[row, column + 1], [row + 1, column]]) {
        if (nextRow >= SIZE || nextColumn >= SIZE) continue;
        [source[row][column], source[nextRow][nextColumn]] = [source[nextRow][nextColumn], source[row][column]];
        const foundMatch = findMatches(source).size > 0;
        [source[row][column], source[nextRow][nextColumn]] = [source[nextRow][nextColumn], source[row][column]];
        if (foundMatch) return true;
      }
    }
  }
  return false;
}

function createPlayableBoard() {
  let nextBoard;
  do {
    nextBoard = createBoard();
  } while (!hasPossibleMove(nextBoard));
  return nextBoard;
}

const NPC_NAMES = ["Maya", "Theo", "Nia", "Jasper", "Sofia", "Malik", "Ivy", "Rafael", "Zoe", "Andre", "Lena", "Kai", "Parker"];
const TRIBES = [
  { id: "sun", name: "Sun", color: "sun" },
  { id: "tide", name: "Tide", color: "tide" },
];

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function getAlive() {
  return contestants.filter((contestant) => contestant.alive);
}

function getContestant(id) {
  return contestants.find((contestant) => contestant.id === id);
}

function getTribe(id) {
  return TRIBES.find((tribe) => tribe.id === id);
}

function getPlayer() {
  return getContestant(roomConfig?.localUserId || "player");
}

function isLocalPlayer(contestantOrId) {
  const id = typeof contestantOrId === "string" ? contestantOrId : contestantOrId?.id;
  return id === (roomConfig?.localUserId || "player");
}

function isHuman(contestant) {
  return Boolean(contestant && (isMultiplayer ? !contestant.isBot : contestant.id === "player"));
}

function addEvent(text) {
  events.unshift(text);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderRoster() {
  tribeRosterElement.replaceChildren();
  const groups = merged
    ? [{ id: "merged", name: "MERGED TRIBE", color: "merged", members: getAlive() }]
    : TRIBES.map((tribe) => ({
        ...tribe,
        members: getAlive().filter((contestant) => contestant.tribeId === tribe.id),
      }));

  groups.forEach((group) => {
    const section = makeElement("section", `tribe-list tribe-list--${group.color}`);
    const heading = makeElement("div", "tribe-list-heading");
    heading.append(makeElement("strong", "", group.name));
    heading.append(makeElement("span", "", `${group.members.length} LEFT`));
    const list = makeElement("ul", "castaway-list");
    group.members.forEach((contestant) => {
      const item = makeElement("li", isLocalPlayer(contestant) ? "is-player" : "");
      item.append(makeElement("span", "castaway-dot", "•"));
      item.append(makeElement("span", "castaway-name", contestant.name));
      if (isLocalPlayer(contestant)) item.append(makeElement("span", "you-tag", "YOU"));
      else if (isHuman(contestant)) item.append(makeElement("span", "you-tag", "PLAYER"));
      else item.append(makeElement("span", "you-tag", "BOT"));
      if (merged && contestant.id === botImmunityWinner?.id) item.append(makeElement("span", "you-tag", "IMMUNE"));
      list.append(item);
    });
    section.append(heading, list);
    tribeRosterElement.append(section);
  });
}

function renderSeasonLog() {
  seasonLogElement.replaceChildren();
  events.slice(0, 8).forEach((event) => seasonLogElement.append(makeElement("li", "", event)));
}

function renderSeason() {
  const alive = getAlive();
  seasonDayElement.textContent = `DAY ${day} · ${alive.length} LEFT`;
  document.querySelector("#player-count").textContent = `${alive.length} LEFT`;
  phaseLabelElement.textContent = phase === "ready"
    ? pendingCouncil ? "TRIBAL VOTE + CHALLENGE" : "CHALLENGE READY"
    : phase === "challenge" && pendingCouncil
      ? "TRIBAL VOTE + CHALLENGE"
    : phase === "day"
      ? "DAY IN PROGRESS"
    : phase === "waiting"
      ? "WAITING FOR ROOM"
    : phase === "finale"
    ? "FINAL TRIBAL COUNCIL"
    : phase === "jury"
      ? "JURY VOTE"
    : phase === "tribal"
      ? "TRIBAL COUNCIL"
      : phase === "spectating"
        ? "THE SEASON CONTINUES"
        : merged
          ? "INDIVIDUAL IMMUNITY"
          : "TRIBE IMMUNITY";
  renderRoster();
  renderSeasonLog();
}

function renderBoard() {
  boardElement.replaceChildren();
  board.forEach((row, rowIndex) => {
    row.forEach((pieceIndex, columnIndex) => {
      const piece = PIECES[pieceIndex];
      const cellIndex = indexOf(rowIndex, columnIndex);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tile tile--${piece.color}`;
      if (selected && selected.row === rowIndex && selected.column === columnIndex) button.classList.add("is-selected");
      if (matchedCells.has(cellIndex)) button.classList.add("is-matched");
      button.dataset.row = rowIndex;
      button.dataset.column = columnIndex;
      button.setAttribute("aria-label", `${piece.name}, row ${rowIndex + 1}, column ${columnIndex + 1}`);
      button.textContent = piece.icon;
      button.disabled = phase !== "challenge" || locked || accountLoading;
      boardElement.append(button);
    });
  });
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderStats() {
  scoreElement.textContent = score;
  movesElement.textContent = moves;
  timeElement.textContent = formatTime(secondsLeft);
  timeElement.classList.toggle("is-urgent", secondsLeft <= 10);
  dayTimeElement.textContent = formatTime(daySecondsLeft);
  dayTimeElement.classList.toggle("is-urgent", daySecondsLeft <= 30);
  const player = getPlayer();
  const playerTribe = player && getTribe(player.tribeId);
  const otherTribe = TRIBES.find((tribe) => player && tribe.id !== player.tribeId);
  const roomTeamTotal = (tribeId) => contestants
    .filter((contestant) => contestant.alive && contestant.tribeId === tribeId)
    .reduce((total, contestant) => total + (roomChallengeScores[contestant.id] || 0), 0);
  document.querySelector("#your-tribe-name").textContent = merged ? "YOUR SCORE" : `${playerTribe?.name || "YOUR"} TRIBE`;
  document.querySelector("#other-tribe-name").textContent = merged ? "BEST BOT" : `${otherTribe?.name || "OTHER"} TRIBE`;
  document.querySelector("#your-tribe-score").textContent = isMultiplayer
    ? merged ? score : roomTeamTotal(player?.tribeId)
    : merged ? score : score + (tribeSupport[player?.tribeId] || 0);
  document.querySelector("#other-tribe-score").textContent = merged
    ? isMultiplayer ? botImmunityWinner?.score || 0 : botImmunityWinner?.score || 0
    : isMultiplayer ? roomTeamTotal(otherTribe?.id) : tribeSupport[otherTribe?.id] || 0;
  endDayButton.disabled = accountLoading || (phase !== "ready" && phase !== "challenge" && phase !== "spectating");
  if (isMultiplayer && !isRoomHost() && phase === "ready") endDayButton.disabled = true;
  endDayButton.textContent = phase === "ready"
    ? "Start challenge"
    : phase === "challenge"
      ? "End challenge"
      : phase === "day"
        ? "Day in progress"
      : phase === "waiting"
        ? "Waiting for host"
      : phase === "spectating"
        ? "Simulate to finale"
        : "Challenge complete";
}

function render() {
  renderBoard();
  renderStats();
  renderSeason();
  saveGame();
}

function swapPieces(first, second) {
  [board[first.row][first.column], board[second.row][second.column]] =
    [board[second.row][second.column], board[first.row][first.column]];
}

function collapseMatches(matches) {
  for (let column = 0; column < SIZE; column++) {
    const remaining = [];
    for (let row = SIZE - 1; row >= 0; row--) {
      if (!matches.has(indexOf(row, column))) remaining.push(board[row][column]);
    }
    while (remaining.length < SIZE) remaining.push(randomPiece());
    for (let row = SIZE - 1; row >= 0; row--) board[row][column] = remaining[SIZE - 1 - row];
  }
}

async function resolveMatches() {
  let matches = findMatches(board);
  let combo = 0;
  while (matches.size > 0 && !ended) {
    combo++;
    matchedCells = matches;
    renderBoard();
    await wait(210);
    if (ended) return;
    score += matches.size * pointsPerFruit * combo;
    if (isMultiplayer) {
      roomChallengeScores[getPlayer()?.id] = score;
      roomChallengeMoves[getPlayer()?.id] = moves;
      sendRoomEvent("challenge-score", { playerId: getPlayer()?.id, score, moves, day });
    }
    collapseMatches(matches);
    matchedCells = new Set();
    render();
    await wait(140);
    matches = findMatches(board);
  }
  if (!hasPossibleMove(board)) {
    board = createPlayableBoard();
    messageElement.textContent = "Fresh board. Keep the combos going!";
    renderBoard();
  }
  renderStats();
  locked = false;
  renderBoard();
}

async function chooseTile(row, column) {
  if (accountLoading || phase !== "challenge" || ended || locked) return;
  const current = { row, column };
  if (!selected) {
    selected = current;
    renderBoard();
    return;
  }
  if (selected.row === row && selected.column === column) {
    selected = null;
    renderBoard();
    return;
  }
  const isAdjacent = Math.abs(selected.row - row) + Math.abs(selected.column - column) === 1;
  if (!isAdjacent) {
    selected = current;
    renderBoard();
    return;
  }

  const previous = selected;
  selected = null;
  swapPieces(previous, current);
  const matches = findMatches(board);
  if (matches.size === 0) {
    swapPieces(previous, current);
    messageElement.textContent = "Those pieces need to make a match.";
    renderBoard();
    return;
  }

  moves++;
  messageElement.textContent = "Nice match!";
  locked = true;
  render();
  await resolveMatches();
}

function createCastaways() {
  if (isMultiplayer) {
    contestants = roomConfig.participants.map((participant) => ({
      ...participant,
      alive: true,
      originTribe: participant.tribeId,
      isBot: Boolean(participant.isBot),
    }));
    document.querySelector("#player-name").value = getPlayer()?.name || "Island guest";
    localPlayerEliminated = false;
    return;
  }
  const enteredName = document.querySelector("#player-name").value.trim();
  const playerName = enteredName || "You";
  contestants = [{
    id: "player",
    name: playerName,
    alive: true,
    tribeId: "sun",
    originTribe: "sun",
    threat: 4,
    social: 6,
    points: 0,
  }];
  NPC_NAMES.forEach((name, index) => {
    const tribeId = index < 6 ? "sun" : "tide";
    contestants.push({
      id: `bot-${index}`,
      name,
      alive: true,
      tribeId,
      originTribe: tribeId,
      threat: randomBetween(2, 9),
      social: randomBetween(2, 9),
      points: randomBetween(0, 40),
      isBot: true,
    });
  });
}

function startDay(broadcastState = true) {
  phase = "ready";
  score = 0;
  moves = 0;
  secondsLeft = CHALLENGE_SECONDS;
  daySecondsLeft = DAY_SECONDS;
  dayStartedAt = Date.now();
  locked = true;
  ended = true;
  selected = null;
  matchedCells = new Set();
  playerImmune = false;
  tribeSupport = {};
  botImmunityWinner = null;
  roomChallengeScores = {};
  roomChallengeMoves = {};
  roomVotes = {};
  roomCouncilResolving = false;
  if (roomCouncilTimer) clearTimeout(roomCouncilTimer);
  roomCouncilTimer = null;
  if (merged) {
    if (isMultiplayer) {
      getAlive().filter((contestant) => contestant.isBot).forEach((bot) => {
        roomChallengeScores[bot.id] = randomBetween(70, 240);
      });
      const topBot = getAlive()
        .filter((contestant) => contestant.isBot)
        .sort((a, b) => roomChallengeScores[b.id] - roomChallengeScores[a.id])[0];
      botImmunityWinner = topBot ? { id: topBot.id, name: topBot.name, score: roomChallengeScores[topBot.id] } : { id: null, name: "No bot", score: 0 };
    }
    getAlive().filter((contestant) => !contestant.isBot).forEach((human) => { roomChallengeScores[human.id] = 0; });
  }
  if (merged && !isMultiplayer) {
    const botScores = getAlive()
      .filter((contestant) => contestant.id !== "player")
      .map((contestant) => ({ id: contestant.id, name: contestant.name, score: randomBetween(70, 240) }));
    botImmunityWinner = botScores.sort((a, b) => b.score - a.score)[0] || { id: null, name: "No opponent", score: 0 };
  } else if (!merged && !isMultiplayer) {
    TRIBES.forEach((tribe) => {
      tribeSupport[tribe.id] = getAlive()
        .filter((contestant) => contestant.tribeId === tribe.id && contestant.id !== "player")
        .reduce((total) => total + randomBetween(20, 36), 0);
    });
  } else if (!merged && isMultiplayer) {
    getAlive().filter((contestant) => !contestant.isBot).forEach((human) => { roomChallengeScores[human.id] = 0; });
    TRIBES.forEach((tribe) => {
      const bots = getAlive().filter((contestant) => contestant.isBot && contestant.tribeId === tribe.id);
      bots.forEach((bot) => { roomChallengeScores[bot.id] = randomBetween(20, 36); });
    });
  }
  tribalPanelElement.hidden = true;
  juryPanelElement.hidden = true;
  finalePanelElement.hidden = true;
  board = createPlayableBoard();
  messageElement.textContent = "The five-minute day has started. Start your one-minute challenge when ready.";
  render();
  if (isMultiplayer && broadcastState && isRoomHost()) {
    broadcastRoomState("season-state");
    if (!getPlayer()?.alive) startChallenge();
  }
}

function startChallenge(remote = false, startedAt = Date.now()) {
  if (phase !== "ready") return;
  if (isMultiplayer && !remote && !isRoomHost()) return;
  phase = "challenge";
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  secondsLeft = Math.max(0, Math.min(CHALLENGE_SECONDS, daySecondsLeft) - elapsed);
  locked = localPlayerEliminated;
  ended = false;
  messageElement.textContent = merged
    ? "Win individual immunity before the minute runs out."
    : "Match fruit to add points to your tribe's immunity total.";
  render();
  if (isMultiplayer && !remote) sendRoomEvent("challenge-start", { day, startedAt });
}

function startSeason() {
  pointsPerFruit = isMultiplayer ? Number(roomConfig.pointsPerFruit) || 10 : Number(document.querySelector("#points-per-fruit").value) || 10;
  document.querySelector("#points-per-fruit").disabled = isMultiplayer;
  newSeasonButton.hidden = isMultiplayer;
  saveNowButton.hidden = isMultiplayer;
  document.querySelector("#room-code-badge").hidden = !isMultiplayer;
  document.querySelector("#room-code-badge").textContent = isMultiplayer ? `ROOM ${roomConfig.roomCode}` : "";
  createCastaways();
  jurors = [];
  events = ["Fourteen castaways arrive. The Sun and Tide tribes are set."];
  day = 1;
  merged = false;
  pendingCouncil = null;
  juryTally = null;
  seasonWinnerId = null;
  localPlayerEliminated = false;
  startDay();
}

function voteScore(voter, target) {
  return target.threat + randomBetween(0, 5) - voter.social * 0.12;
}

function botVote(voterId, candidateIds) {
  const voter = getContestant(voterId);
  return candidateIds
    .map((id) => getContestant(id))
    .filter(Boolean)
    .sort((a, b) => voteScore(voter, b) - voteScore(voter, a))[0]?.id;
}

function pickVoteResult(ballots) {
  const tally = new Map();
  ballots.forEach((id) => tally.set(id, (tally.get(id) || 0) + 1));
  const highest = Math.max(...tally.values());
  const tied = [...tally.entries()].filter(([, count]) => count === highest).map(([id]) => id);
  return { bootedId: tied[randomBetween(0, tied.length - 1)], tally };
}

function openTribalCouncil(voterIds, candidateIds, prompt) {
  pendingCouncil = { voterIds, candidateIds };
  tribalPanelElement.hidden = false;
  document.querySelector("#tribal-prompt").textContent = prompt;
  if (isMultiplayer) {
    roomVotes = {};
    roomCouncilResolving = false;
    const localCanVote = voterIds.includes(getPlayer()?.id);
    tribalPanelElement.hidden = !localCanVote;
    if (localCanVote) renderVoteOptions(candidateIds);
    render();
    if (isRoomHost()) {
      broadcastRoomState();
      resolveRoomCouncilIfReady();
      roomCouncilTimer = setTimeout(() => resolveRoomCouncilIfReady(true), 90000);
    }
    return;
  }
  if (!voterIds.includes("player") || !candidateIds.length) {
    resolveNpcCouncil(voterIds, candidateIds);
    return;
  }
  renderVoteOptions(candidateIds);
  render();
}

function renderVoteOptions(candidateIds) {
  voteOptionsElement.replaceChildren();
  candidateIds.forEach((id) => {
    const candidate = getContestant(id);
    const button = makeElement("button", "vote-choice", candidate.name);
    button.type = "button";
    button.disabled = isMultiplayer && Boolean(roomVotes[getPlayer()?.id]);
    button.addEventListener("click", () => resolvePlayerCouncilVote(id));
    voteOptionsElement.append(button);
  });
}

function resolveNpcCouncil(voterIds, candidateIds) {
  const ballots = voterIds
    .filter((id) => id !== "player")
    .map((id) => botVote(id, candidateIds))
    .filter(Boolean);
  const result = pickVoteResult(ballots);
  applyElimination(result.bootedId, result.tally);
}

function resolvePlayerCouncilVote(playerVote) {
  if (!pendingCouncil || !["ready", "challenge", "day", "tribal"].includes(phase)) return;
  if (isMultiplayer) {
    const voterId = getPlayer()?.id;
    if (!pendingCouncil.voterIds.includes(voterId) || !pendingCouncil.candidateIds.includes(playerVote) || roomVotes[voterId]) return;
    roomVotes[voterId] = playerVote;
    renderVoteOptions(pendingCouncil.candidateIds);
    messageElement.textContent = "Vote received. Waiting for the other voters.";
    render();
    if (isRoomHost()) resolveRoomCouncilIfReady();
    else sendRoomEvent("player-vote", { day, voterId, targetId: playerVote });
    return;
  }
  const ballots = pendingCouncil.voterIds
    .map((id) => id === "player" ? playerVote : botVote(id, pendingCouncil.candidateIds))
    .filter(Boolean);
  if (pendingCouncil.voterIds.includes("player") && pendingCouncil.candidateIds.includes(playerVote)) ballots.push(playerVote);
  const result = pickVoteResult(ballots);
  const playerTarget = getContestant(playerVote);
  if (playerTarget) playerTarget.points += 5;
  applyElimination(result.bootedId, result.tally);
}

function resolveRoomCouncilIfReady(force = false) {
  if (!isRoomHost() || !["ready", "challenge", "day", "tribal"].includes(phase) || !pendingCouncil || roomCouncilResolving) return;
  const humanVoters = pendingCouncil.voterIds.filter((id) => isHuman(getContestant(id)));
  if (!force && humanVoters.some((id) => !roomVotes[id])) return;
  roomCouncilResolving = true;
  if (roomCouncilTimer) clearTimeout(roomCouncilTimer);
  const ballots = pendingCouncil.voterIds.map((id) => {
    if (roomVotes[id]) return roomVotes[id];
    return botVote(id, pendingCouncil.candidateIds);
  }).filter(Boolean);
  const result = pickVoteResult(ballots);
  applyElimination(result.bootedId, result.tally);
}

function resolveRoomJuryIfReady(force = false) {
  if (!isRoomHost() || phase !== "jury" || !juryTally || roomCouncilResolving) return;
  const humanJurors = jurors.filter((id) => isHuman(getContestant(id)));
  if (!force && humanJurors.some((id) => !roomVotes[id])) return;
  roomCouncilResolving = true;
  if (roomCouncilTimer) clearTimeout(roomCouncilTimer);
  humanJurors.forEach((id) => {
    const vote = roomVotes[id];
    if (vote && juryTally.has(vote)) juryTally.set(vote, juryTally.get(vote) + 1);
  });
  revealWinner(getAlive(), juryTally);
}

function applyElimination(bootedId, tally) {
  const booted = getContestant(bootedId);
  if (!booted) return;
  booted.alive = false;
  jurors.push(booted.id);
  const voteCount = tally.get(booted.id) || 0;
  addEvent(`Day ${day}: ${booted.name} voted out (${voteCount} votes).`);
  tribalPanelElement.hidden = true;
  pendingCouncil = null;
  if (isLocalPlayer(booted)) localPlayerEliminated = true;
  if (!isMultiplayer && booted.id === "player") {
    phase = "spectating";
    messageElement.textContent = "Your torch is out. Watch the rest of the season play out.";
    endDayButton.disabled = false;
    endDayButton.textContent = "Simulate to finale";
    render();
    return;
  }
  if (getAlive().length <= 3) {
    finishSeason();
    return;
  }
  if (!merged && getAlive().length === 8) {
    merged = true;
    getAlive().forEach((contestant) => { contestant.tribeId = "merged"; });
    addEvent("The tribes merge at the final 8. Individual immunity begins.");
  }
  roomCouncilResolving = false;
  render();
  if (isMultiplayer && isRoomHost()) broadcastRoomState();
}

function finishChallengeWindow() {
  if (phase !== "challenge") return;
  if (isMultiplayer && getPlayer()) {
    roomChallengeScores[getPlayer().id] = score;
    roomChallengeMoves[getPlayer().id] = moves;
    if (isRoomHost()) broadcastRoomState("scoreboard");
    else sendRoomEvent("challenge-score", { playerId: getPlayer().id, score, moves, day });
  }
  phase = "day";
  locked = true;
  ended = true;
  secondsLeft = 0;
  messageElement.textContent = pendingCouncil
    ? `Challenge complete. Cast your tribe's vote before the day ends in ${formatTime(daySecondsLeft)}.`
    : `Challenge complete. The day continues for ${formatTime(daySecondsLeft)}.`;
  render();
  if (isMultiplayer && isRoomHost()) broadcastRoomState();
}

function beginDayWithCouncil(voterIds, candidateIds, prompt) {
  pendingCouncil = { voterIds, candidateIds };
  roomVotes = {};
  day++;
  startDay(false);
  openTribalCouncil(voterIds, candidateIds, prompt);
  if (isMultiplayer && isRoomHost()) broadcastRoomState();
}

function resolveDay() {
  if (phase !== "ready" && phase !== "day" && phase !== "challenge") return;
  if (isMultiplayer && !isRoomHost()) {
    if (phase === "challenge") finishChallengeWindow();
    phase = "waiting";
    locked = true;
    ended = true;
    if (getPlayer()) roomChallengeScores[getPlayer().id] = score;
    sendRoomEvent("challenge-score", { playerId: getPlayer()?.id, score, moves, day });
    messageElement.textContent = "Your day is complete. Waiting for the host to call Tribal Council.";
    render();
    return;
  }
  if (pendingCouncil) {
    if (isMultiplayer) resolveRoomCouncilIfReady(true);
    else {
      const ballots = pendingCouncil.voterIds
        .map((id) => roomVotes[id] || botVote(id, pendingCouncil.candidateIds))
        .filter(Boolean);
      const result = pickVoteResult(ballots);
      applyElimination(result.bootedId, result.tally);
    }
    if (["jury", "finale", "spectating"].includes(phase)) return;
  }
  locked = true;
  ended = true;
  secondsLeft = 0;
  daySecondsLeft = 0;
  if (isMultiplayer) {
    roomChallengeScores[getPlayer()?.id] = score;
    contestants.forEach((contestant) => { contestant.points += roomChallengeScores[contestant.id] || 0; });
  } else {
    getPlayer().points += score;
  }
  if (merged) {
    if (isMultiplayer) {
      botImmunityWinner = contestants
        .filter((contestant) => contestant.alive)
        .map((contestant) => ({ id: contestant.id, name: contestant.name, score: roomChallengeScores[contestant.id] || 0 }))
        .sort((first, second) => second.score - first.score)[0];
      playerImmune = Boolean(botImmunityWinner && !getContestant(botImmunityWinner.id)?.isBot);
      messageElement.textContent = `${botImmunityWinner?.name || "A castaway"} wins individual immunity.`;
      addEvent(`Day ${day}: ${botImmunityWinner?.name || "A castaway"} wins individual immunity.`);
    } else if (score >= botImmunityWinner.score) {
      botImmunityWinner = { id: "player", name: getPlayer().name, score };
      playerImmune = true;
      addEvent(`Day ${day}: ${getPlayer().name} wins individual immunity.`);
      messageElement.textContent = "You won individual immunity. Cast your vote at Tribal Council.";
    } else {
      addEvent(`Day ${day}: ${botImmunityWinner.name} wins individual immunity.`);
      messageElement.textContent = `${botImmunityWinner.name} wins immunity. Cast your vote carefully.`;
    }
    const voters = getAlive().map((contestant) => contestant.id);
    const candidates = voters.filter((id) => id !== botImmunityWinner.id);
    beginDayWithCouncil(voters, candidates, "The merge vote is yours. Select one castaway to vote out.");
    return;
  }

  const playerTribe = getPlayer().tribeId;
  const otherTribe = TRIBES.find((tribe) => tribe.id !== playerTribe);
  const playerTotal = isMultiplayer
    ? getAlive().filter((contestant) => contestant.tribeId === playerTribe).reduce((sum, contestant) => sum + (roomChallengeScores[contestant.id] || 0), 0)
    : score + (tribeSupport[playerTribe] || 0);
  const otherTotal = isMultiplayer
    ? getAlive().filter((contestant) => contestant.tribeId === otherTribe.id).reduce((sum, contestant) => sum + (roomChallengeScores[contestant.id] || 0), 0)
    : tribeSupport[otherTribe.id] || 0;
  let losingTribeId = playerTotal >= otherTotal ? otherTribe.id : playerTribe;
  const tribeSizes = Object.fromEntries(TRIBES.map((tribe) => [
    tribe.id,
    getAlive().filter((contestant) => contestant.tribeId === tribe.id).length,
  ]));
  if (tribeSizes[losingTribeId] < 2) losingTribeId = TRIBES.find((tribe) => tribe.id !== losingTribeId).id;
  const losingTribe = getTribe(losingTribeId);
  const losingMembers = getAlive().filter((contestant) => contestant.tribeId === losingTribeId);
  addEvent(`Day ${day}: ${losingTribe.name} loses immunity and must vote someone out.`);
  messageElement.textContent = losingTribeId === playerTribe
    ? `${losingTribe.name} lost. Choose your vote at Tribal Council.`
    : `${losingTribe.name} lost. Their council will decide who goes home.`;
  beginDayWithCouncil(
    losingMembers.map((contestant) => contestant.id),
    losingMembers.map((contestant) => contestant.id).filter((id) => isMultiplayer || id !== "player"),
    losingTribeId === playerTribe ? "Your tribe lost immunity. Who should be voted out?" : `${losingTribe.name} lost immunity.`,
  );
}

function maybeMerge() {
  if (!merged && getAlive().length === 8) {
    merged = true;
    getAlive().forEach((contestant) => { contestant.tribeId = "merged"; });
    addEvent("The tribes merge at the final 8. Individual immunity begins.");
  }
}

function simulateToFinale() {
  tribalPanelElement.hidden = true;
  phase = "spectating";
  while (getAlive().length > 3) {
    maybeMerge();
    let voters;
    let candidates;
    if (merged) {
      voters = getAlive().map((contestant) => contestant.id);
      const immuneId = voters[randomBetween(0, voters.length - 1)];
      candidates = voters.filter((id) => id !== immuneId);
      addEvent(`Day ${day}: ${getContestant(immuneId).name} wins individual immunity.`);
    } else {
      const activeTribes = TRIBES.filter((tribe) => getAlive().filter((contestant) => contestant.tribeId === tribe.id).length > 1);
      const losingTribe = activeTribes[randomBetween(0, activeTribes.length - 1)];
      voters = getAlive().filter((contestant) => contestant.tribeId === losingTribe.id).map((contestant) => contestant.id);
      candidates = voters.slice();
      addEvent(`Day ${day}: ${losingTribe.name} loses the challenge.`);
    }
    const ballots = voters.map((id) => botVote(id, candidates)).filter(Boolean);
    const result = pickVoteResult(ballots);
    const booted = getContestant(result.bootedId);
    booted.alive = false;
    jurors.push(booted.id);
    addEvent(`Day ${day}: ${booted.name} voted out (${result.tally.get(booted.id) || 0} votes).`);
    day++;
  }
  finishSeason();
}

function getJuryTally(finalists) {
  const juryTally = new Map(finalists.map((contestant) => [contestant.id, 0]));
  jurors.filter((id) => isMultiplayer ? getContestant(id)?.isBot : id !== "player").forEach((jurorId) => {
    const juror = getContestant(jurorId);
    const ratings = finalists.map((finalist) => ({
      id: finalist.id,
      rating: finalist.social + finalist.threat * 0.35 + finalist.points / 45 + (finalist.originTribe === juror.originTribe ? 2 : 0) + Math.random() * 4,
    }));
    const vote = ratings.sort((a, b) => b.rating - a.rating)[0];
    juryTally.set(vote.id, juryTally.get(vote.id) + 1);
  });
  return juryTally;
}

function revealWinner(finalists, juryTally) {
  const highest = Math.max(...juryTally.values());
  const winners = finalists.filter((finalist) => juryTally.get(finalist.id) === highest);
  const winner = winners[randomBetween(0, winners.length - 1)];
  seasonWinnerId = winner.id;
  juryTally = new Map(juryTally);
  phase = "finale";
  tribalPanelElement.hidden = true;
  juryPanelElement.hidden = true;
  finalePanelElement.hidden = false;
  document.querySelector("#winner-name").textContent = `${winner.name} wins!`;
  document.querySelector("#jury-result").textContent = [...juryTally.entries()]
    .map(([id, votes]) => `${getContestant(id).name}: ${votes}`)
    .join(" · ");
  addEvent(`Finale: ${winner.name} is the Sole Survivor, winning ${highest} jury votes.`);
  messageElement.textContent = "The jury has voted. A Sole Survivor is crowned.";
  endDayButton.disabled = true;
  render();
  if (isMultiplayer && isRoomHost()) broadcastRoomState();
}

function finishSeason() {
  const finalists = getAlive();
  juryTally = getJuryTally(finalists);
  if (isMultiplayer) {
    phase = "jury";
    roomVotes = {};
    roomCouncilResolving = false;
    tribalPanelElement.hidden = true;
    finalePanelElement.hidden = true;
    juryPanelElement.hidden = !jurors.includes(getPlayer()?.id);
    if (juryPanelElement.hidden) messageElement.textContent = "Final Tribal Council is underway. Waiting for the jury.";
    else {
      renderJuryOptions(finalists);
      messageElement.textContent = "You’re on the jury. Cast your vote for the Sole Survivor.";
    }
    render();
    if (isRoomHost()) {
      broadcastRoomState();
      roomCouncilTimer = setTimeout(() => resolveRoomJuryIfReady(true), 90000);
      resolveRoomJuryIfReady();
    }
    return;
  }
  if (jurors.includes("player")) {
    phase = "jury";
    tribalPanelElement.hidden = true;
    finalePanelElement.hidden = true;
    juryPanelElement.hidden = false;
    renderJuryOptions(finalists);
    messageElement.textContent = "You made the jury. Cast your vote for the Sole Survivor.";
    render();
    return;
  }
  revealWinner(finalists, juryTally);
}

function renderJuryOptions(finalists) {
  juryOptionsElement.replaceChildren();
  finalists.forEach((finalist) => {
    const button = makeElement("button", "vote-choice", finalist.name);
    button.type = "button";
    button.disabled = isMultiplayer && Boolean(roomVotes[getPlayer()?.id]);
    button.addEventListener("click", () => {
      if (isMultiplayer) {
        const voterId = getPlayer()?.id;
        if (!jurors.includes(voterId) || roomVotes[voterId]) return;
        roomVotes[voterId] = finalist.id;
        juryOptionsElement.querySelectorAll("button").forEach((option) => { option.disabled = true; });
        messageElement.textContent = "Jury vote received. Waiting for the other jurors.";
        render();
        if (isRoomHost()) resolveRoomJuryIfReady();
        else sendRoomEvent("jury-vote", { voterId, targetId: finalist.id });
        return;
      }
      juryTally.set(finalist.id, juryTally.get(finalist.id) + 1);
      revealWinner(finalists, juryTally);
    });
    juryOptionsElement.append(button);
  });
}

function restoreGame(savedOverride = null) {
  let saved = savedOverride;
  if (!saved) {
    try {
      saved = JSON.parse(localStorage.getItem(storageKeyForUser()));
    } catch {
      return false;
    }
  }
  if (
    !saved || ![1, 2, SAVE_VERSION].includes(saved.version) ||
    !Array.isArray(saved.board) || saved.board.length !== SIZE ||
    !Array.isArray(saved.contestants) || saved.contestants.length !== 14 ||
    !["ready", "challenge", "day", "tribal", "spectating", "jury", "finale"].includes(saved.phase)
  ) return false;

  board = saved.board;
  if (board.some((row) => !Array.isArray(row) || row.length !== SIZE || row.some((piece) => !Number.isInteger(piece) || piece < 0 || piece >= PIECES.length))) return false;
  selected = saved.selected;
  score = saved.score || 0;
  moves = saved.moves || 0;
  pointsPerFruit = saved.pointsPerFruit || 10;
  const awaySeconds = Math.floor((Date.now() - saved.savedAt) / 1000);
  const isLegacyChallenge = saved.version < SAVE_VERSION && saved.phase === "challenge";
  phase = isLegacyChallenge ? "ready" : saved.phase;
  secondsLeft = phase === "ready"
    ? CHALLENGE_SECONDS
    : Math.max(0, saved.secondsLeft - (phase === "challenge" ? awaySeconds : 0));
  daySecondsLeft = saved.version === SAVE_VERSION && Number.isFinite(saved.daySecondsLeft)
    ? Math.max(0, saved.daySecondsLeft - (["ready", "challenge", "day"].includes(phase) ? awaySeconds : 0))
    : DAY_SECONDS;
  contestants = saved.contestants;
  jurors = saved.jurors || [];
  events = saved.events || [];
  day = saved.day || 1;
  dayStartedAt = saved.dayStartedAt || Date.now();
  merged = Boolean(saved.merged);
  playerImmune = Boolean(saved.playerImmune);
  tribeSupport = saved.tribeSupport || {};
  botImmunityWinner = saved.botImmunityWinner || null;
  pendingCouncil = saved.pendingCouncil || null;
  juryTally = saved.juryTally ? new Map(saved.juryTally) : null;
  seasonWinnerId = saved.seasonWinnerId || null;
  matchedCells = new Set(saved.matchedCells || []);
  messageElement.textContent = saved.message || "Season resumed.";
  document.querySelector("#player-name").value = getPlayer()?.name || "You";
  document.querySelector("#points-per-fruit").value = String(pointsPerFruit);

  ended = phase !== "challenge";
  locked = ended || findMatches(board).size > 0;
  tribalPanelElement.hidden = !pendingCouncil?.voterIds.includes(getPlayer()?.id);
  juryPanelElement.hidden = phase !== "jury";
  finalePanelElement.hidden = phase !== "finale";
  if (pendingCouncil?.voterIds.includes(getPlayer()?.id)) {
    document.querySelector("#tribal-prompt").textContent = "Your tribe lost immunity. Who should be voted out?";
    renderVoteOptions(pendingCouncil.candidateIds);
  }
  if (phase === "jury" && juryTally) renderJuryOptions(getAlive());
  if (phase === "finale" && seasonWinnerId && juryTally) {
    document.querySelector("#winner-name").textContent = `${getContestant(seasonWinnerId)?.name || "A finalist"} wins!`;
    document.querySelector("#jury-result").textContent = [...juryTally.entries()]
      .map(([id, votes]) => `${getContestant(id)?.name || "Castaway"}: ${votes}`)
      .join(" · ");
  }
  render();
  saveStatusElement.textContent = "SEASON RESUMED";
  if (phase === "challenge" && secondsLeft === 0) finishChallengeWindow();
  else if (["challenge", "day"].includes(phase) && daySecondsLeft === 0) resolveDay();
  else if (phase === "challenge" && findMatches(board).size > 0) resolveMatches();
  return true;
}

function updateAccountPanel() {
  const accountForm = document.querySelector("#account-form");
  const accountSession = document.querySelector("#account-session");
  accountForm.hidden = Boolean(currentUser);
  accountSession.hidden = !currentUser;
  document.querySelector("#account-email-label").textContent = currentUser?.email || "";
}

async function loadAccountUser(user) {
  if (user && currentUser?.id === user.id) {
    updateAccountPanel();
    return;
  }
  const loadToken = ++accountLoadToken;
  const previousUser = currentUser;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = null;
  if (queuedCloudSave && previousUser) void flushCloudSave();
  queuedCloudSave = null;

  if (!user) {
    currentUser = null;
    accountLoading = false;
    updateAccountPanel();
    if (isMultiplayer && roomConfig.localUserId === roomConfig.hostId) {
      location.replace(`/Lobby.html?room=${roomConfig.roomCode}`);
      return;
    }
    if (previousUser && !isMultiplayer) {
      document.querySelector("#player-name").value = "You";
      startSeason();
    }
    return;
  }

  currentUser = user;
  if (isMultiplayer) {
    accountLoading = false;
    updateAccountPanel();
    document.querySelector("#account-message").textContent = "Signed in. Room progress is shared with everyone in the room.";
    return;
  }
  accountLoading = true;
  updateAccountPanel();
  renderBoard();
  saveStatusElement.textContent = "LOADING ACCOUNT";
  document.querySelector("#account-message").textContent = "Loading your saved season…";

  const { data, error } = await supabaseClient
    .from("season_saves")
    .select("save_data")
    .eq("user_id", user.id)
    .maybeSingle();
  if (loadToken !== accountLoadToken) return;

  let saved = data?.save_data || null;
  if (error) {
    document.querySelector("#account-message").textContent = "Cloud saves are unavailable. Check the Supabase table and policies.";
  }
  if (!saved) {
    try {
      saved = JSON.parse(localStorage.getItem(storageKeyForUser(user)) || localStorage.getItem(SAVE_KEY));
    } catch {
      saved = null;
    }
  }

  accountLoading = false;
  if (saved) {
    try {
      localStorage.setItem(storageKeyForUser(user), JSON.stringify(saved));
    } catch {
      saveStatusElement.textContent = "LOCAL SAVE FAILED";
    }
  }
  if (!saved || !restoreGame(saved)) startSeason();
  document.querySelector("#account-message").textContent = error
    ? "Signed in, but cloud sync needs setup. This device still autosaves locally."
    : "Account season loaded and ready to sync.";
  saveGame(true);
}

async function initializeAccounts() {
  const accountMessage = document.querySelector("#account-message");
  const config = window.ISLAND_TRIALS_SUPABASE;
  if (
    !window.supabase?.createClient || !config?.url || !config?.key ||
    config.url.includes("YOUR_PROJECT_REF") || config.key.includes("YOUR_SUPABASE")
  ) {
    if (isMultiplayer || soloRequested) {
      location.replace("Lobby.html");
      return;
    }
    document.querySelector("#account-form").hidden = true;
    accountMessage.textContent = "Add your Supabase project URL and public key in supabase-config.js to enable accounts.";
    return;
  }

  supabaseClient = window.supabase.createClient(config.url, config.key);
  document.querySelector("#account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    accountMessage.textContent = "Signing in…";
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: document.querySelector("#account-email").value.trim(),
      password: document.querySelector("#account-password").value,
    });
    accountMessage.textContent = error ? error.message : "Signed in. Loading your season…";
  });
  document.querySelector("#sign-up").addEventListener("click", async () => {
    if (!document.querySelector("#account-form").reportValidity()) return;
    accountMessage.textContent = "Creating account…";
    const { data, error } = await supabaseClient.auth.signUp({
      email: document.querySelector("#account-email").value.trim(),
      password: document.querySelector("#account-password").value,
    });
    accountMessage.textContent = error
      ? error.message
      : data.session
        ? "Account created. Loading your season…"
        : "Account created. Check your email to confirm, then sign in.";
  });
  document.querySelector("#sign-out").addEventListener("click", async () => {
    accountMessage.textContent = "Signing out…";
    const { error } = await supabaseClient.auth.signOut();
    if (error) accountMessage.textContent = error.message;
  });

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
      setTimeout(() => loadAccountUser(session?.user || null), 0);
    }
  });
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) accountMessage.textContent = error.message;
  if (isMultiplayer) {
    const roomUser = data.session?.user || null;
    if (!roomUser && roomConfig.localUserId === roomConfig.hostId) {
      location.replace(`/Lobby.html?room=${roomConfig.roomCode}`);
      return;
    }
    await loadAccountUser(roomUser);
    initializeRoomGame();
    return;
  }
  if (!soloRequested || !data.session?.user) {
    location.replace("Lobby.html");
    return;
  }
  await loadAccountUser(data.session?.user || null);
}

function onBoardPointerDown(event) {
  const tile = event.target.closest(".tile");
  if (!tile || accountLoading || phase !== "challenge" || ended || locked) return;
  pointerStart = {
    row: Number(tile.dataset.row),
    column: Number(tile.dataset.column),
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
  pointerMoved = false;
}

boardElement.addEventListener("pointerdown", onBoardPointerDown);
boardElement.addEventListener("pointermove", (event) => {
  if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
  if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 8) pointerMoved = true;
});
boardElement.addEventListener("pointerup", (event) => {
  if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
  const start = pointerStart;
  pointerStart = null;
  ignorePointerClickUntil = Date.now() + 400;
  const tile = document.elementFromPoint(event.clientX, event.clientY)?.closest(".tile");
  if (pointerMoved && tile) {
    const destination = { row: Number(tile.dataset.row), column: Number(tile.dataset.column) };
    if (Math.abs(start.row - destination.row) + Math.abs(start.column - destination.column) === 1) {
      selected = { row: start.row, column: start.column };
      chooseTile(destination.row, destination.column);
      return;
    }
  }
  chooseTile(start.row, start.column);
});
boardElement.addEventListener("pointercancel", () => {
  pointerStart = null;
  pointerMoved = false;
});
boardElement.addEventListener("click", (event) => {
  if (event.detail > 0 && Date.now() < ignorePointerClickUntil) return;
  const tile = event.target.closest(".tile");
  if (tile) chooseTile(Number(tile.dataset.row), Number(tile.dataset.column));
});
endDayButton.addEventListener("click", () => {
  if (phase === "ready") startChallenge();
  else if (phase === "challenge") finishChallengeWindow();
  else if (phase === "spectating") simulateToFinale();
});
newSeasonButton.addEventListener("click", startSeason);
saveNowButton.addEventListener("click", () => saveGame(true));

if (isMultiplayer) startSeason();
else if (soloRequested) {
  if (!restoreGame()) startSeason();
} else {
  location.replace("Lobby.html");
}
initializeAccounts();
setInterval(() => {
  if (accountLoading || !["ready", "challenge", "day"].includes(phase)) return;
  daySecondsLeft = Math.max(0, daySecondsLeft - 1);
  if (phase === "challenge") secondsLeft = Math.max(0, secondsLeft - 1);
  if (phase === "challenge" && secondsLeft === 0) finishChallengeWindow();
  if (daySecondsLeft === 0) {
    resolveDay();
    return;
  }
  renderStats();
  saveGame();
}, 1000);