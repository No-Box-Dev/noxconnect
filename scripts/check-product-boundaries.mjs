import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const roots = process.argv.slice(2).map((root) => resolve(root));
if (!roots.length) {
  console.error("Usage: node scripts/check-product-boundaries.mjs <product-root> [...]");
  process.exitCode = 2;
} else {
  const forbidden = [
    /https:\/\/api\.github\.com/i,
    /https:\/\/slack\.com\/api/i,
    /https:\/\/api\.anthropic\.com/i,
    /\bANTHROPIC_API_KEY\b/,
    /\bGITHUB_(?:TOKEN|CLIENT_SECRET|APP_PRIVATE_KEY|APP_PRIVATE_KEY_PEM)\b/,
    /\bSLACK_(?:BOT_TOKEN|CLIENT_SECRET|SIGNING_SECRET)\b/,
  ];
  const violations = [];
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        if (["node_modules", "dist", ".git"].includes(name)) continue;
        await visit(`${path}/${name}`);
      }
      return;
    }
    if (!/\.(?:js|mjs|ts|jsonc|toml)$/.test(path) || /(?:\.test\.|__tests__)/.test(path)) return;
    const text = await readFile(path, "utf8");
    for (const pattern of forbidden) if (pattern.test(text)) violations.push({ path, pattern: String(pattern) });
  }
  for (const root of roots) await visit(root);
  if (violations.length) {
    console.error(JSON.stringify({ boundary: "fail", violations }, null, 2));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ boundary: "pass", roots: roots.length, rule: "no product provider clients or credentials" }));
}
