# Authentication and the remote MCP gateway

Off by default. A collector on a home LAN or a tailnet keeps the posture this
project has always had: [the network is the access
control](index.md#binding-and-exposure). Turn tokens on when something beyond
the house can reach the collector: a corporate network, CI on another
continent, or the remote MCP gateway below.

## Tokens on the collector

On the brain's host, create the first token. The command writes a SHA-256
hash to `tokens.json` beside the database and prints the token once:

```bash
fleet token create ops --scope admin
fleet token create ci --scope run --expires-days 90
fleet token create mcp-gateway --scope run,delegate
fleet token list
fleet token revoke ci
```

Then start the collector with `FLEET_AUTH=tokens`, either in the process
environment or in the `env` object of `~/.fleet/config.json`
(`"env": {"FLEET_AUTH": "tokens"}`). The token file is re-read when it
changes, so creating and revoking need no restart.

The file is `$FLEET_DATA_DIR/tokens.json` (`~/.fleet/data/tokens.json` under
`fleet up`). `FLEET_TOKENS_FILE` moves it for the collector, and
`fleet token ... --tokens-file PATH` points the command at the same place.

| Scope | Allows |
|---|---|
| `read` | Every GET: devices, jobs, results, artifacts, the dashboard's data |
| `run` | Enqueue and validate jobs; cancel or retry the jobs this token started (checked on `/api/v1` only, see below) |
| `admin` | Everything else: other people's jobs, devices, schedules, the audit log, and the `shell` workload |
| `agent` | The runner protocol, when `FLEET_AUTH_PROTOCOL=token` |
| `delegate` | Name the person a request is for (`X-Fleet-Actor`). For a gateway only |

`admin` implies `run` and `agent`; `run` implies `read`. Nothing implies
`delegate`, because a token that can put a name on a job can put *anyone's*
name on it.

**Two checks are made on `/api/v1` only, and not yet on the older routes.**
`POST /api/v1/jobs/{id}/cancel` and `/retry` refuse a `run` token acting on a
job somebody else started; the dashboard's `POST /api/jobs/:id/cancel` and
`/retry` need `run` and check nothing more, so any `run` token can cancel or
retry any job there. Likewise `POST /api/v1/jobs` refuses the `shell` workload
to a token without `admin`, but `POST /jobs` and `POST /api/jobs` accept it
from any `run` token. Both are gaps in the code, not intended behaviour. Until
they close, treat `run` as able to stop anyone's job. For `shell`, what bounds
it is each machine's own allowlist of script hashes: a machine with no
allowlist file never declares `shell`, so nothing can be sent to it.

**Runners stay open unless you close them.** Phones, TVs and the browser
runner do not send tokens, so with `FLEET_AUTH=tokens` the runner protocol
still answers without one. `FLEET_AUTH_PROTOCOL=token` requires the `agent`
scope; set it only when every runner can send `FLEET_TOKEN` (runner-machine
and the host executor can).

**People** run `fleetr login` once per collector; the token is saved to
`~/.fleet/credentials.json` (mode 0600), keyed by URL. `fleetr whoami` shows
what the collector makes of it and `fleetr logout` forgets it; which token wins
when several are set is in [AI agents and automation](../agents.md#the-cli).
**The dashboard** asks for a token in a banner and exchanges it for an
HttpOnly, SameSite=Strict cookie that is honoured for reads only, so a link on
another site cannot make the browser change anything.

**Every change is audited**: who, through which front door (`source`), what,
and the result, readable at `GET /api/v1/audit` with `admin`.

The collector warns at startup about a token mode with no live tokens, or
`FLEET_AUTH_PROTOCOL=token` with no token holding `agent`.

## The remote MCP gateway

`fleet mcp` (stdio) is for an agent on a machine with `fleet` installed.
`fleet mcp --http` is for everyone else: chat clients and colleagues who
reach the lab through the company's connector list. It is an OAuth 2.1
resource server speaking MCP's Streamable HTTP transport.

```text
chat client --(OAuth access token from your IdP)--> gateway --(gateway token + X-Fleet-Actor)--> collector
```

- The **identity provider** (Entra ID, Okta...) signs people in and issues
  access tokens. The gateway never sees a password and never issues tokens.
- The **gateway** checks each token's signature against the IdP's published
  keys, its issuer, audience, expiry and scopes, and passes the person's name
  to the collector.
- The **collector** believes that name only because the gateway's own token
  has the `delegate` scope. `requested_by` on a job started from a chat window
  is the person, not the gateway.

What a remote caller cannot do, whatever their scopes: run the `shell`
workload, wait longer than 55 seconds in one call (a proxy would cut it), or
learn the collector's address. Calls are rate limited per person.

### Run it

```bash
export FLEET_TOKEN=fr_...            # the mcp-gateway token: run,delegate
fleet mcp --http \
  --url http://collector.internal:8788 \
  --host 0.0.0.0 --port 8790 \
  --public-url https://fleet-mcp.example.com \
  --issuer https://login.microsoftonline.com/<tenant-id>/v2.0 \
  --audience <application-client-id>
```

Put TLS in front of it (a load balancer or reverse proxy). The gateway is
stateless, so any number of replicas can sit behind one.

| Flag | Environment | Default | |
|---|---|---|---|
| `--url` | `FLEET_RUNNER_URL`, `FLEET_URL` | the config | The collector, resolved the way the CLI resolves it |
| `--token` | `FLEET_RUNNER_TOKEN`, `FLEET_TOKEN` | saved login | The gateway's own collector token (`run,delegate`) |
| `--host` | `FLEET_MCP_HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` behind a proxy |
| `--port` | `FLEET_MCP_PORT` | 8790 | |
| `--issuer` | `FLEET_MCP_ISSUER` | | The IdP's issuer, exactly as in the token's `iss` |
| `--audience` | `FLEET_MCP_AUDIENCE` | | This resource, as in `aud`. Required with `--issuer` |
| `--jwks` | `FLEET_MCP_JWKS` | discovered | Signing keys URL, if not at the issuer's OpenID configuration |
| `--scope-read`, `--scope-run` | `FLEET_MCP_SCOPE_READ`, `_RUN` | `fleet.read`, `fleet.run` | Which token scope or app role grants which |
| `--identity-claim` | `FLEET_MCP_IDENTITY_CLAIM` | `preferred_username,upn,email,unique_name,sub` | Which claim names the person |
| `--public-url` | `FLEET_MCP_PUBLIC_URL` | `http://host:port` | The URL clients use; the resource is `<public-url>/mcp` |
| `--allow-origin` | `FLEET_MCP_ALLOW_ORIGINS` | none | Browser origins allowed to call (DNS rebinding protection) |
| `--calls-per-minute` | `FLEET_MCP_CALLS_PER_MINUTE` | 60 | Per person |
| `--runs-per-hour` | `FLEET_MCP_RUNS_PER_HOUR` | 30 | `fleet_run` calls per person |
| `--no-auth` | | | Development only; refused off loopback |

Endpoints: `POST /mcp`, `GET /.well-known/oauth-protected-resource/mcp`
(RFC 9728: tells a client which IdP to sign in with; also answered without the
`/mcp` suffix), `GET /healthz`. A
request without a valid token gets a 401 whose `WWW-Authenticate` header
points at that metadata, which is how an MCP client discovers where to log in.

At startup the gateway asks the collector what it thinks of the gateway's
token, and warns if it lacks `delegate` (every job would be recorded as the
gateway) or `run`, or if the collector runs with auth off (anyone who can
reach it directly bypasses the gateway).

### Register it with the identity provider

**Entra ID**

1. App registrations, New registration: "Fleet Runner MCP", single tenant.
2. Expose an API: set the Application ID URI, then add two scopes,
   `fleet.read` and `fleet.run`. Admin consent is the usual choice for an
   internal tool.
3. Manifest: set `"accessTokenAcceptedVersion": 2`. Version 2 tokens carry
   `iss = https://login.microsoftonline.com/<tenant-id>/v2.0` and
   **`aud` = the application's client id**, not the URI; pass the client id
   to `--audience`.
4. To limit who can run jobs, use app roles instead of (or as well as)
   scopes: define roles `fleet.read` and `fleet.run`, assign groups, and the
   gateway reads them from the `roles` claim.

**Okta**

1. Security, API, Authorization Servers: use or add one; its issuer is
   `https://<org>.okta.com/oauth2/<server-id>`.
2. Set its audience (for example `api://fleet-runner`), add scopes
   `fleet.read` and `fleet.run`, and an access policy for the right groups.
3. Okta's `sub` is the user's login by default, which the gateway falls back to.

**MCP clients** find the IdP from the gateway's metadata. Many chat clients
register themselves dynamically; Entra ID does not support dynamic client
registration, so each client needs a pre-registered public client
(redirect URI from the client's documentation) granted the two scopes. That
registration, and adding the gateway to the company's approved connector
list, are steps for whoever owns the tenant.

## What this does not do

- It is not multi-tenant: one collector, one token file, one audit log.
- Rate limits are per gateway replica, in memory.
- Tokens on the collector are bearer secrets with no proof of possession.
  Serve the collector over TLS, or keep it on a private network, when tokens
  are on.
