// Builds a self-contained HTML snippet (style + markup + script) that renders a
// dismissible, expandable "Deploy failed" bar pinned to the bottom of the page.
// The deploy script injects this before </body> when a build fails, so the live
// site surfaces the error instead of silently shipping (or not shipping) a broken
// build. Collapsed: one-line message + ✕. Click the bar to expand the full call
// stack; click ✕ to dismiss.

function buildOverlaySnippet(errorText) {
    // Embed safely as a JS string; escape `<` so a stray "</script>" in the
    // error text can't break out of the inline script.
    const payload = JSON.stringify(String(errorText || "")).replace(/</g, "\\u003c");
    return `
<style>
  #__deploy_err { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  #__deploy_err pre { margin: 0; max-height: 45vh; overflow: auto; padding: 12px 14px;
    background: #1a0606; color: #fecaca; font-size: 12px; line-height: 1.45;
    white-space: pre-wrap; word-break: break-word; border-top: 1px solid #b91c1c; }
  #__deploy_err .__bar { display: flex; align-items: center; gap: 10px; cursor: pointer;
    background: #7f1d1d; color: #fff; padding: 10px 14px; font-size: 13px; }
  #__deploy_err .__msg { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  #__deploy_err .__hint { flex: 0 0 auto; opacity: .7; font-size: 11px; white-space: nowrap; }
  #__deploy_err .__x { flex: 0 0 auto; border: none; background: transparent; color: #fff;
    font-size: 18px; line-height: 1; cursor: pointer; padding: 0 4px; }
</style>
<div id="__deploy_err" hidden>
  <pre class="__stack" hidden></pre>
  <div class="__bar">
    <span class="__msg"></span>
    <span class="__hint">click to expand</span>
    <button class="__x" title="Dismiss" aria-label="Dismiss">&times;</button>
  </div>
</div>
<script>
(function () {
  var err = ${payload};
  if (!err) return;
  var root = document.getElementById("__deploy_err");
  var bar = root.querySelector(".__bar");
  var msg = root.querySelector(".__msg");
  var hint = root.querySelector(".__hint");
  var stack = root.querySelector(".__stack");
  var x = root.querySelector(".__x");
  msg.textContent = "\\u26A0 Deploy failed: " + (err.split("\\n")[0] || "build error");
  stack.textContent = err;
  root.hidden = false;
  bar.addEventListener("click", function (e) {
    if (e.target === x) return;
    var willShow = stack.hidden;
    stack.hidden = !willShow;
    hint.textContent = willShow ? "click to collapse" : "click to expand";
  });
  x.addEventListener("click", function (e) { e.stopPropagation(); root.remove(); });
})();
</script>`;
}

module.exports = { buildOverlaySnippet };
