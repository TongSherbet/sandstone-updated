import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import initEpoxy, { EpoxyClient, EpoxyClientOptions, EpoxyHandlers } from "@mercuryworkshop/epoxy-tls";

export const ws_connections = {};

// Epoxy transport ----------------------------------------------------------
// One EpoxyClient multiplexes every stream for an origin over a single wisp
// connection. northstreet (the wisp server) enforces hard limits per client
// IP: ~4 concurrent wisp connections, and ~24 concurrent streams per
// connection. Above those it refuses new WebSocket connections or kills the
// mux with `Wisp(MuxTaskEnded)`. To stay safe we keep a small POOL of clients
// per origin (cookie affinity: the primary handles most traffic, overflow
// spills to secondaries, capped at MAX_CLIENTS) and never exceed STREAM_CAP on
// any one connection. A dead client is dropped and the request retried once.
// If the whole pool is saturated, requests QUEUE and run as slots free up
// instead of failing.
const STREAM_CAP = 12;     // streams per wisp connection (safely below northstreet's ~16)
const MAX_CLIENTS = 4;     // wisp connections per origin (matches northstreet IP limit)
const CONNECT_TIMEOUT = 10000;  // wisp connection attempt
const FETCH_TIMEOUT = 45000;    // time to first byte / headers for a single fetch

function with_timeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error(label + " timed out after " + ms + "ms")); }
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    );
  });
}

let epoxy_clients = {};     // origin -> [ { client, inFlight, dead } ]
let waiters = {};           // origin -> [resolvers blocked waiting for a slot]
let create_locks = {};      // origin -> promise chain serializing client creation
let epoxy_wisp = null;
let epoxy_init_promise = null;

// Serialize client creation per origin: the check `pool.length < MAX_CLIENTS`
// and the push must be atomic, otherwise N concurrent requests all see an
// empty pool and open N connections.
function with_create_lock(origin, fn) {
  let prev = create_locks[origin] || Promise.resolve();
  let cur = prev.then(fn, fn);
  create_locks[origin] = cur.finally(() => { if (create_locks[origin] === cur) delete create_locks[origin]; });
  return cur;
}

export async function init_epoxy() {
  if (!epoxy_init_promise) epoxy_init_promise = initEpoxy();
  await epoxy_init_promise;
}

export function set_wisp(url) {
  // drop every pooled connection; they get rebuilt lazily on next use
  epoxy_wisp = url;
  epoxy_clients = {};
  waiters = {};
  create_locks = {};
}

// alias kept for the example UI
export function set_websocket(url) {
  set_wisp(url);
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return "unknown"; }
}

async function make_entry() {
  await init_epoxy();
  let options = new EpoxyClientOptions();
  options.user_agent = navigator.userAgent;
  // bound the wisp handshake: a dead/unreachable wisp must fail fast instead of
  // leaving every request parked on an unresolved connection
  let client = await with_timeout(
    Promise.resolve().then(() => new EpoxyClient(epoxy_wisp, options)),
    CONNECT_TIMEOUT, "wisp connect"
  );
  return { client: client, inFlight: 0, dead: false };
}

function signal_waiters(origin) {
  let w = waiters[origin];
  if (w && w.length) { w.shift()(); }
}

// Returns a pool entry with inFlight already incremented. Prefers the primary
// (index 0) while it has headroom for cookie continuity, then spills to
// secondaries. Client creation is serialized so MAX_CLIENTS is truly honored.
// If the pool is full and saturated, blocks until a slot frees.
async function get_client_for(origin) {
  await init_epoxy();
  for (;;) {
    let pool = epoxy_clients[origin];
    if (!pool) { pool = []; epoxy_clients[origin] = pool; }
    if (pool.some((c) => c.dead)) {
      pool = epoxy_clients[origin] = pool.filter((c) => !c.dead);
    }
    for (let c of pool) { if (c.inFlight < STREAM_CAP) { c.inFlight++; return c; } }
    // Need a new connection: serialize so the length check + push are atomic.
    let created = await with_create_lock(origin, async () => {
      let p = epoxy_clients[origin];
      if (!p) { p = []; epoxy_clients[origin] = p; }
      if (p.some((c) => c.dead)) p = epoxy_clients[origin] = p.filter((c) => !c.dead);
      for (let c of p) { if (c.inFlight < STREAM_CAP) { c.inFlight++; return c; } }
      if (p.length < MAX_CLIENTS) {
        let e = await make_entry();
        p.push(e);
        e.inFlight++;
        return e;
      }
      return null; // still full; caller waits for a slot
    });
    if (created) return created;
    // saturated: wait for a slot, then re-evaluate
    await new Promise((resolve) => {
      (waiters[origin] || (waiters[origin] = [])).push(resolve);
    });
  }
}

