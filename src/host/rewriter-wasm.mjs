// loads the scramjet rewriter wasm on the host side.
// NOTE: we transfer raw BYTES to frames, not a compiled WebAssembly.Module —
// Modules cannot be structured-cloned across process boundaries, and the
// sandboxed frame is always a separate (OOPIF) process.
import wasm_data from "./scramjet-rewriter.wasm";

let cached_bytes = null;

export function get_rewriter_bytes() {
  if (cached_bytes) return cached_bytes;
  let b64 = wasm_data.split(",")[1];
  let binary = atob(b64);
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  cached_bytes = bytes;
  return cached_bytes;
}
