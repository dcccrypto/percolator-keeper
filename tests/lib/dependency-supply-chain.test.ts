import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * GH#326 — the SDK must come from a PUBLISHED npm version, not a git SHA.
 *
 * Production ran `github:dcccrypto/percolator-sdk#828b43e4…` while CI tested the npm
 * release. That is not a hypothetical drift: byte-comparing the pinned SHA against
 * published 4.3.0 (the version it CLAIMS to be) showed 6 of 30 dist files differing,
 * including `dist/index.js` — the runtime.
 *
 * The direction is the part worth remembering. The git SHA was NEWER and STRICTER: it
 * validated that a PublicKey argument is PublicKey-like, that `toBytes()` returns a
 * `Uint8Array`, and that the result is exactly 32 bytes, plus a bigint-coercion guard.
 * Published 4.3.0 had none of that. So "fix the pin by installing the version it says
 * it is" would have SILENTLY REMOVED input validation from the keeper.
 *
 * The resolution was to move FORWARD to 5.0.0, which carries those same guards and is
 * published. Same code CI tests, same code production runs.
 */
describe("the SDK dependency is a published version, not a git ref (GH#326)", () => {
  const spec: string = pkg.dependencies["@percolatorct/sdk"];

  it("is not a git, github, file or url specifier", () => {
    expect(spec).toBeTruthy();
    for (const bad of ["github:", "git+", "git:", "file:", "http://", "https://"]) {
      expect(
        spec.startsWith(bad),
        `@percolatorct/sdk must be a published npm version, got "${spec}". A git ref means ` +
          `production runs bytes CI never tested — see the 6-file drift recorded in GH#326.`,
      ).toBe(false);
    }
  });

  it("is a plain semver specifier", () => {
    expect(spec).toMatch(/^[\^~]?\d+\.\d+\.\d+$/);
  });

  it("still carries the input validation the git pin was ahead on", async () => {
    // The concrete reason the naive downgrade was wrong. If a future bump lands on a
    // build without these guards, this fails rather than quietly regressing.
    const sdkIndex = join(
      ROOT,
      "node_modules",
      "@percolatorct",
      "sdk",
      "dist",
      "index.js",
    );
    const src = readFileSync(sdkIndex, "utf8");
    expect(src, "PublicKey byte-length validation must be present").toContain(
      "toBytes() must return a Uint8Array",
    );
    expect(src, "bigint coercion guard must be present").toContain(
      "value must be bigint or decimal integer string",
    );
  });
});

/**
 * GH#372 — bigint-buffer's buffer-overflow CVE (GHSA-3gc7-fjrx-p6mg) has no patched
 * release, and is reachable only through the NATIVE addon.
 *
 * It cannot be removed by upgrading: 1.1.5 is the newest version, and even the newest
 * `@solana/buffer-layout-utils` (0.3.0) still requires `^1.1.5`. It arrives
 * transitively via `@percolatorct/sdk → @solana/spl-token → @solana/buffer-layout-utils`.
 *
 * What makes it UNREACHABLE here is that the native addon is never built — the package
 * ships `binding.gyp` and `src/` only, and `dist/node.js` falls back to pure JS when
 * `require('bindings')('bigint_buffer')` throws. The pure-JS path is not the vulnerable
 * one.
 *
 * That safety is currently INCIDENTAL: it holds because neither the dev environment nor
 * the Alpine production image carries a node-gyp toolchain. Add `build-base` and
 * `python3` to the Dockerfile for some unrelated reason and the addon compiles, silently
 * making the CVE live again.
 *
 * This test converts that accident into an assertion.
 */
describe("the bigint-buffer CVE stays unreachable (GH#372)", () => {
  it("has no compiled native addon anywhere in the store", () => {
    // A .node binary for this package is the ONLY way the vulnerable code executes.
    const found = execSync(
      `find node_modules -name '*.node' -path '*bigint*' 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    expect(
      found,
      `A compiled bigint-buffer native addon was found:\n${found}\n\n` +
        `GHSA-3gc7-fjrx-p6mg is a buffer overflow in that addon, and there is no ` +
        `patched release. If a build toolchain was added to the image, this CVE is now ` +
        `LIVE on the account-decoding path. Remove the toolchain, or vendor a patched ` +
        `fork via pnpm.overrides.`,
    ).toBe("");
  });

  it("the production image installs no native build toolchain", () => {
    // The upstream reason the addon is absent. Asserted so the Dockerfile cannot
    // acquire one without this failing and pointing at the CVE.
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    for (const tool of ["build-base", "node-gyp", "g++", "make ", "python3"]) {
      expect(
        dockerfile.includes(tool),
        `Dockerfile installs "${tool}". That lets bigint-buffer compile its native ` +
          `addon, which is where GHSA-3gc7-fjrx-p6mg lives. See GH#372 before adding it.`,
      ).toBe(false);
    }
  });
});
