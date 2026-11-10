// Zombies lobby service: a tiny public list of games that are being hosted.
//
// Hosts POST /announce every ~15 s while their lobby is open; the list keeps a
// game for 45 s after its last announce. Players GET /list to fill the in-game
// server browser and then connect straight to the host (this service never
// carries game traffic). The host's address is the IP the announce came from.
//
// One Durable Object holds the list in memory, so every request sees the same
// list. If it is ever evicted, hosts re-announce within seconds.

const TTL_MS = 45_000;
const MAX_GAMES = 300;
const MAX_PER_IP = 3;

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

export class Lobby {
  constructor(state, env) {
    this.games = new Map(); // id -> game
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

    if (request.method === "GET" && url.pathname === "/list") {
      const version = url.searchParams.get("version");
      const out = [];
      for (const [id, g] of this.games) {
        if (version && g.version !== version) continue;
        out.push({ id, name: g.name, ip: g.ip, port: g.port, players: g.players, max: g.max,
          version: g.version, map: g.map, age: Math.round((now - g.seen) / 1000) });
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
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return json({ error: "bad id" }, 400);
      const existing = this.games.get(id);
      if (existing && existing.ip !== ip) return json({ error: "not yours" }, 403);
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
        ip, port,
        name: clean(body.name, 32) || "Zombies game",
        players: Math.max(0, Math.min(16, Number(body.players) | 0)),
        max: Math.max(1, Math.min(16, Number(body.max) | 0)),
        version: clean(body.version, 16),
        map: clean(body.map, 16),
        seen: now,
      });
      return json({ ok: true, ip });
    }

    return json({ error: "not found" }, 404);
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
