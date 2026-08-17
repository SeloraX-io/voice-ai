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
  function selfOrigin() {
    var current = document.currentScript;
    if (current && current.src) {
      try {
        return new URL(current.src).origin;
      } catch {
        /* Malformed src; fall through to the tag scan below. */
      }
    }
    // document.currentScript is null when appended asynchronously, which is
    // exactly what the console snippet does. Find our tag by name instead.
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var src = scripts[i].src || "";
      if (src.indexOf("/embed.js") !== -1) {
        try {
          return new URL(src).origin;
        } catch {
          /* Malformed src; keep looking. */
        }
      }
    }
    return null;
  }

  var ORIGIN = selfOrigin();
  if (!ORIGIN) {
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
  var CLOSED = { width: 262, height: 124 };
  var OPEN = { width: 292, height: 340 };

  var frame = document.createElement("iframe");
  frame.id = CONTAINER_ID;
  frame.src = ORIGIN + "/embed/widget";
  frame.title = "Voice assistant";
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
    right: "16px",
    bottom: "16px",
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

  function mount() {
    (document.body || document.documentElement).appendChild(frame);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  // The widget asks to grow when a call starts and to shrink when it ends.
  // Origin-checked: any page can postMessage to this window, and resizing on an
  // unverified message would hand a hostile script a full-viewport overlay.
  window.addEventListener("message", function (event) {
    if (event.origin !== ORIGIN) return;
    var data = event.data;
    if (!data || data.source !== "voice-ai-widget") return;

    if (data.type === "resize") {
      var size = data.open ? OPEN : CLOSED;
      frame.style.setProperty("width", size.width + "px", "important");
      frame.style.setProperty("height", size.height + "px", "important");
    } else if (data.type === "close") {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    }
  });
})();
