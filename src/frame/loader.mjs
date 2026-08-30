import * as rpc from "../rpc.mjs";
import * as rewrite from "./rewrite/index.mjs";
import * as network from "./network.mjs";
import * as parser from "./parser.mjs";
import * as scramjet from "./scramjet.mjs";

import { update_ctx, run_script, run_script_safe, ctx, convert_url } from "./context.mjs";
import { pending_scripts } from "./rewrite/script.mjs";

export const navigate = rpc.create_rpc_wrapper(rpc.host, "navigate");
export const local_storage = rpc.create_rpc_wrapper(rpc.host, "local_storage");

export const runtime_src = self.document?.currentScript?.innerHTML;
export let url; //the proxied page url
export let frame_id; //the current frame id
export let frame_html; //the html for the frame runtime
export let version; //the sandstone version
export let is_loaded = false;
export let is_iframe = false;
export let site_settings = {};
export let default_settings = {};

function eval_script(script_element, script_text) {
  ctx.document.currentScript = script_element;
  let script = document.createElement("script");
  script.__rewritten__ = true;
  try {
    let rewritten_js = parser.rewrite_js(script_text, url || ctx.location.href);
    script.innerHTML = rewritten_js;
    document.body.append(script);
  }
  catch (e) {
    console.error(e);
  }
  script.remove();
  ctx.document.currentScript = null;
  script_element.dispatchEvent(new Event("load"));
}

// Evaluate a single combined <script> (one shared scope for all synchronous
// page scripts so cross-script globals like `var writeEmbed` / jQuery `$`
// resolve — the oxc rewriter otherwise isolates each script in its own scope).
function eval_combined(representative_element, combined_text) {
  ctx.document.currentScript = representative_element;
  let script = document.createElement("script");
  script.__rewritten__ = true;
  try {
    let rewritten_js = parser.rewrite_js(combined_text, url || ctx.location.href);
    script.innerHTML = rewritten_js;
    document.body.append(script);
  }
  catch (e) {
    console.error(e);
  }
  script.remove();
  ctx.document.currentScript = null;
}

function evaluate_scripts() {
  pending_scripts.sort((a, b) => a[0] - b[0]);
  let deferred = [];
  let sync = [];
  for (let [num, script_element, script_text] of pending_scripts) {
    if (script_element.defer || script_element.async) {
      deferred.push([script_element, script_text])
    }
    else {
      sync.push([num, script_element, script_text]);
    }
  }
  pending_scripts.length = 0;

  // browsers run every classic <script> in one shared global scope, so a
  // `var`/`function` declared in one script is visible to the next. the oxc
  // rewriter wraps each script in its own isolated scope, which breaks sites
  // that rely on this (youtube's `writeEmbed`, ip.me's jQuery `$`). concatenate
  // the synchronous scripts into a single scope; wrap each in try/catch so a
  // throw in one doesn't abort the others (preserves per-script error isolation).
  if (sync.length) {
    let combined = sync.map(([num, el, text]) =>
      "try{\n" + (text || "").replace(/<\/script>/gi, "<\/script>") + "\n}catch(e){console.error('[script]', e)}"
    ).join("\n;\n");
    try {
      eval_combined(sync[0][1], combined);
    }
    catch (e) {
      // a syntax error in one script would otherwise break the whole combined
      // scope; fall back to running each classic script on its own (cross-script
      // globals may then fail, but the page still renders).
      console.warn("[scripts] combined eval failed, running per-script:", e);
      for (let [num, el, text] of sync) {
        try { eval_script(el, text); } catch (_) {}
      }
    }
    for (let [num, el] of sync) el.dispatchEvent(new Event("load"));
  }

  for (let [script_element, script_text] of deferred) {
    eval_script(script_element, script_text);
  }
}

export function set_frame_id(id) {
  frame_id = id;
}
export function set_url(_url) {
  url = _url;
}

function get_frame_html() {
  let html = document.documentElement.outerHTML;
  let doctype = new XMLSerializer().serializeToString(document.doctype);
  frame_html = doctype + html;
}

async function load_html(options) {
  version = options.version;
  is_iframe = options.is_iframe || false;
  default_settings = options.default_settings;
  site_settings = {...default_settings, ...options.settings};
  network.known_urls[location.href] = options.url;
  network.enable_network();

  set_url(options.url);
  set_frame_id(options.frame_id);
  get_frame_html();
  update_ctx();
  scramjet.install();
  rewrite.install_media_interception();
  parser.set_base(options.url);
  parser.init(options.wasm);

  if (options.error) {
    document.getElementById("loading_text").style.display = "none";
    document.getElementById("error_div").style.display = "initial";
    document.getElementById("error_msg").innerText = options.error;
    document.getElementById("version_text").innerText = `Sandstone v${version.ver} (${version.hash})`;
    return;
  }

  //load local storage
  if (options.local_storage) {
    for (let [key, value] of options.local_storage) {
      ctx.localStorage.setItem(key, value);
    }
  }

  let dom_parser = new DOMParser();
  let html = dom_parser.parseFromString(options.html, "text/html");  
  
  //rewrite all html elements
  await rewrite.element(html.documentElement);

  //add handler for navigation
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    let element = event.target;
    while (element && !(element instanceof HTMLAnchorElement)) {
      element = element.parentElement;
    }
    if (!element) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (element.href.startsWith("javascript:")) {
      let original_js = element.href.replace("javascript:", "");
      run_script_safe(original_js)
    }
    else {
      let original_href = convert_url(element.href, ctx.location.href);
      let url = new URL(original_href);
      if (url.pathname === location.pathname) {
        let element_id = url.hash.substring(1);
        let element = document.getElementById(element_id);
        if (element) element.scrollIntoView({behavior: "instant"});
        return;
      }
      navigate(frame_id, original_href);  
    }
  });

  //parse elements with ids and add them to the scope
  let id_elements = html.querySelectorAll("*[id]");
  let ctx_proto = Object.getPrototypeOf(ctx);
  for (let i = 0; i < id_elements.length; i++) {
    let element = id_elements[i];
    if (ctx_proto.hasOwnProperty(element.id)) continue;
    ctx[element.id] = element;
  }

  //apply the rewritten html
  console.log("done downloading page");
  document.documentElement.replaceWith(html.documentElement);
  if (site_settings.allow_js) {
    evaluate_scripts();
  }

  //trigger load events
  is_loaded = true;
  ctx.document.dispatchEvent(new Event("DOMContentLoaded"));
  ctx.document.dispatchEvent(new Event("readystatechange"));
  ctx.document.dispatchEvent(new Event("load"));
  ctx.window.dispatchEvent(new Event("load"));
}

async function get_favicon() {
  var favicon_url = "/favicon.ico";
  var link_elements = document.getElementsByTagName("link");
  for (var i = 0; i < link_elements.length; i++) {
    let link = link_elements[i];
    if (link.getAttribute("rel") === "icon") 
      favicon_url = link.getAttribute("href");
    if (link.getAttribute("rel") === "shortcut icon") 
      favicon_url = link.getAttribute("href");
  }

  let full_url = new URL(favicon_url, ctx.location.href);
  return full_url.href;
}

function external_eval(js) {
  return run_script(js);
}

rpc.rpc_handlers["html"] = load_html;
rpc.rpc_handlers["favicon"] = get_favicon;
rpc.rpc_handlers["eval"] = external_eval;