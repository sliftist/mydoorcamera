// Post-build cache-busting. Rewrites the script reference in build-web/index.html
// from `./browser.js` to `./browser.js?v=<contentHash>` so that whenever the
// bundle's contents change, its URL changes too — clients fetch the new file
// instead of serving a stale cached one. The hash is derived from the bundle
// content, so an unchanged build keeps the same query (no needless cache misses).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const buildDir = path.resolve(__dirname, "..", "build-web");
const htmlPath = path.join(buildDir, "index.html");

let html = fs.readFileSync(htmlPath, "utf8");

// Stamp every bundled .js reference with a hash of that file's contents.
html = html.replace(/(\.\/([\w.-]+)\.js)(\?v=[^"']*)?/g, (_m, base, name) => {
    const jsPath = path.join(buildDir, `${name}.js`);
    if (!fs.existsSync(jsPath)) return base; // leave non-emitted refs untouched
    const hash = crypto.createHash("sha256").update(fs.readFileSync(jsPath)).digest("hex").slice(0, 12);
    return `${base}?v=${hash}`;
});

fs.writeFileSync(htmlPath, html);

const refs = [...html.matchAll(/\.\/[\w.-]+\.js\?v=([0-9a-f]+)/g)].map(m => m[0]);
console.log(`[cachebust] ${refs.join(", ") || "(no .js refs found)"}`);
