const [platformOrigin, spotOrigin, expectedSha] = process.argv.slice(2);
if (!platformOrigin || !spotOrigin || !expectedSha) {
  throw new Error("Usage: smoke-deployment.mjs <platform-origin> <spot-origin> <sha>");
}

async function ready() {
  const response = await fetch(new URL("/api/health/ready", platformOrigin), { headers: { "Cache-Control": "no-cache" } });
  const body = await response.json();
  return body?.checks?.database === true
    && body?.checks?.noxspot === true
    && body?.versions?.noxconnect === expectedSha
    && body?.versions?.noxspot === expectedSha;
}

async function spotReady() {
  const response = await fetch(new URL("/health", spotOrigin), { headers: { "Cache-Control": "no-cache" } });
  const body = await response.json();
  return response.ok && body?.owner === "noxconnect" && body?.buildSha === expectedSha;
}

for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    if (await ready() && await spotReady()) {
      console.log(JSON.stringify({ platformOrigin, spotOrigin, buildSha: expectedSha, status: "ready" }));
      process.exit(0);
    }
  } catch { /* retry while bindings and routes converge */ }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
throw new Error(`NoxConnect release ${expectedSha} did not become ready`);
