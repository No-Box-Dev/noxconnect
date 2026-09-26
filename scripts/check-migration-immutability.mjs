import { execFileSync } from "node:child_process";

const [baseRef] = process.argv.slice(2);
if (!baseRef) throw new Error("Usage: check-migration-immutability.mjs <base-ref>");
execFileSync("git", ["fetch", "origin", baseRef, "--depth=1"], { stdio: "inherit" });
const changed = execFileSync("git", ["diff", "--name-status", `origin/${baseRef}`, "HEAD", "--", "migrations"], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean);
const rewritten = changed.filter((line) => !line.startsWith("A\t"));
if (rewritten.length) {
  console.error(`Released migrations are immutable; add a new migration instead:\n${rewritten.join("\n")}`);
  process.exit(1);
}
