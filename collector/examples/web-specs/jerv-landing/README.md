# Jerv landing shots

`jerv.app`, the public landing page (not `my.jerv.app`, which is the `jerv`
folder). It is one hand-written HTML file with no script, so there is nothing
to sign in to and nothing to mask.

- **Four pages, one file.** `home` is the first screen: the brand mark (inline
  SVG since 2026-11-09) and the hero phone. `ride`, `race` and `numbers` are
  anchors on the same page. Each one scrolls a lazy-loaded phone shot into
  view, because a full-page capture never scrolls and lazy images below the
  fold would come out empty.
- **Reduced motion is on in every capture**, so the CSS scroll reveal and the
  hero's moving dot are off and every capture is the settled page.
- **Chromium only by default.** ultra's executor has no Playwright WebKit
  (2026-11-09), so `webkit` and `mobile-safari` fail every page there. Add
  them in `params.browser` on an executor that has WebKit installed.
- **Each shot is a `<picture>`**: WebP with a JPEG fallback. A blank phone in a
  capture means neither loaded; check `node web/web/tools/verify_assets.mjs
  https://jerv.app` in the jerv repo before reading it as a layout change.

```json
{
  "workload": "web-shots", "executor": "host",
  "suite": { "kind": "playwright", "flows": "jerv-landing" },
  "params": { "browser": ["chromium", "mobile-chrome", "android-device"] },
  "targets": { "url": "https://jerv.app", "executor": "<web executor>" }
}
```
