/**
 * rlbotline Worker — Build provenance
 *
 * Answers "which code is actually running in this container?" — the question you
 * ask first when prod behaves unlike your checkout. The values are baked in at
 * image build time (Dockerfile ARG → ENV, fed by docker-compose build args), so
 * they describe the image, not the host that happens to run it.
 *
 * Everything is optional: a plain `bun run src/index.ts` outside Docker has no
 * build stamp, and that is reported honestly as "unknown" rather than guessed.
 */

export interface BuildInfo {
  /** Full commit SHA the image was built from, or "unknown". */
  commit: string;
  /** Short (7-char) commit SHA, or "unknown". */
  commitShort: string;
  /** Git branch the image was built from, or "unknown". */
  branch: string;
  /** ISO timestamp of the image build, or "unknown". */
  builtAt: string;
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean;
  /** Worker package version (from the app itself, always known). */
  version: string;
}

function envOr(name: string, fallback = "unknown"): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  const commit = envOr("GIT_COMMIT");
  cached = {
    commit,
    commitShort: commit === "unknown" ? "unknown" : commit.slice(0, 7),
    branch: envOr("GIT_BRANCH"),
    builtAt: envOr("BUILD_TIME"),
    dirty: /^(1|true|yes)$/i.test(process.env.GIT_DIRTY ?? ""),
    version: envOr("npm_package_version", "2.0.0"),
  };
  return cached;
}
