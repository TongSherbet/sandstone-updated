export * as loader from "./loader.mjs";
export * as network from "./network.mjs";
export * as context from "./context.mjs";
export * as parser from "./parser.mjs";

export * as rpc from "../rpc.mjs";

import * as rpc from "../rpc.mjs";
rpc.set_role("frame");

// report frame errors to the host console for easier debugging
const report = (msg) => {
  try {
    rpc.call_procedure(rpc.host, "frame_error", [msg]).catch(() => {});
  }
  catch {}
};
window.addEventListener("error", (e) => {
  report("ERR: " + e.message + " @ " + (e.filename || "") + ":" + (e.lineno || ""));
});
window.addEventListener("unhandledrejection", (e) => {
  report("REJ: " + ((e.reason && (e.reason.message || e.reason)) || e.reason));
});
