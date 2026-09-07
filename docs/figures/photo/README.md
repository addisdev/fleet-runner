# photo/

Photographs the generated assets are built on. One file is expected here:

| File | Used by |
|---|---|
| `shelf.jpg` | `figures/shelf-banner.html` → `img/shelf-banner.jpg`, and `figures/shelf-social.html` → `img/shelf-social.jpg` |

Both figures declare `data-requires="photo/shelf.jpg"`, so `npm run assets`
skips them with a message while the file is absent rather than rendering a hole
where the picture should be. Drop the photograph in, run the renderer, and the
two images appear.

The shot guide — framing, light, what has to be on the screens, and what to
change in the README afterwards — is in
[`docs/brand.md`](../../brand.md#the-shelf-photograph).
