import * as network from "./network.mjs";
import * as polyfill from "./polyfill/index.mjs";
import * as parser from "./parser.mjs";
import * as loader from "./loader.mjs";

import { ctx, run_script } from "./context.mjs";

// runtime shims for the scramjet (oxc) JS rewriter output.
// the rewriter emits $scramjet$* helper references and $scramjet__* property
// renames; these must exist as globals in the sandboxed frame before any
// rewritten script runs.

const real_location = globalThis.location;
const real_eval = globalThis.eval;

export function install() {
  // --- $scramjet$wrap: value wrapper for the unsafe globals ---
  globalThis.$scramjet$wrap = (value) => {
    if (value === real_location) return ctx.location;   // real location -> FakeLocation
    if (value === real_eval) return run_script;         // real eval -> rewriting eval boundary
    if (value === globalThis.parent) return ctx.parent;
    if (value === globalThis.top) return ctx.top;
    return value;
  };

  // --- $scramjet$tryset: intercept assignment to `location` (e.g. `location = url`) ---
  globalThis.$scramjet$tryset = (name, op, value) => {
    if (name === real_location && op === "=") {
      ctx.location.assign(String(value));
      return true;
    }
    return false; // let the fallback assignment happen (e.g. a local `var location`)
  };

  // --- $scramjet$prop: map computed member keys back to the renamed properties ---
  globalThis.$scramjet$prop = (key) => {
    if (key === "location" || key === "parent" || key === "top" || key === "eval")
      return "$scramjet__" + key;
    return key;
  };

  // --- $scramjet$clean: rest-binding cleanup (no-op; temp vars are harmless) ---
  globalThis.$scramjet$clean = () => {};

  // --- $scramjet$rewrite: eval() string rewriting (returns the rewritten source) ---
  globalThis.$scramjet$rewrite = (js) => parser.rewrite_js(String(js));

  // --- $scramjet$meta: import.meta.url ---
  globalThis.$scramjet$meta = (meta, base) => ({ url: base });

  // --- $scramjet$wrappostmessage: payload wrapper (sandbox isolates messages) ---
  globalThis.$scramjet$wrappostmessage = (obj) => obj;

  // --- $scramjet$pushsourcemap: source-map emission (noop; we don't ship maps) ---
  globalThis.$scramjet$pushsourcemap = () => {};

  // --- $scramjet$import: dynamic import via host fetch + blob URL ---
  // webpackIgnore keeps this a native import() (webpack would otherwise treat
  // it as a chunk load and fail on blob: URLs)
  globalThis.$scramjet$import = async (base, url) => {
    let abs = new URL(url, base).href;
    let response = await network.fetch(abs);
    let code = await response.text();
    let rewritten = parser.rewrite_js(code, abs, { module: true });
    let blob = new Blob([rewritten], { type: "text/javascript" });
    let blob_url = URL.createObjectURL(blob);
    return import(/* webpackIgnore: true */ blob_url);
  };

  // --- renamed property accessors on Object.prototype ---
  let windowish = (obj) => obj === globalThis || obj === ctx.__proxy__;

  Object.defineProperty(Object.prototype, "$scramjet__location", {
    get() {
      if (windowish(this) || this instanceof Document) return ctx.location;
      if (this === ctx.location) return this;
      return this.location;
    },
    set(value) {
      if (windowish(this) || this instanceof Document) {
        ctx.location.assign(String(value));
        return;
      }
      this.location = value;
    },
    configurable: true,
  });

  Object.defineProperty(Object.prototype, "$scramjet__parent", {
    get() {
      if (windowish(this)) return ctx.parent;
      return this.parent;
    },
    configurable: true,
  });

  Object.defineProperty(Object.prototype, "$scramjet__top", {
    get() {
      if (windowish(this)) return ctx.top;
      return this.top;
    },
    configurable: true,
  });

  Object.defineProperty(Object.prototype, "$scramjet__eval", {
    get() {
      if (windowish(this)) return run_script;
      return this.eval;
    },
    configurable: true,
  });

  // --- window accessors: the oxc rewriter leaves `window`/`document`/etc.
  // identifiers alone, so interception happens at the property level instead ---
  function define_window_accessor(name, getter) {
    try {
      Object.defineProperty(globalThis, name, {
        get: getter,
        set: (value) => {
          // standard assignment semantics: shadow the accessor with an own property
          Object.defineProperty(globalThis, name, {
            value: value,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        },
        configurable: true,
      });
    }
    catch (e) {
      // non-configurable (e.g. document in a sandboxed frame) — leave the real one
    }
  }

  // `document` is non-configurable on window in sandboxed frames, so the
  // sensitive properties are intercepted on Document.prototype instead.
  function define_document_prop(name, getter, setter) {
    try {
      Object.defineProperty(Document.prototype, name, {
        get: getter,
        set: setter || (() => {}),
        configurable: true,
      });
    }
    catch (e) {}
  }

  define_document_prop("cookie", () => "", () => {});
  define_document_prop("URL", () => ctx.location.href);
  define_document_prop("documentURI", () => ctx.location.href);
  define_document_prop("baseURI", () => ctx.location.href);
  define_document_prop("location", () => ctx.location, (value) => ctx.location.assign(String(value)));

  define_window_accessor("origin", () => ctx.origin);
  define_window_accessor("history", () => ctx.history);
  define_window_accessor("localStorage", () => ctx.localStorage);
  define_window_accessor("sessionStorage", () => ctx.sessionStorage);
  define_window_accessor("fetch", () => polyfill.fetch);
  define_window_accessor("URL", () => polyfill.FakeURL);
  define_window_accessor("Worker", () => polyfill.FakeWorker);
  define_window_accessor("XMLHttpRequest", () => polyfill.FakeXMLHttpRequest);
  define_window_accessor("WebSocket", () => network.WebSocket);
  define_window_accessor("importScripts", () => undefined);
}
