// src/lib/wrangler.mjs
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

function getWorkerDir() {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return join(cliDir, "..", "..", "worker");
}

export async function deploy(workerName, { customDomain } = {}) {
  const workerDir = getWorkerDir();
  const wranglerToml = join(workerDir, "wrangler.toml");

  // Install worker dependencies (including devDependencies — wrangler and
  // @cloudflare/workers-types are devDeps needed for the build step)
  await execFileAsync("npm", ["install"], {
    cwd: workerDir,
    timeout: 120_000,
  });

  // If custom domain requested, append [[routes]] block to wrangler.toml
  // This uses Cloudflare Custom Domains which handle DNS automatically
  const { readFileSync, writeFileSync } = await import("node:fs");
  const originalToml = readFileSync(wranglerToml, "utf8");

  if (customDomain) {
    // Remove any existing [[routes]] blocks, then append the new one
    const cleanedToml = originalToml.replace(/\n*\[\[routes\]\]\n[^\[]*/g, "");
    const routeBlock = `\n[[routes]]\npattern = "${customDomain}"\ncustom_domain = true\n`;
    writeFileSync(wranglerToml, cleanedToml.trimEnd() + "\n" + routeBlock);
  }

  try {
    const args = ["deploy", "--name", workerName];
    const { stdout, stderr } = await execFileAsync("wrangler", args, {
      cwd: workerDir,
      timeout: 120_000,
    });
    // Parse the worker URL from wrangler output
    const output = stdout + stderr;
    const urlMatch = output.match(/https:\/\/[\w.-]+\.workers\.dev/);
    const workerUrl = customDomain
      ? `https://${customDomain}`
      : urlMatch ? urlMatch[0] : null;
    return { stdout, stderr, workerUrl };
  } finally {
    // Restore original wrangler.toml so the bundled source stays clean
    writeFileSync(wranglerToml, originalToml);
  }
}

export async function putSecret(workerName, secretName, secretValue) {
  const workerDir = getWorkerDir();
  return new Promise((resolve, reject) => {
    const child = spawn("wrangler", ["secret", "put", secretName, "--name", workerName], {
      cwd: workerDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(secretValue);
    child.stdin.end();
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret put ${secretName} failed (code ${code}): ${stderr}`));
    });
    child.on("error", reject);
  });
}

export async function deleteWorker(workerName) {
  const workerDir = getWorkerDir();
  await execFileAsync("wrangler", ["delete", "--name", workerName, "--force"], {
    cwd: workerDir,
    timeout: 30_000,
  });
}

export async function login() {
  return new Promise((resolve, reject) => {
    const child = spawn("wrangler", ["login"], { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler login exited with code ${code}`));
    });
  });
}
