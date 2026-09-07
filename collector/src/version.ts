/**
 * The collector's version.
 *
 * A constant rather than a read of package.json, because the bundled `fleet`
 * carries the collector without carrying its package.json -- and a version that
 * is correct in a checkout and `undefined` in a release is worse than no
 * version at all.
 *
 * Kept in step with the other seven declarations by `scripts/version.mjs`,
 * which CI runs on every push. See its header for why one number across four
 * components is the rule.
 */
export const APP_VERSION = "0.5.0-dev";
