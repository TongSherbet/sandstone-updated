import express from "express";
import morgan from "morgan";

// NOTE: wisp is no longer run on the homelab. The proxy UI is served here as
// static files only; the wisp endpoint is provided by the northstreet CDN
// (wss://cdn.northstreetumc.org/). See example/main.mjs.

const app = express();
const port = process.env.PORT || 5001;
const host = process.env.HOST || "0.0.0.0";

app.use(morgan("combined"));
app.use(express.static("./"));

const server = app.listen(port, host, () => {
  console.log(`Listening on: ${host}:${port}`);
});
