import { ctx, convert_url } from "../context.mjs";
import * as network from "../network.mjs";
import * as util from "../../util.mjs";
import { rewrite_iframe } from "./iframe.mjs";

// Per-element sandbox state: element -> original (proxied) src string.
// The getter returns this so reading `img.src` still yields the real target
// URL (matching the rest of the proxy), while the actual network request is
// routed through the sandbox and the native `src` holds a blob URL.
const media_state = new WeakMap();

// native setAttribute, captured at install time so proxy_srcset can write the
// final blob srcset without re-triggering the override (which would recurse).
let native_setAttribute;

// Set the *native* `src` on an element without re-triggering our setter.
function set_native_src(element, value, native_desc) {
  if (native_desc && native_desc.set) native_desc.set.call(element, value);
  else element.src = value;
}

async function fetch_src(element, value, native_desc) {
  element.setAttribute("__src", value);
  media_state.set(element, String(value));

  let proxied = convert_url(String(value), ctx.location.href);
  try {
    let response = await network.fetch(proxied);
    let blob = await response.blob();
    let blob_url = URL.createObjectURL(blob);
    set_native_src(element, blob_url, native_desc);

    // a <source> inside a media element needs an explicit reload to pick up
    // the new blob url
    if (element instanceof HTMLSourceElement) {
      let parent = element.parentNode;
      while (parent && !(parent instanceof HTMLMediaElement))
        parent = parent.parentNode;
      if (parent) {
        parent.load();
        if (!parent.autoplay) return;
        parent.play();
      }
    }
  }
  catch (e) {
    // proxy fetch failed — leave the element broken rather than leak the real
    // url by loading it directly
    media_state.delete(element);
    set_native_src(element, "", native_desc);
  }
}

// Build a getter/setter pair that wraps the native `src` descriptor so that
// every assignment (property or via setAttribute) is routed through the
// sandbox. Installed once on the media prototypes.
function make_src_descriptor(native_desc) {
  return {
    configurable: true,
    get() {
      let mapped = media_state.get(this);
      if (mapped !== undefined) return mapped;
      return native_desc.get.call(this);
    },
    set(value) {
      if (value === null || value === undefined || !util.url_is_http(String(value))) {
        media_state.delete(this);
        return native_desc.set.call(this, value);
      }
      // route the request through the sandbox
      let str = String(value);
      media_state.set(this, str);
      // clear the native src immediately so the browser never issues a direct
      // request to the real origin
      native_desc.set.call(this, "");
      fetch_src(this, str, native_desc);
    }
  };
}

// srcset contains a list of `url descriptor` pairs; proxy each http(s) url to
// a blob so responsive images load through the sandbox (matches scramjet, which
// rewrites srcset rather than dropping it).
function parse_srcset(value) {
  return value.split(",").map((part) => {
    let segs = part.trim().split(/\s+/);
    return { url: (segs[0] || "").trim(), descriptor: segs.slice(1).join(" ") };
  }).filter((p) => p.url);
}

async function proxy_srcset(element) {
  let value = element.getAttribute("srcset");
  if (!value) return;
  let parts = parse_srcset(value);
  let unique = [...new Set(parts.map((p) => p.url))];
  let map = {};
  await util.run_parallel(unique.map(async (u) => {
    if (!util.url_is_http(u)) { map[u] = u; return; }
    try {
      let proxied = convert_url(u, ctx.location.href);
      let response = await network.fetch(proxied);
      let blob = await response.blob();
      map[u] = URL.createObjectURL(blob);
    } catch {
      map[u] = "";
    }
  }));
  let new_srcset = parts
    .map((p) => (map[p.url] ? map[p.url] : p.url) + (p.descriptor ? " " + p.descriptor : ""))
    .join(", ");
  native_setAttribute.call(element, "srcset", new_srcset);
}

let installed = false;

export function install_media_interception() {
  if (installed) return;
  installed = true;

  const protos = [
    window.HTMLImageElement && HTMLImageElement.prototype,
    window.HTMLSourceElement && HTMLSourceElement.prototype,
    window.HTMLMediaElement && HTMLMediaElement.prototype,
    window.HTMLInputElement && HTMLInputElement.prototype,
  ];
  for (let proto of protos) {
    if (!proto) continue;
    let desc = Object.getOwnPropertyDescriptor(proto, "src");
    if (!desc) continue;
    Object.defineProperty(proto, "src", make_src_descriptor(desc));
  }

  // setAttribute("src", ...) bypasses the IDL `src` setter (it writes the
  // content attribute directly), so we re-route media `src`/`srcset` through
  // our setter. srcset is cleared because it cannot be proxied cheaply.
  native_setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === "src") {
      if (this instanceof HTMLImageElement ||
          this instanceof HTMLSourceElement ||
          this instanceof HTMLMediaElement ||
          (this instanceof HTMLInputElement && this.type === "image")) {
        this.src = value;
        return;
      }
    }
    if (name === "srcset" && this instanceof HTMLImageElement) {
      proxy_srcset(this);
      return;
    }
    return native_setAttribute.call(this, name, value);
  };

  // innerHTML / insertAdjacentHTML / replaceChildren insert media without ever
  // calling our setter, so catch them with a MutationObserver and re-trigger.
  if (typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver((mutations) => {
      for (let mutation of mutations) {
        for (let node of mutation.addedNodes) {
          process_node(node);
        }
      }
    });
    function process_node(node) {
      if (!(node instanceof Element) || node.__media_observed__) return;
      node.__media_observed__ = true;
      if (node.matches("img, source, video, audio, input[type='image']")) {
        let src = node.getAttribute("src");
        if (src && util.url_is_http(src)) node.src = src;
        if (node.getAttribute("srcset")) proxy_srcset(node);
      }
      // dynamically-created iframes must be proxied the same way parsed ones
      // are (the proxy only rewrote iframes during the initial parse pass).
      else if (node.matches("iframe")) {
        // strip sandbox so the nested frame can run the proxied runtime
        if (node.hasAttribute("sandbox")) node.removeAttribute("sandbox");
        rewrite_iframe(node);
      }
      for (let child of node.children) process_node(child);
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

// Called during the initial parse pass on each media element. Re-triggering
// the (now prototype-level) setter is enough; the MutationObserver also
// catches the subtree once it is inserted into the live document.
export async function rewrite_media(media_element) {
  let src = media_element.getAttribute("src");
  if (src && util.url_is_http(src)) {
    media_element.src = src;
  }
  if (media_element.getAttribute("srcset")) {
    await proxy_srcset(media_element);
  }
}
