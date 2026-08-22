/**
 * The voice widget loader.
 *
 * Paste the one-liner from the console's Embed page into any site's devtools,
 * or drop this file in a <script> tag. Either way this runs on someone else's
 * page, which drives every decision below.
 *
 * It injects ONE element: an iframe pointing back at this deployment. All the
 * UI, the audio, and the gateway connection live inside that iframe, on our own
 * origin. That is not tidiness — it is the only arrangement that works:
 *
 *   - The recorder AudioWorklet is fetched from an absolute path on our origin.
 *     Rendered into the host page it would resolve against THEIR origin and 404.
 *   - The host page's CSS cannot reach inside an iframe, so the widget looks the
 *     same on every site without a single !important.
 *   - Our own Content-Security-Policy applies inside, not the host's.
 *
 * The iframe is sized to the closed pill so it cannot swallow clicks meant for
 * the page behind it, and resizes on a postMessage from within.
 *
 * No build step, no dependencies, ES5-compatible: it is served as-is and has to
 * run wherever it is pasted.
 */
(function () {
  "use strict";

  // The origin this file was served from — derived from our own <script> tag
  // rather than hardcoded, so the same file works on localhost and in
  // production without being rewritten.
  function findOwnScript() {
    var current = document.currentScript;
    if (current && current.src) return current;
    // document.currentScript is null when appended asynchronously, which is
    // exactly what the console snippet does. Find our tag by name instead.
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var src = scripts[i].src || "";
      if (src.indexOf("/embed.js") !== -1) return scripts[i];
    }
    return null;
  }

  var ownScript = findOwnScript();
  var ORIGIN = null;
  try {
    ORIGIN = ownScript ? new URL(ownScript.src).origin : null;
  } catch {
    /* Report the same safe error below. */
  }
  if (!ORIGIN || !ownScript) {
    console.error("[voice-widget] could not determine where embed.js was served from");
    return;
  }

  var CONTAINER_ID = "voice-ai-widget-frame";
  // Pasting the snippet twice in one console session is normal. Replace rather
  // than stack, so a second paste refreshes instead of leaving two widgets.
  var existing = document.getElementById(CONTAINER_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  // Closed size: the pill, plus room for its drop shadow. The widget paints its
  // own card inside these bounds, so the iframe is only ever as big as the thing
  // actually showing — an oversized transparent frame would swallow clicks meant
  // for the page behind it.
  var mobileCompact = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
  var CLOSED = mobileCompact ? { width: 76, height: 76 } : { width: 262, height: 124 };
  var OPEN = { width: mobileCompact ? Math.min(292, window.innerWidth - 20) : 292, height: 340 };

  function configuredText(attribute) {
    var value = ownScript.getAttribute(attribute);
    return typeof value === "string" ? value.trim().slice(0, 120) : "";
  }

  var params = new URLSearchParams();
  var prompt = configuredText("data-prompt");
  var buttonText = configuredText("data-button-text");
  var title = configuredText("data-title");
  // Which client's agent answers. Validated properly server-side; the shape
  // check here only keeps junk out of the URL.
  var client = configuredText("data-client");
  if (prompt) params.set("prompt", prompt);
  if (buttonText) params.set("buttonText", buttonText);
  if (title) params.set("title", title);
  if (client && /^[a-z0-9][a-z0-9-]{0,62}$/.test(client)) params.set("client", client);
  if (mobileCompact) params.set("mobile", "1");

  var frame = document.createElement("iframe");
  frame.id = CONTAINER_ID;
  frame.src = ORIGIN + "/embed/widget" + (params.toString() ? "?" + params.toString() : "");
  frame.title = title || "Voice assistant";
  // Without this the microphone is blocked inside the iframe regardless of what
  // the user grants. The host page's own Permissions-Policy can still veto it.
  frame.allow = "microphone " + ORIGIN;
  frame.setAttribute("frameborder", "0");
  frame.setAttribute("scrolling", "no");

  // Set individually rather than via cssText so a host page's `iframe { ... }`
  // rule cannot win on specificity; `!important` on each is what makes the
  // widget immune to the CSS of a site we have never seen.
  var style = {
    position: "fixed",
    right: mobileCompact ? "10px" : "16px",
    bottom: mobileCompact ? "10px" : "16px",
    width: CLOSED.width + "px",
    height: CLOSED.height + "px",
    border: "0",
    // Transparent so the pill appears to float on the host page; the widget
    // paints its own rounded card inside.
    background: "transparent",
    // Below a typical modal, above ordinary page content.
    zIndex: "2147483000",
    colorScheme: "normal",
    transition: "width 180ms ease, height 180ms ease",
  };
  for (var property in style) {
    if (Object.prototype.hasOwnProperty.call(style, property)) {
      frame.style.setProperty(
        property.replace(/[A-Z]/g, function (c) {
          return "-" + c.toLowerCase();
        }),
        style[property],
        "important",
      );
    }
  }

  var closed = false;
  function mount() {
    if (!closed && !frame.parentNode) {
      (document.body || document.documentElement).appendChild(frame);
    }
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  function setView(view) {
    if (view === "full") {
      frame.style.setProperty("right", "0", "important");
      frame.style.setProperty("bottom", "0", "important");
      frame.style.setProperty("width", "100vw", "important");
      frame.style.setProperty("height", "100vh", "important");
      return;
    }
    var size = view === "panel" ? OPEN : CLOSED;
    frame.style.setProperty("right", mobileCompact ? "10px" : "16px", "important");
    frame.style.setProperty("bottom", mobileCompact ? "10px" : "16px", "important");
    frame.style.setProperty("width", size.width + "px", "important");
    frame.style.setProperty("height", size.height + "px", "important");
  }

  function command(type) {
    if (frame.contentWindow) {
      frame.contentWindow.postMessage({ source: "voice-ai-host", type: type }, ORIGIN);
    }
  }

  var awaitingFullView = false;
  var api = {
    open: function () {
      closed = false;
      awaitingFullView = true;
      mount();
      setView("full");
      command("open");
    },
    minimize: function () {
      if (closed) return;
      awaitingFullView = false;
      setView("compact");
      command("minimize");
    },
    stop: function () {
      if (closed) return;
      awaitingFullView = false;
      command("stop");
    },
    close: function () {
      closed = true;
      awaitingFullView = false;
      command("stop");
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    },
  };
  window.SeloraXAI = api;
  window.dispatchEvent(new Event("selorax-ai-ready"));

  frame.addEventListener("load", function () {
    if (!awaitingFullView) return;
    setView("full");
    command("open");
    window.setTimeout(function () {
      if (awaitingFullView) command("open");
    }, 50);
  });

  // The widget asks to grow when a call starts and to shrink when it ends.
  // Origin-checked: any page can postMessage to this window, and resizing on an
  // unverified message would hand a hostile script a full-viewport overlay.
  window.addEventListener("message", function (event) {
    if (event.origin !== ORIGIN) return;
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.source !== "voice-ai-widget") return;

    if (data.type === "resize") {
      var nextView = data.view || (data.open ? "panel" : "compact");
      if (awaitingFullView && nextView !== "full") return;
      if (nextView === "full") awaitingFullView = false;
      setView(nextView);
    } else if (data.type === "close") {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    }
  });
})();
