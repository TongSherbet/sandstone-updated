import * as util from "../../util.mjs";
import * as network from "../network.mjs";
import { convert_url } from "../context.mjs";

const url_regex = /url\(['"]?(.+?)['"]?\)/gm;
const import_regex = /@import\s+(?:url\(['"]?(.+?)['"]?\)|["'](.+?)["'])\s*;?/gm;

//css @import supported via recursive fetch + blob url
export function parse_css(css_str, css_url, depth = 0) {
  let matches = [...css_str.matchAll(url_regex)];
  let import_matches = [...css_str.matchAll(import_regex)];
  if (!matches.length && !import_matches.length) {
    return css_str;
  }

  let requests = {};
  for (let match of matches) {
    let url = match[1];

    if (url.startsWith("data:") || url.startsWith("blob:"))
      continue;
    if (requests[url])
      continue;

    requests[url] = (async () => {
      try {
        let absolute_url = convert_url(url, css_url);
        let response = await network.fetch(absolute_url);
        return [url, await response.blob()];
      } catch {
        return [url, null];
      }
    })();
  }

  for (let match of import_matches) {
    let url = match[1] || match[2];
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) continue;
    if (requests[url]) continue;
    requests[url] = (async () => {
      if (depth >= 5) return [url, null];
      try {
        let absolute_url = convert_url(url, css_url);
        let response = await network.fetch(absolute_url);
        let imported = await response.text();
        let rewritten = await parse_css(imported, absolute_url, depth + 1);
        return [url, new Blob([rewritten], { type: "text/css" })];
      } catch {
        return [url, null];
      }
    })();
  }

  if (!Object.keys(requests).length) {
    return replace_blobs(css_str, {});
  }
  return (async () => {
    let url_contents = await util.run_parallel(Object.values(requests));
    url_contents = url_contents.filter(item => item); //some requests may have failed
    if (!url_contents) return replace_blobs(css_str, {});;
    let blobs = Object.fromEntries(url_contents);
    return replace_blobs(css_str, blobs);
  })();
}

function replace_blobs(css_str, blobs) {
  let count = 0;
  css_str = css_str.replaceAll(url_regex, (match, url) => {
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      return match;
    }
    if (!blobs[url]) {
      return match;
    }

    let new_url = network.create_blob_url(blobs[url], url);
    count++;
    return `url("${new_url}")`;
  });
  css_str = css_str.replaceAll(import_regex, (match, u1, u2) => {
    let url = u1 || u2;
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return match;
    if (!blobs[url]) return match;
    return `@import url("${network.create_blob_url(blobs[url], url)}");`;
  });
  return css_str;
}
