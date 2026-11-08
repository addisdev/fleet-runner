# Jerv web shots

`my.jerv.app`'s owner-only ride panel, signed in, and the same link signed out.

- **Account:** the job names it in `suite.credentials.account`. The password
  comes from the executor's login Keychain (service `fleet-ui-test`), never
  from this folder or the job spec.
- **Ride 246** is the showcase rider's 19.8 km bike ride of 2026-08-24, with
  126 cells, so the panel draws streets. Its newer rides have no cells and
  show numbers only. The `#ride=` route only opens a ride on the first page of
  the list (50 rides), so pick another one if 246 falls off it.
- **Reduced motion is on in every capture**, so Jerv draws the ride complete
  in one frame and shows no Replay button (`ride.js`). `settle_ms` covers the
  basemap tiles, which wait up to 8 s.
- **Signed out**, `#ride=` shows the sign-in form and no `#ride-map`.

```json
{
  "workload": "web-shots", "executor": "host",
  "suite": { "kind": "playwright", "flows": "jerv",
             "credentials": { "account": "jerv-showcase-showcase-42@example.com" } },
  "targets": { "url": "https://my.jerv.app", "executor": "<web executor>" }
}
```
