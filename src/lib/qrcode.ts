/**
 * Thin wrapper around `qrcode-generator` (2.0.4, ~15kb, zero deps).
 * We use it for the bracket QR codes (v3.6) — every planned match
 * gets a stable QR pointing at `?planned=<mid>` on the score URL.
 *
 * Two output flavours:
 *   - `qrToSVG(text)`: inline SVG string. Sharp at any size — used
 *     by the print sheet where the QR needs to scale up for
 *     board stickers. Also fine for inline preview at 64-128px.
 *   - `qrToDataUri(text)`: `data:image/svg+xml;base64,...` string.
 *     Handy when a caller wants `<img src=...>` semantics rather
 *     than SVG-in-DOM.
 *
 * Error correction level Q (25%) — a good balance for print use
 * where the sticker might get scuffed. Type-number 0 = auto-fit
 * to the payload length.
 *
 * The `qrcode-generator` API is old-school (constructor + method
 * chain), so this file provides the sane ES-module façade the
 * rest of the app uses.
 */

/** Build a scalable SVG string for a QR code. Set `size` to control
 *  the top-level width/height in pixels; the viewBox stays square. */
export async function qrToSVG(text: string, size = 200): Promise<string> {
  const mod = await import('qrcode-generator');
  // The default export is the factory. Type-number 0 = auto-fit.
  // Error correction 'Q' = 25% — resilient enough for print use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory = (mod as any).default ?? mod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qr = factory(0, 'Q') as any;
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount() as number;
  // Cell size (in SVG units). We use `1` and let the viewBox handle
  // the pixel scale, so the SVG stays crisp when the container resizes.
  const cell = 1;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${modules} ${modules}" shape-rendering="crispEdges" aria-label="QR code">`,
  );
  // White background — required for a scanable QR under a printed
  // sticker or a dark webpage.
  parts.push(`<rect width="${modules}" height="${modules}" fill="#ffffff"/>`);
  // Dark modules as one big path so the SVG stays small — one <path>
  // instead of one <rect> per module (typical QRs have 400-1200
  // modules, so per-rect output balloons).
  let d = '';
  for (let r = 0; r < modules; r += 1) {
    for (let c = 0; c < modules; c += 1) {
      if (qr.isDark(r, c)) {
        d += `M${c} ${r}h${cell}v${cell}h-${cell}z`;
      }
    }
  }
  parts.push(`<path d="${d}" fill="#000000"/>`);
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Build a base64-encoded data URI for a QR code. Use this when a
 * caller wants an `<img src=...>` — SVG-in-DOM is preferable for
 * inline sharpness, but data URIs are simpler to slot into
 * `<img>` tags for print stylesheets that already scope by tag.
 */
export async function qrToDataUri(text: string, size = 200): Promise<string> {
  const svg = await qrToSVG(text, size);
  // btoa handles ASCII fine; QR SVG content is pure ASCII by
  // construction (no user-supplied UTF-8 in the path data).
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
