import {createOnlineClient} from "./online_client.js?v=20260701-3";

const $ = (selector) => document.querySelector(selector);

const els = {
  connectionStatus: $("#connectionStatus"),
  nameInput: $("#nameInput"),
  doubleClickToggle: $("#doubleClickToggle"),
  refreshRoomsButton: $("#refreshRoomsButton"),
  roomList: $("#roomList"),
  leaveRoomButton: $("#leaveRoomButton"),
  participationButton: $("#participationButton"),
  startGameButton: $("#startGameButton"),
  playerList: $("#playerList"),
  chatLog: $("#chatLog"),
  chatForm: $("#chatForm"),
  chatInput: $("#chatInput"),
  turnLabel: $("#turnLabel"),
  myColorLabel: $("#myColorLabel"),
  scoreLabel: $("#scoreLabel"),
  messageLine: $("#messageLine"),
  board: $("#board"),
  moveLog: $("#moveLog"),
};

const colorLabel = {
  black: "黒",
  white: "白",
};

const LOCAL_WS_URL = "ws://localhost:8000/ws";
const PRODUCTION_WS_URL = "wss://web-production-801d2.up.railway.app/ws";
const DOUBLE_CLICK_STORAGE_KEY = "subspace-gomoku-double-click";

let client = null;
let latestGame = null;
let latestRoomStatus = null;
let myPrivateState = {};
let pendingPoint = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

function isLocalEnvironment() {
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return true;
  }
  return location.protocol === "file:";
}

function defaultWsUrl() {
  if (isLocalEnvironment()) {
    return LOCAL_WS_URL;
  }
  return PRODUCTION_WS_URL;
}

function useDoubleClickPlacement() {
  return els.doubleClickToggle.checked;
}

function pointKey(row, col) {
  return `${row},${col}`;
}

function setMessage(message) {
  els.messageLine.textContent = message;
}

function websocketIsActive() {
  const ws = client?.state?.ws;
  return ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function scheduleReconnect(message = "サーバーへ再接続しています。") {
  if (reconnectTimer || websocketIsActive()) {
    return;
  }
  els.connectionStatus.textContent = "再接続中";
  setMessage(message);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
    reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
  }, reconnectDelay);
}

function appendChat(sender, message) {
  const line = document.createElement("div");
  line.className = sender === "system" ? "chat-line system" : "chat-line";
  line.textContent = `${sender}: ${message}`;
  els.chatLog.append(line);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderRooms(msg) {
  els.roomList.replaceChildren();
  const roomIds = Object.keys(msg.rules || {});
  if (roomIds.length === 0) {
    els.roomList.textContent = "部屋情報がありません。";
    return;
  }

  for (const roomId of roomIds) {
    const button = document.createElement("button");
    button.className = "room-button";
    const label = document.createElement("span");
    label.textContent = msg.rules[roomId];
    const count = document.createElement("small");
    count.textContent = `${roomId} / ${msg.counts?.[roomId] ?? 0}人`;
    button.append(label, count);
    button.addEventListener("click", () => client.joinRoom(roomId));
    els.roomList.append(button);
  }
}

function renderPlayers(msg) {
  latestRoomStatus = msg;
  els.playerList.replaceChildren();
  const players = msg.player_list || [];

  if (players.length === 0) {
    els.playerList.textContent = "入室者はいません。";
    return;
  }

  for (const player of players) {
    const row = document.createElement("div");
    row.className = "player-row";
    const isMe = player.id === client.state.playerId;
    const name = document.createElement("span");
    name.textContent = `${player.name}${isMe ? "（あなた）" : ""}`;
    const status = document.createElement("small");
    status.textContent = player.status === "waiting" ? "参加" : "観戦";
    row.append(name, status);
    els.playerList.append(row);
  }

  const me = players.find((player) => player.id === client.state.playerId);
  client.state.isWaiting = me?.status === "waiting";
  els.participationButton.textContent = client.state.isWaiting ? "観戦に戻る" : "対戦参加";
}

function renderBoard(game = latestGame) {
  const board = game?.board || [];
  const size = game?.board_size || 19;
  const last = game?.last_move;
  const captured = new Set((game?.captured_last_move || []).map((point) => pointKey(point.row, point.col)));
  els.board.style.setProperty("--board-size", String(size));
  els.board.replaceChildren();

  const grid = document.createElement("div");
  grid.className = "board-grid";
  for (let index = 0; index < size; index += 1) {
    const position = `${(index / (size - 1)) * 100}%`;
    const vertical = document.createElement("span");
    vertical.className = "board-line vertical";
    vertical.style.left = position;
    const horizontal = document.createElement("span");
    horizontal.className = "board-line horizontal";
    horizontal.style.top = position;
    grid.append(vertical, horizontal);
  }

  const points = document.createElement("div");
  points.className = "board-points";

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const cell = document.createElement("button");
      const value = board[row]?.[col] || "";
      cell.className = `cell ${value}`;
      cell.type = "button";
      cell.title = `${row + 1}, ${col + 1}`;
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.style.left = `${(col / (size - 1)) * 100}%`;
      cell.style.top = `${(row / (size - 1)) * 100}%`;
      if (last && last.row === row && last.col === col) {
        cell.classList.add("last");
      }
      if (captured.has(pointKey(row, col))) {
        cell.classList.add("captured");
      }
      if (pendingPoint?.row === row && pendingPoint?.col === col) {
        cell.classList.add("pending");
      }
      cell.addEventListener("click", () => {
        if (!client) return;
        if (value) {
          setMessage("その交点にはすでに石があります。");
          return;
        }
        if (useDoubleClickPlacement()) {
          if (pendingPoint?.row === row && pendingPoint?.col === col) {
            pendingPoint = null;
            client.sendAction("place", {row, col});
          } else {
            pendingPoint = {row, col};
            setMessage("もう一度同じ交点をクリックすると着手します。");
            renderBoard(latestGame);
          }
          return;
        }
        client.sendAction("place", {row, col});
      });
      points.append(cell);
    }
  }

  els.board.append(grid, points);
}

