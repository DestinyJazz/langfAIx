// Handles fields that sit inside an iframe.
//
// Editors such as TinyMCE put the editing area in an iframe that is often only as tall
// as the area itself. A suggestion card drawn inside it would be cut off at the frame's
// edge. So cards are drawn on the outermost page, which needs two things:
//   1. which page is the outermost one
//   2. where our frame sits on it (to convert frame coordinates to page coordinates)
//
// Limit: this only works for same-origin frames; the browser does not allow reaching into
// pages from other sites. Frames created by editors are same-origin, so it is enough.
// For a cross-origin frame the card falls back to being drawn inside the frame.

// Returns { document, offsetX, offsetY }:
//   document          the outermost page that can be reached
//   offsetX, offsetY  our frame's top-left corner in that page's viewport
export function rootContext() {
  let current = window;
  let offsetX = 0;
  let offsetY = 0;

  while (current !== current.top) {
    let frame = null;
    try {
      frame = current.frameElement; // cross-origin: this is null, or throws
    } catch {
      frame = null;
    }
    if (!frame) break;

    const rect = frame.getBoundingClientRect();
    // clientLeft and clientTop are the frame's border widths; its content starts inside the border.
    offsetX += rect.left + frame.clientLeft;
    offsetY += rect.top + frame.clientTop;
    current = current.parent;
  }

  return { document: current.document, offsetX, offsetY };
}
