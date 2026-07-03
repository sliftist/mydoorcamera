// Post-build copy of root-level static files into build-web/. The build-web bundler
// only handles index.html, the JS bundles, and an assets/ folder — anything else
// served from the site root has to be listed here.

const fs = require("fs");
const path = require("path");

const STATIC_FILES = ["favicon.svg"];

const repoRoot = path.resolve(__dirname, "..");
const buildDir = path.join(repoRoot, "build-web");

for (const file of STATIC_FILES) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(buildDir, file));
}
console.log(`[static] copied ${STATIC_FILES.join(", ")}`);
