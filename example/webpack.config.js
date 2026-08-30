const webpack = require("webpack");
const { execSync } = require("child_process");

const pkg = require("../package.json");
let git_hash = "";
try {
  git_hash = execSync("git rev-parse --short HEAD").toString().trim();
} catch {}

module.exports = {
  name: "sandstone_frontend",
  entry: "./main.mjs",
  output: {
    filename: "sandstone_frontend.js"
  },
  module: {
    rules: [
      {
        resource: /resources\/.+\.html$/,
        type: "asset/source"
      },
      {
        // the host bundle embeds the prebuilt frame bundle as a string
        resource: /dist\/sandstone_frame\.js$/,
        type: "asset/source"
      },
      {
        // inline wasm (epoxy-tls + scramjet rewriter) as base64 data URIs,
        // resolved from the real node_modules location
        test: /\.wasm$/,
        type: "asset/inline"
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      __VERSION__: JSON.stringify(pkg.version),
      __GIT_HASH__: JSON.stringify(git_hash),
    }),
  ],
  mode: "development"
};
