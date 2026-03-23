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

export async function deploy(workerName, { customDomain, overrideDns = false } = {}) {
  const workerDir = getWorkerDir();
  // Install worker dependencies (including devDependencies — wrangler and
  // @cloudflare/workers-types are devDeps needed for the build step)
  await execFileAsync("npm", ["install"], {
    cwd: workerDir,
    timeout: 120_000,
  });

  const args = ["deploy", "--name", workerName];
  if (customDomain) {
    args.push("--domain", customDomain);
    if (overrideDns) {
      args.push("--experimental-override-existing-dns-record");
    }
  }
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
