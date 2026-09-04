/**
 * `lease_renewed` parsing. Both phone runners shipped a version of this that
 * threw the answer away and then a version that read it, and the rule that
 * came out of both is one-directional: only an explicit JSON `false` in a 2xx
 * body stops work. Everything else — absent, empty, malformed, a proxy's HTML,
 * a string that spells "false" — reads as renewed, because a flaky network
 * looking like a cancellation is the expensive way to be wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { leaseRenewedIn } from "../src/collector.js";
import * as JobCancellation from "../src/cancellation.js";

test("an explicit false is the only thing that cancels", () => {
  assert.equal(leaseRenewedIn('{"ok":true,"lease_renewed":false}'), false);
  assert.equal(leaseRenewedIn('{"lease_renewed":false}'), false);
});

test("true reads as renewed", () => {
  assert.equal(leaseRenewedIn('{"ok":true,"lease_renewed":true}'), true);
});

test("an absent field reads as renewed", () => {
  assert.equal(leaseRenewedIn("{}"), true);
  assert.equal(leaseRenewedIn('{"ok":true}'), true);
});

test("an empty or missing body reads as renewed", () => {
  assert.equal(leaseRenewedIn(""), true);
  assert.equal(leaseRenewedIn("   "), true);
  assert.equal(leaseRenewedIn(null), true);
  assert.equal(leaseRenewedIn(undefined), true);
});

test("garbage reads as renewed", () => {
  assert.equal(leaseRenewedIn("<html><body>502 Bad Gateway</body></html>"), true);
  assert.equal(leaseRenewedIn("not json at all"), true);
  assert.equal(leaseRenewedIn("null"), true);
  assert.equal(leaseRenewedIn("[]"), true);
  assert.equal(leaseRenewedIn('["lease_renewed"]'), true);
  assert.equal(leaseRenewedIn("123"), true);
});

test("a non-boolean lease_renewed reads as renewed", () => {
  // A string "false" is a serialization someone got wrong, not the collector
  // saying the claim is gone.
  assert.equal(leaseRenewedIn('{"lease_renewed":"false"}'), true);
  assert.equal(leaseRenewedIn('{"lease_renewed":0}'), true);
  assert.equal(leaseRenewedIn('{"lease_renewed":null}'), true);
});

test("the cancellation flag is scoped to one job and clears", () => {
  assert.equal(JobCancellation.isCancelled("bench-1"), false);
  JobCancellation.cancel("bench-1");
  assert.equal(JobCancellation.isCancelled("bench-1"), true);
  assert.equal(JobCancellation.isCancelled("bench-2"), false);
  // Clearing a different job must not free the cancelled one.
  JobCancellation.clear("bench-2");
  assert.equal(JobCancellation.isCancelled("bench-1"), true);
  JobCancellation.clear("bench-1");
  assert.equal(JobCancellation.isCancelled("bench-1"), false);
});
