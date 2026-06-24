// Build + deploy to the `gh-pages` branch, cross-platform (Node, no bash).
//
// Uses a throwaway git worktree so the gh-pages branch never touches the
// regular working tree. The commit is authored with the user's existing git
// identity and pushed via whatever push config the repo already has.
//
// First-run behaviour: if `gh-pages` doesn't exist on the remote yet, it's
// created as an orphan branch and pushed. GitHub Pages can then select it.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { buildOverlaySnippet } = require("./errorOverlay");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(REPO_ROOT, "build-web");
const PAGES_BRANCH = "gh-pages";

function run(cmd, cwd = REPO_ROOT) {
    console.log(`==> ${cmd}`);
    execSync(cmd, { cwd, stdio: "inherit" });
}

function capture(cmd, cwd = REPO_ROOT) {
    return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

function tryRun(cmd, cwd = REPO_ROOT) {
    try {
        execSync(cmd, { cwd, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function quote(p) {
    return `"${p}"`;
}

function hasTrackedChanges() {
    return !tryRun("git diff --quiet") || !tryRun("git diff --cached --quiet");
}

function cleanupWorktree(dir) {
    tryRun(`git worktree remove ${quote(dir)} --force`);
    fs.rmSync(dir, { recursive: true, force: true });
}

function stripAnsi(s) {
    return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function injectBeforeBodyEnd(html, snippet) {
    return html.includes("</body>")
        ? html.replace("</body>", `${snippet}\n</body>`)
        : html + snippet;
}

function main() {
    // Refuse to deploy a dirty tree — that would put code on gh-pages that
    // doesn't correspond to any commit anyone can later check out.
    if (hasTrackedChanges()) {
        console.error("Refusing to deploy: working tree has uncommitted changes.");
        console.error("Commit them first so the deployed build matches a real commit.");
        console.error(capture("git status --short"));
        process.exit(1);
    }

    const branch = capture("git rev-parse --abbrev-ref HEAD");
    if (branch === "HEAD") {
        console.error("Refusing to deploy from a detached HEAD.");
        process.exit(1);
    }

    // Push the source branch BEFORE building gh-pages, so live code is never
    // ahead of the public source-of-truth branch.
    run(`git push origin ${branch}`);

    // Build, but capture failure instead of aborting, so we can still publish a
    // page that surfaces the error (bottom bar + expandable stack) rather than
    // leaving the deploy silently broken.
    let buildError = "";
    console.log("==> yarn build-web");
    try {
        const out = execSync("yarn build-web", { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" });
        process.stdout.write(out);
    } catch (e) {
        const combined = `${e.stdout || ""}${e.stderr || ""}`;
        process.stdout.write(combined);
        buildError = stripAnsi(combined).trim() || stripAnsi(String(e.message || "Build failed"));
    }

    const indexPath = path.join(BUILD_DIR, "index.html");
    const jsPath = path.join(BUILD_DIR, "browser.js");

    if (buildError) {
        // Compose the served page from the source index.html (so the last good
        // bundle, if present, still loads), cache-busted to the current bundle,
        // with the error overlay injected.
        let html = fs.existsSync(indexPath)
            ? fs.readFileSync(indexPath, "utf8")
            : fs.readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");
        if (fs.existsSync(jsPath)) {
            const hash = crypto.createHash("sha256").update(fs.readFileSync(jsPath)).digest("hex").slice(0, 12);
            html = html.replace(/(\.\/browser\.js)(\?v=[^"']*)?/g, `$1?v=${hash}`);
        }
        html = injectBeforeBodyEnd(html, buildOverlaySnippet(buildError));
        fs.mkdirSync(BUILD_DIR, { recursive: true });
        fs.writeFileSync(indexPath, html);
        console.error("\n*** Build FAILED — deploying a page that surfaces the error. ***\n");
    } else if (!fs.existsSync(indexPath) || !fs.existsSync(jsPath)) {
        console.error("Build output missing — expected build-web/index.html and build-web/browser.js.");
        process.exit(1);
    }

    // Throwaway worktree outside the project so nothing here can accidentally
    // stage gh-pages content into the source branch.
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mydoorcamera-gh-pages-"));
    try {
        const remoteHasPages = tryRun(`git ls-remote --exit-code --heads origin ${PAGES_BRANCH}`);
        if (remoteHasPages) {
            run(`git fetch --no-tags origin ${PAGES_BRANCH}:refs/remotes/origin/${PAGES_BRANCH}`);
            run(`git worktree add -B ${PAGES_BRANCH} ${quote(worktreeDir)} origin/${PAGES_BRANCH}`);
        } else {
            run(`git worktree add --detach ${quote(worktreeDir)}`);
            run(`git checkout --orphan ${PAGES_BRANCH}`, worktreeDir);
            tryRun("git rm -rf .", worktreeDir);
        }

        // Wipe the worktree (except .git) so files removed from the build don't linger.
        for (const entry of fs.readdirSync(worktreeDir)) {
            if (entry === ".git") {
                continue;
            }
            fs.rmSync(path.join(worktreeDir, entry), { recursive: true, force: true });
        }

        // Copy only the artifacts we want served (not stray dev files from build-web/).
        fs.copyFileSync(path.join(BUILD_DIR, "index.html"), path.join(worktreeDir, "index.html"));
        for (const file of fs.readdirSync(BUILD_DIR)) {
            if (file.endsWith(".js")) {
                fs.copyFileSync(path.join(BUILD_DIR, file), path.join(worktreeDir, file));
            }
        }
        const assetsDir = path.join(BUILD_DIR, "assets");
        if (fs.existsSync(assetsDir)) {
            fs.cpSync(assetsDir, path.join(worktreeDir, "assets"), { recursive: true });
        }

        // .nojekyll stops GitHub Pages from running Jekyll (which would hide
        // `_`-prefixed files and rewrite some assets).
        fs.writeFileSync(path.join(worktreeDir, ".nojekyll"), "");

        // Forward CNAME (custom domain) — Pages reads it from the served branch.
        const cnamePath = path.join(REPO_ROOT, "CNAME");
        if (fs.existsSync(cnamePath)) {
            fs.copyFileSync(cnamePath, path.join(worktreeDir, "CNAME"));
        }

        run("git add -A", worktreeDir);
        if (tryRun("git diff --cached --quiet", worktreeDir)) {
            console.log("==> No changes to deploy.");
            return buildError;
        }

        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        run(`git commit -m "Deploy ${timestamp}"`, worktreeDir);
        run(`git push -u origin ${PAGES_BRANCH}`, worktreeDir);

        console.log("");
        console.log(`Pushed to ${PAGES_BRANCH}. After GitHub Pages is enabled on this branch the`);
        console.log("site will be served at:");
        console.log("");
        console.log("  https://mydoorcamera.com/");
    } finally {
        cleanupWorktree(worktreeDir);
    }

    return buildError;
}

// Exit non-zero when the build failed, even though we still published the
// error-surfacing page, so CI / callers know the deploy wasn't clean.
if (main()) {
    process.exit(1);
}