function renderGame(msg) {
  latestGame = msg.game || latestGame;
  pendingPoint = null;
  const game = latestGame;
  renderBoard(game);

  const currentTurn = msg.current_turn || "-";
  els.turnLabel.textContent = `手番: ${currentTurn}`;

  const players = game?.players || [];
  const black = players.find((player) => player.color === "black");
  const white = players.find((player) => player.color === "white");
  els.scoreLabel.textContent = `黒 ${black?.captures ?? 0} / 白 ${white?.captures ?? 2}`;

  const myColor = myPrivateState.color ? colorLabel[myPrivateState.color] : "-";
  const myCaptures = Number.isInteger(myPrivateState.captures) ? ` / アゲハマ ${myPrivateState.captures}` : "";
  els.myColorLabel.textContent = `あなた: ${myColor}${myCaptures}`;

  const moves = game?.moves || [];
  els.moveLog.replaceChildren();
  for (const move of moves.slice(-8).reverse()) {
    const line = document.createElement("div");
    const capturedText = move.captured?.length ? ` / 取り ${move.captured.length}` : "";
    line.textContent = `${move.move_number}. ${move.player_name} ${colorLabel[move.color]} (${move.row + 1}, ${move.col + 1})${capturedText}`;
    els.moveLog.append(line);
  }
}

function connect() {
  if (websocketIsActive()) {
    return;
  }

  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const url = defaultWsUrl();
  els.connectionStatus.textContent = "接続中";
  setMessage("サーバーへ接続しています。");
  client = createOnlineClient({
    url,
    renderers: {
      connected() {
        reconnectDelay = 1000;
        els.connectionStatus.textContent = "接続済み";
        setMessage("部屋を選んでください。");
        const name = els.nameInput.value.trim();
        if (name) client.setName(name);
      },
      connectionClosed(message) {
        els.connectionStatus.textContent = "未接続";
        latestRoomStatus = null;
        myPrivateState = {};
        pendingPoint = null;
        els.playerList.replaceChildren();
        scheduleReconnect(message);
      },
      connectionError(message) {
        scheduleReconnect(message);
      },
      nameSet(msg) {
        els.nameInput.value = msg.name;
      },
      roomList: renderRooms,
      roomCountPatch(msg) {
        if (!client) return;
        client.refreshRooms();
        if (latestRoomStatus?.room_id === msg.room_id) {
          renderPlayers(msg);
        }
      },
      roomStatus: renderPlayers,
      roomInitialized(msg) {
        setMessage(msg.room_state === "playing" ? "対局を観戦中です。" : "対戦参加して開始を待ってください。");
        if (msg.game) renderGame({game: msg.game});
      },
      participationChanged(isWaiting) {
        els.participationButton.textContent = isWaiting ? "観戦に戻る" : "対戦参加";
      },
      gameStart() {
        setMessage("対局開始。");
      },
      gameUpdate: renderGame,
      privateUpdate(msg) {
        myPrivateState = msg.payload || {};
        renderGame({game: latestGame});
      },
      turnUpdate(msg) {
        els.turnLabel.textContent = `手番: ${msg.current_turn || "-"}`;
      },
      actionResult(msg) {
        if (msg.result?.ok) {
          pendingPoint = null;
          setMessage("着手しました。");
        }
      },
      gameOver(msg) {
        pendingPoint = null;
        if (msg.game) renderGame({game: msg.game});
        setMessage(msg.winner ? `${msg.winner} の勝ちです。${msg.reason || ""}` : `対局終了。${msg.reason || ""}`);
      },
      chat(msg) {
        appendChat(msg.sender, msg.message);
      },
      error(message) {
        setMessage(message);
      },
    },
  });
  client.connect();
}

els.doubleClickToggle.checked = localStorage.getItem(DOUBLE_CLICK_STORAGE_KEY) !== "false";
renderBoard({board_size: 19, board: Array.from({length: 19}, () => Array(19).fill(null))});
connect();

els.refreshRoomsButton.addEventListener("click", () => client?.refreshRooms());
els.leaveRoomButton.addEventListener("click", () => {
  client?.leaveRoom();
  latestRoomStatus = null;
  latestGame = null;
  myPrivateState = {};
  els.playerList.replaceChildren();
  setMessage("退室しました。");
  renderBoard({board_size: 19, board: Array.from({length: 19}, () => Array(19).fill(null))});
});
els.participationButton.addEventListener("click", () => client?.toggleParticipation());
els.startGameButton.addEventListener("click", () => client?.startGame());
els.doubleClickToggle.addEventListener("change", () => {
  pendingPoint = null;
  localStorage.setItem(DOUBLE_CLICK_STORAGE_KEY, String(els.doubleClickToggle.checked));
  renderBoard(latestGame);
});
els.nameInput.addEventListener("change", () => {
  if (client) client.setName(els.nameInput.value.trim());
});
els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  client?.sendChat(els.chatInput.value);
  els.chatInput.value = "";
});
