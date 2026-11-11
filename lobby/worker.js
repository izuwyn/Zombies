// Zombies lobby service: the public list of hosted games, plus the
// "introductions" that let players connect without port forwarding.
//
// List: hosts POST /announce every ~15 s while their lobby is open; a game is
// kept for 45 s after its last announce. Players GET /list for the in-game
// server browser.
//
// Introductions (signalling): the host keeps a WebSocket open on
// /signal?role=host&game=<id>&key=<key>. A player who clicks JOIN opens
// /signal?role=join&game=<id>; this service passes the few small WebRTC
// set-up messages between them (offer, answer, network candidates). After that
// the games talk to each other directly, or through Cloudflare's TURN relay
// when no direct path exists. Game traffic never goes through this worker.
//
// GET /ice hands out short-lived TURN credentials (needs the TURN_KEY_ID and
// TURN_KEY_TOKEN secrets; without them only STUN is offered).
//
// One Durable Object holds everything, so every request sees the same state.

const TTL_MS = 45_000;
const MAX_GAMES = 300;
const MAX_PER_IP = 3;
const MAX_JOINERS = 16;
const MAX_MSG = 16_384;
const STUN = { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
}

function clean(s, n) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, n);
}

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // socket already gone
  }
}

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.games = new Map(); // id -> game
    this.ice = null; // cached {servers, until}
  }

  prune(now) {
    for (const [id, g] of this.games) {
      if (now - g.seen > TTL_MS) this.games.delete(id);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    this.prune(now);
    const ip = request.headers.get("CF-Connecting-IP") || "";

    if (url.pathname === "/signal") return this.signal(request, url);

    if (request.method === "GET" && url.pathname === "/ice") {
      const ice = await this.iceServers();
      return json({ iceServers: ice.servers, turn: ice.turn });
    }

    if (request.method === "GET" && url.pathname === "/list") {
      const version = url.searchParams.get("version");
      const out = [];
      for (const [id, g] of this.games) {
        if (version && g.version !== version) continue;
        out.push({ id, name: g.name, ip: g.ip, port: g.port, players: g.players, max: g.max,
          version: g.version, map: g.map, rtc: g.rtc, age: Math.round((now - g.seen) / 1000) });
      }
      return json({ games: out, you: ip });
    }

    if (request.method === "POST" && (url.pathname === "/announce" || url.pathname === "/remove")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json" }, 400);
      }
      const id = clean(body.id, 40);
      if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
      const key = clean(body.key, 64);
      const existing = this.games.get(id);
      // A game belongs to whoever holds its secret key (older builds without
      // a key: whoever announced it from that address).
      if (existing && (existing.key ? existing.key !== key : existing.ip !== ip)) {
        return json({ error: "not yours" }, 403);
      }
      if (url.pathname === "/remove") {
        this.games.delete(id);
        return json({ ok: true });
      }
      if (!existing) {
        let mine = 0;
        for (const g of this.games.values()) if (g.ip === ip) mine++;
        if (mine >= MAX_PER_IP) return json({ error: "too many games from this address" }, 429);
        if (this.games.size >= MAX_GAMES) return json({ error: "list full" }, 503);
      }
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return json({ error: "bad port" }, 400);
      this.games.set(id, {
        ip, port, key,
        name: clean(body.name, 32) || "Zombies game",
        players: Math.max(0, Math.min(16, Number(body.players) | 0)),
        max: Math.max(1, Math.min(16, Number(body.max) | 0)),
        version: clean(body.version, 16),
        map: clean(body.map, 16),
        rtc: body.rtc === true,
        seen: now,
      });
      return json({ ok: true, ip });
    }

    return json({ error: "not found" }, 404);
  }

  // ------------------------------------------------------------ TURN / STUN

  // Returns {servers, turn}: turn says how getting relay credentials went
  // ("ok", "no secrets", or the error) so /ice shows it. Never the key.
  async iceServers() {
    const now = Date.now();
    if (this.ice && this.ice.until > now) return this.ice;
    let servers = [STUN];
    let turn = "no secrets";
    const keyId = (this.env.TURN_KEY_ID || "").trim();
    const token = (this.env.TURN_KEY_TOKEN || "").trim();
    if (keyId && token) {
      turn = "failed";
      const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/`;
      for (const path of ["generate-ice-servers", "generate"]) {
        try {
          const r = await fetch(base + path, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ttl: 6 * 3600 }),
          });
          if (!r.ok) {
            turn = `${path}: HTTP ${r.status}`;
            continue;
          }
          const data = await r.json();
          let list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
          // Port 53 URLs are often blocked; leave them out.
          list = list.map((x) => ({ ...x, urls: [].concat(x.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
            .filter((x) => x.urls.length > 0 && x.username);
          if (list.length) {
            servers = [STUN, ...list];
            turn = "ok";
            break;
          }
          turn = `${path}: no TURN servers in the reply`;
        } catch (e) {
          turn = `${path}: ${String(e).slice(0, 80)}`;
        }
      }
    }
    // Credentials last 6 h; hand the same ones out for up to 1 h. Retry
    // failures after a minute.
    this.ice = { servers, turn, until: now + (turn === "ok" ? 3600_000 : 60_000) };
    return this.ice;
  }

  // ------------------------------------------------------------ signalling

  signal(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket only" }, 426);
    const role = url.searchParams.get("role");
    const game = clean(url.searchParams.get("game"), 40);
    if (!ID_RE.test(game)) return json({ error: "bad game" }, 400);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (role === "host") {
      const key = clean(url.searchParams.get("key"), 64);
      if (key.length < 16) return json({ error: "bad key" }, 400);
      for (const old of this.state.getWebSockets("h:" + game)) {
        const a = old.deserializeAttachment() || {};
        if (a.key !== key) return json({ error: "not yours" }, 403);
        old.close(4000, "replaced");
      }
      this.state.acceptWebSocket(server, ["h:" + game]);
      server.serializeAttachment({ role: "host", game, key });
      send(server, { type: "ready" });
    } else if (role === "join") {
      const hosts = this.state.getWebSockets("h:" + game);
      if (hosts.length === 0) return json({ error: "game not found" }, 404);
      if (this.state.getWebSockets("g:" + game).length >= MAX_JOINERS) return json({ error: "busy" }, 503);
      const conn = Math.floor(Math.random() * 1e9) + 1;
      this.state.acceptWebSocket(server, ["g:" + game, "j:" + game + ":" + conn]);
      server.serializeAttachment({ role: "join", game, conn });
      send(hosts[0], { type: "join", conn });
    } else {
      return json({ error: "bad role" }, 400);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const a = ws.deserializeAttachment() || {};
    if (a.role === "host") {
      if (msg.type === "ping") return send(ws, { type: "pong" });
      const to = Number(msg.to);
      const target = this.state.getWebSockets("j:" + a.game + ":" + to)[0];
      if (!target) return;
      delete msg.to;
      if (msg.type === "kick") return target.close(4001, "kicked");
      send(target, msg);
    } else if (a.role === "join") {
      if (msg.type === "ping") return send(ws, { type: "pong" });
      const host = this.state.getWebSockets("h:" + a.game)[0];
      if (!host) return ws.close(4002, "host left");
      msg.conn = a.conn;
      send(host, msg);
    }
  }

  async webSocketClose(ws) {
    this.closed(ws);
  }

  async webSocketError(ws) {
    this.closed(ws);
  }

  closed(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.role === "join") {
      const host = this.state.getWebSockets("h:" + a.game)[0];
      if (host) send(host, { type: "leave", conn: a.conn });
    }
    // When the host's socket closes, joiners still mid-handshake see their
    // next message go nowhere and time out; established games are unaffected.
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ service: "zombies-lobby", ok: true });
    const stub = env.LOBBY.get(env.LOBBY.idFromName("main"));
    return stub.fetch(request);
  },
};
