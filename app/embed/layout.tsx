/**
 * Layout for the embedded widget.
 *
 * Deliberately outside the (console) group: this renders inside an iframe on
 * somebody else's site, so it gets no sidebar, no save bar, and no agent-config
 * provider.
 *
 * The one job here is transparency, and it takes more than a transparent div.
 * globals.css paints `--bg: #f4f5fa` on BOTH `html` and `body`, adds a
 * full-bleed `body::before` gradient on top, and declares `color-scheme: light`
 * on `:root`. Any one of those leaves a pale grey rectangle around the card
 * instead of letting it float on the host page, so each is undone explicitly:
 *
 *   - `background` on :root/html/body, with !important, since globals.css sets
 *     it on element selectors that would otherwise tie or win.
 *   - `body::before` and `::after`, which paint regardless of the background.
 *   - `color-scheme: normal`. Under `light`, the browser composites an opaque
 *     canvas behind the document even when the background is transparent —
 *     which is the one that survives fixing only the backgrounds.
 */

const TRANSPARENT = `
:root, html, body {
  background: transparent !important;
  background-color: transparent !important;
  color-scheme: normal !important;
}
html, body {
  min-height: 0 !important;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}
body::before, body::after {
  display: none !important;
  content: none !important;
  background: none !important;
}
`;

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{TRANSPARENT}</style>
      <div className="h-full w-full overflow-hidden" style={{ background: "transparent" }}>
        {children}
      </div>
    </>
  );
}