// HTTP(S) fetch with one transparent reconnect on connection death.
export async function pooled_fetch(url, options = {}) {
  let origin = safeOrigin(url);
  let entry = await get_client_for(origin);
  try {
    return await with_timeout(entry.client.fetch(url, options), FETCH_TIMEOUT, "fetch " + url);
  } catch (e) {
    entry.dead = true;
    let fresh = await get_client_for(origin);
    if (fresh !== entry) {
      entry = fresh; // retry on a fresh connection
      return await with_timeout(entry.client.fetch(url, options), FETCH_TIMEOUT, "fetch " + url);
    }
    throw e;
  } finally {
    entry.inFlight--;
    signal_waiters(origin);
  }
}

function get_ws(frame_id, ws_id) {
  let frame_websockets = ws_connections[frame_id];
  if (!frame_websockets) return;
  return frame_websockets[ws_id];
}

function push_ws_event(ws_info, name, data) {
  ws_info.events.push([name, data]);
  ws_info.callback?.();
}

//handle fetch api requests
rpc_handlers["fetch"] = async function(url, options) {
  var response = await pooled_fetch(url, options);
  var keys = ["ok", "redirected", "status", "statusText", "type", "url", "raw_headers"];
  var payload = {
    body: await response.blob(),
    headers: [],
    items: {}
  };  
  if (payload.body.type.includes(";")) {
    let mime_type = payload.body.type.split(";")[0].trim();
    payload.body = new Blob([payload.body], {type: mime_type});
  }
  for (let key of keys) {
    payload.items[key] = response[key];
  }
  for (let pair of response.headers.entries()) {
    payload.headers.push(pair);
  }

  return payload
}

//handle websocket creation 
rpc_handlers["ws_new"] = async function (frame_id, url, protocols, options) {
  let ws_id = Math.random() + "";
  let origin = safeOrigin(url);
  let entry = await get_client_for(origin);
  let headers = (options && options.headers) || {};
  let ws_info = {
    ws_promise: null,
    events: [],
    callback: null,
    entry,
    origin
  };
  if (!ws_connections[frame_id]) ws_connections[frame_id] = {};
  ws_connections[frame_id][ws_id] = ws_info;

  let handlers = new EpoxyHandlers(
    () => push_ws_event(ws_info, "open", null),
    () => push_ws_event(ws_info, "close", null),
    (err) => push_ws_event(ws_info, "error", err),
    (data) => push_ws_event(ws_info, "message", data)
  );

  async function open(c) {
    return c.client.connect_websocket(handlers, url, protocols || [], headers);
  }

  // Open on the active client, reconnecting once if the mux died before the
  // socket came up.
  ws_info.ws_promise = open(entry).catch(async (err) => {
    entry.dead = true;
    entry.inFlight--;
    signal_waiters(origin);
    let fresh = await get_client_for(origin);
    ws_info.entry = fresh;
    return open(fresh);
  });
  ws_info.ws_promise.catch((err) => {
    push_ws_event(ws_info, "error", err);
    if (ws_info.entry) { ws_info.entry.inFlight--; signal_waiters(origin); }
  });

  return ws_id;
}

//the frame will call this repeatedly to poll for new events
rpc_handlers["ws_event"] = function (frame_id, ws_id) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info) return null;
  if (ws_info.events.length > 0) {
    let ws_events = ws_info.events;
    ws_info.events = [];
    return ws_events;
  }
  
  return new Promise((resolve) => {
    ws_info.callback = () => {
      resolve(ws_info.events);
      ws_info.events = [];
      ws_info.callback = null;
    }
  })
}

rpc_handlers["ws_send"] = async function (frame_id, ws_id, data) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info) return;
  try {
    let ws = await ws_info.ws_promise;
    let send_data = data;
    if (send_data instanceof Uint8Array) send_data = send_data.buffer;
    await ws.send(send_data);
  } catch (e) {
    push_ws_event(ws_info, "error", e);
  }
}

rpc_handlers["ws_close"] = async function (frame_id, ws_id) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info) return;
  delete ws_connections[frame_id][ws_id];
  if (ws_info.entry) { ws_info.entry.inFlight--; signal_waiters(ws_info.origin); }
  try {
    let ws = await ws_info.ws_promise;
    await ws.close();
  } catch {}
}

//when navigating to a new page we need to close unused connections
export function clean_ws_connections(id_to_clean) {
  let frame_ids = Object.keys(iframes);
  
  for (let [frame_id, frame_websockets] of Object.entries(ws_connections)) {
    if (frame_ids.includes(frame_id) && frame_id !== id_to_clean) continue;
    
    for (let [ws_id, ws_info] of Object.entries(frame_websockets)) {
      delete ws_connections[frame_id][ws_id];
      if (ws_info.entry) { ws_info.entry.inFlight--; signal_waiters(ws_info.origin); }
      if (ws_info.ws_promise) {
        ws_info.ws_promise.then((ws) => ws.close()).catch(() => {});
      }
    }
    
    delete ws_connections[frame_id];
  }
}
