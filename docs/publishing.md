# Reviewed, signed Shard publication

## Boundaries

- `main`: reviewed source, templates, tools, unsigned/reproducible index and bundles.
- `catalog`: generated signed index, matching bundles and public verification key.
- `catalog-public.pem`: reviewed public key, also embedded in Vetro's `plugin-key.js`.
- `SHARDS_SIGNING_KEY`: private RSA key, held only in the `shards-catalog` GitHub environment and the maintainer's private backup. Never commit it.

The index signature format remains Vetro API 1: RSA-SHA256 over
`vetro-plugin\n<id>\n<version>\n<sha256>`. Nothing in the plugin format changes.
Each bundle hash and its manifest identity are verified before signing and again
after output. Changing the environment secret to a different key fails instead
of silently rotating trust.

## Initial configuration

1. Create a catalog-only RSA key outside Git; retain a private backup with restrictive permissions.
2. Commit only its public half as `catalog-public.pem` and configure the same public key in Vetro's `app/service/plugin-key.js`.
3. Create GitHub environment `shards-catalog`, restricting deployments to branch `main`.
4. Put the private PEM in its `SHARDS_SIGNING_KEY` environment secret.
5. Require `check` and one code-owner approval on `main`, dismiss stale approvals and require the branch to be up to date. Existing administrator bypass is unchanged.
6. Merge the reviewed workflow PR. Dispatch **Publish signed Shards** on `main` for a bootstrap run if needed. Wait for checks and inspect `catalog/index.json`.
7. Test a key-bearing Vetro build: install with Developer mode off, reject altered bundles/signatures, update and stop/remove on a TV.

The first successful publication creates `catalog`. Before that, its raw URL is
unavailable. Publish the signed catalog before releasing the key-bearing Vetro build.
No signing key or release is needed to validate a contributor PR.

## Automatic runs

A push to `main` or manual dispatch on `main` calls the reusable check workflow.
Validation checks ES5 syntax, manifest limits (including `intercepts`, which also goes into `index.json`), README, build consistency and version
immutability; lifecycle jobs run on three real Node versions. Publication requires
all checks to pass. Only then does its separate job enter the signing environment.
It refuses a stale run if `main` has moved, signs without loading plugin code,
verifies the output and pushes a normal non-forced commit to `catalog`. Runs are
serialized. A failed publication leaves the previous deployed catalog in place.

Neither the PR workflow nor the publisher uses `pull_request_target`. Checkout
credentials are not persisted. Lifecycle children receive an allowlisted environment,
fake command execution and a five-second limit. These are useful correctness checks,
not a sandbox: source review remains necessary, including changes to CI itself.

A malicious CI change merged by a maintainer could use that maintainer's signing
capability. Key exposure/rotation and review of `.github/`, tooling and dependencies
are part of maintaining this repository, not things a signature can solve.

## Recovery and rotation

Retry a failed run only for the current `main` head, or dispatch a fresh one. Do not
force-push a stale catalog. Removing a catalog entry does not uninstall it from TVs.
Rotating the key requires publishing a Vetro build that trusts the new key before
switching the publisher and catalog. Losing the private backup prevents signing
new releases with the old identity; changing only the catalog's public-key file
does not make existing TVs trust it.
