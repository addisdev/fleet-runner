// Publish a build to the fleet's artifact store and tag it with the app it is,
// so nightlies can ask for the latest one instead of a hash somebody has to
// remember to bump.
//
//   npx tsx scripts/ci-upload.ts --artifact app.apk --app greenfolio-android \
//     --build "$(git describe --tags --always)" [--platform android]
//
// This is deliberately NOT ci-enqueue: publishing a build and testing a build
// are different events. A merge to main should publish whether or not a device
// is free, and the nightly picks it up later. Coupling them means a busy shelf
// silently stops builds from being published.
//
// A pull request's build is published on the `pr` channel, which `latest`
// never resolves to, so a branch never becomes what the nightly tests. That is
// automatic when GITHUB_EVENT_NAME is pull_request or pull_request_target;
// --channel pr|main says it explicitly.
//
// Auth: FLEET_RUNNER_TOKEN (or FLEET_TOKEN) is sent as a bearer token. An
// upload is the runner protocol, so a collector with FLEET_AUTH_PROTOCOL=token
// wants a token with the `agent` scope; with the protocol open (the default)
// none is needed. FLEET_DASH_TOKEN is still sent as x-fleet-token.
//
// Exits 0 published, 2 usage, 5 refused or unreachable, like `fleetr`.
import { readFileSync } from "node:fs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const BASE = (args.get("collector") ?? process.env.FLEET_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const ARTIFACT = args.get("artifact");
const APP = args.get("app");
const BUILD = args.get("build");
const PLATFORM = args.get("platform");
const CHANNEL_FLAG = args.get("channel");
const TOKEN = (process.env.FLEET_RUNNER_TOKEN || process.env.FLEET_TOKEN || "").trim() || null;
const DASH_TOKEN = process.env.FLEET_DASH_TOKEN?.trim() || null;

if (!ARTIFACT || !APP || !BUILD) {
  console.error("usage: ci-upload --artifact <file> --app <name> --build <version> [--platform <p>] [--channel pr|main] [--collector <url>]");
  process.exit(2);
}
if (CHANNEL_FLAG !== undefined && CHANNEL_FLAG !== "pr" && CHANNEL_FLAG !== "main") {
  console.error(`ci-upload: --channel must be pr or main, not ${CHANNEL_FLAG}`);
  process.exit(2);
}
const event = process.env.GITHUB_EVENT_NAME;
const PR = CHANNEL_FLAG ? CHANNEL_FLAG === "pr" : event === "pull_request" || event === "pull_request_target";

const body = readFileSync(ARTIFACT);
let res: Response;
try {
  res = await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-artifact-name": ARTIFACT.split("/").pop()!,
      "x-artifact-app": APP,
      "x-artifact-build": BUILD,
      "x-fleet-source": "ci",
      ...(PLATFORM ? { "x-artifact-platform": PLATFORM } : {}),
      ...(PR ? { "x-artifact-channel": "pr" } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(DASH_TOKEN ? { "x-fleet-token": DASH_TOKEN } : {}),
    },
    body: new Uint8Array(body),
  });
} catch (e) {
  console.error(`ci-upload: cannot reach ${BASE}: ${(e as Error).message}`);
  process.exit(5);
}
if (!res.ok) {
  console.error(`ci-upload: ${res.status} ${await res.text()}`);
  process.exit(5);
}
const { sha256, size } = (await res.json()) as { sha256: string; size: number };
console.log(`published ${APP} ${BUILD} -> ${sha256} (${size} bytes)${PR ? " on the pr channel" : ""}`);
console.log(
  PR
    ? `a pull request's build: jobs that name ${sha256} test it; nightlies asking for the latest ${APP} do not`
    : `nightlies asking for the latest ${APP} will now test this build`,
);
