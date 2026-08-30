import { rewrite_js as fallback_rewrite_js } from "./parser-fallback.mjs";
import { setWasm, rewriteJsInner } from "./rewrite/oxc/rewriter.mjs";

// rewrite config for the scramjet (oxc) rewriter — helper names must match
// the shims installed in src/frame/scramjet.mjs
const globals = {
  wrapfn: "$scramjet$wrap",
  wrappropertybase: "$scramjet__",
  wrappropertyfn: "$scramjet$prop",
  cleanrestfn: "$scramjet$clean",
  importfn: "$scramjet$import",
  rewritefn: "$scramjet$rewrite",
  wrappostmessagefn: "$scramjet$wrappostmessage",
  metafn: "$scramjet$meta",
  pushsourcemapfn: "$scramjet$pushsourcemap",
  trysetfn: "$scramjet$tryset",
  templocid: "$scramjet$temploc",
  tempunusedid: "$scramjet$tempunused",
};

const flags = {
  sourcemaps: true,
  captureErrors: false,
  scramitize: false,
  disableComputedWrap: false,
  destructureRewrites: true,
  allowInvalidJs: true,
};

let wasm_ready = false;
let page_base = "about:blank";

//set the base url of the proxied page, used for URL resolution in rewrites
export function set_base(base) {
  page_base = base;
}

// initialize the oxc wasm rewriter. `module` is a WebAssembly.Module (or
// bytes) delivered from the host. Falls back to the meriyah rewriter on failure.
export function init(module) {
  try {
    setWasm(module);
    // smoke test to force wasm instantiation
    rewrite_js("console.log('scramjet rewriter smoke test');");
    wasm_ready = true;
  }
  catch (e) {
    console.error("failed to initialize scramjet rewriter, falling back to meriyah:", e);
    wasm_ready = false;
  }
  globalThis.__REWRITER_MODE__ = wasm_ready ? "oxc" : "meriyah";
  return wasm_ready;
}

export function using_wasm() {
  return wasm_ready;
}

export function rewrite_js(js, url = null, options = {}) {
  if (!wasm_ready)
    return fallback_rewrite_js(js);

  try {
    let env = {
      config: { globals: globals, flags: flags },
      prefix: { pathname: "/" },
      interface: {
        //strings are left untouched — sandstone intercepts network at runtime
        codecEncode: (input) => input,
      },
    };
    let meta = { base: new URL(options.base || page_base) };
    let output = rewriteJsInner(js, url || "(inline)", env, meta, !!options.module);
    let rewritten = typeof output.js === "string" ? output.js : new TextDecoder().decode(output.js);
    return rewritten;
  }
  catch (e) {
    console.warn("scramjet rewrite failed, falling back to meriyah:", e.message);
    return fallback_rewrite_js(js);
  }
}
