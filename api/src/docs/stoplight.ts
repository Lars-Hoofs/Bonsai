/**
 * A self-contained HTML page that renders the OpenAPI spec with Stoplight
 * Elements (free, MIT). It loads the Stoplight web component from a CDN and
 * points it at the OpenAPI JSON. To fully self-host (no CDN), vendor
 * `@stoplight/elements` `styles.min.css` + `web-components.min.js` and serve
 * them statically, then swap the two URLs below.
 */
export function stoplightHtml(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bonsai API — Reference</title>
    <link rel="stylesheet" href="https://unpkg.com/@stoplight/elements/styles.min.css" />
    <script src="https://unpkg.com/@stoplight/elements/web-components.min.js"></script>
    <style>
      html, body { height: 100%; margin: 0; }
    </style>
  </head>
  <body>
    <elements-api
      apiDescriptionUrl="${specUrl}"
      router="hash"
      layout="sidebar"
    ></elements-api>
  </body>
</html>`;
}
