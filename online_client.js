export function createOnlineClient({url, renderers = {}}) {
  const state = {
    ws: null,
    playerId: null,
    playerName: null,
    currentRoom: null,
    isWaiting: false,
    appState: "disconnected",
    roomCounts: {},
    roomRules: {},
  };

  const call = (name, payload) => {
    if (typeof renderers[name] === "function") {
      renderers[name](payload, state);
    }
  };

  const send = (payload) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      call("connectionError", "サーバーに接続されていません。");
      return false;
    }
    state.ws.send(JSON.stringify(payload));
    return true;
  };

  const setAppState = (nextState) => {
    state.appState = nextState;
    call("state", nextState);
  };

  const handlers = {
    your_id(msg) {
      state.playerId = msg.id;
      call("yourId", msg);
    },

    name_set(msg) {
      state.playerName = msg.name;
      call("nameSet", msg);
    },

    room_counts(msg) {
      state.roomCounts = msg.counts || {};
      state.roomRules = msg.rules || {};
      call("roomList", msg);
    },

    update_room_status(msg) {
      if (state.currentRoom === msg.room_id) {
        call("roomStatus", msg);
      }
      call("roomCountPatch", msg);
    },

    room_state_initialization(msg) {
      setAppState(msg.room_state === "playing" ? "playing" : "in-room");
      call("roomInitialized", msg);
    },

    game_start(msg) {
      setAppState("playing");
      call("gameStart", msg);
    },

    game_update(msg) {
      call("gameUpdate", msg);
    },

    private_update(msg) {
      call("privateUpdate", msg);
    },

    turn_update(msg) {
      call("turnUpdate", msg);
    },

    action_result(msg) {
      call("actionResult", msg);
    },

    game_over(msg) {
      setAppState("in-room");
      call("gameOver", msg);
    },

    chat(msg) {
      call("chat", msg);
    },

    error(msg) {
      call("error", msg.message || "エラーが発生しました。");
    },
  };

  const connect = () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.close();
    }

    state.ws = new WebSocket(url);

    state.ws.onopen = () => {
      setAppState("room-list");
      send({type: "get_room_counts"});
      call("connected");
    };

    state.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const handler = handlers[msg.type];
      if (handler) {
        handler(msg);
      } else {
        call("unknownMessage", msg);
      }
    };

    state.ws.onclose = () => {
      state.isWaiting = false;
      setAppState("disconnected");
      call("connectionClosed", "サーバーとの接続が切れました。");
    };

    state.ws.onerror = () => {
      call("connectionError", "サーバーとの接続でエラーが発生しました。");
    };
  };

  return {
    state,
    connect,
    send,

    setName(name) {
      send({type: "set_name", name});
    },

    refreshRooms() {
      send({type: "get_room_counts"});
    },

    joinRoom(roomId) {
      state.currentRoom = roomId;
      send({type: "join_room", room_id: roomId});
    },

    leaveRoom() {
      send({type: "leave_room"});
      state.currentRoom = null;
      state.isWaiting = false;
      setAppState("room-list");
    },

    toggleParticipation() {
      state.isWaiting = !state.isWaiting;
      send({
        type: "change_status",
        status: state.isWaiting ? "waiting" : "watching",
      });
      call("participationChanged", state.isWaiting);
    },

    startGame() {
      send({type: "start_game"});
    },

    sendAction(action, payload = {}) {
      send({type: "game_action", action, ...payload});
    },

    sendChat(message) {
      const text = String(message || "").trim();
      if (text) {
        send({type: "chat", message: text});
      }
    },
  };
}
