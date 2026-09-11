import { readFile } from "node:fs/promises";

const SLACK_API = "https://slack.com/api";
const MANIFEST_URL = new URL("../slack-app-manifest.json", import.meta.url);
const commands = new Set(["validate", "create", "push"]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function printApiErrors(data) {
  const details = Array.isArray(data.errors)
    ? data.errors.map((item) => `  ${item.pointer ?? "manifest"}: ${item.message ?? "invalid"}`).join("\n")
    : "";
  fail(`Slack rejected the manifest: ${data.error ?? "unknown_error"}${details ? `\n${details}` : ""}`);
}

async function callSlack(method, body, token) {
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Slack HTTP ${response.status} ${response.statusText}`);
  if (!data?.ok) {
    printApiErrors(data ?? { error: "invalid_response" });
    return null;
  }
  return data;
}

async function main() {
  const command = process.argv[2];
  if (!commands.has(command)) {
    fail("Usage: node scripts/slack-manifest.mjs <validate|create|push>");
    return;
  }

  const token = process.env.SLACK_CONFIG_TOKEN?.trim();
  if (!token) {
    fail("SLACK_CONFIG_TOKEN is required. Generate a temporary app configuration token at https://api.slack.com/apps.");
    return;
  }

  const manifest = JSON.parse(await readFile(MANIFEST_URL, "utf8"));
  const body = { manifest: JSON.stringify(manifest) };
  let method = `apps.manifest.${command}`;

  if (command === "push") {
    const appId = process.env.SLACK_APP_ID?.trim();
    if (!appId) {
      fail("SLACK_APP_ID is required when pushing an update.");
      return;
    }
    method = "apps.manifest.update";
    body.app_id = appId;
  }

  const data = await callSlack(method, body, token);
  if (!data) return;

  if (command === "create") {
    console.log(`Created NoxConnect Slack app ${data.app_id}.`);
    console.log(`SLACK_APP_ID=${data.app_id}`);
    console.log(`SLACK_CLIENT_ID=${data.credentials?.client_id ?? "<open Slack Basic Information>"}`);
    console.log(`SLACK_CLIENT_SECRET=${data.credentials?.client_secret ?? "<open Slack Basic Information>"}`);
    console.log(`SLACK_SIGNING_SECRET=${data.credentials?.signing_secret ?? "<open Slack Basic Information>"}`);
    console.log("Store these as Cloudflare Pages secrets; do not commit them.");
    return;
  }

  console.log(command === "push"
    ? `Pushed Slack manifest to ${data.app_id ?? process.env.SLACK_APP_ID}.`
    : "Slack manifest is valid.");
  if (data.permissions_updated) {
    console.log("OAuth permissions changed; connected workspaces must reinstall the app.");
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
