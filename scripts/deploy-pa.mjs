// Uploads the built client (dist/) to PythonAnywhere and reloads the web app.
// Reads PA_USERNAME and PA_TOKEN from .env.deploy (gitignored).
// Usage: npm run build && node scripts/deploy-pa.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";

const env = Object.fromEntries(
  readFileSync(".env.deploy", "utf8")
    .split(/\r?\n/)
    .filter((line) => /^\s*[A-Z_]+=/.test(line))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);
const user = env.PA_USERNAME;
const token = env.PA_TOKEN;
if (!user || !token) throw new Error("PA_USERNAME and PA_TOKEN must be set in .env.deploy");

const auth = { Authorization: `Token ${token}` };
const remoteRoot = `/home/${user}/stdbrts`;
const domain = `${user}.pythonanywhere.com`;

async function api(host, path, init = {}) {
  const res = await fetch(`https://${host}/api/v0/user/${user}${path}`, {
    ...init,
    headers: { ...auth, ...(init.headers ?? {}) },
  });
  return res;
}

// Accounts live on either the US or EU cluster; the token only works on one.
let host;
for (const candidate of ["www.pythonanywhere.com", "eu.pythonanywhere.com"]) {
  const res = await api(candidate, "/webapps/");
  if (res.ok) {
    host = candidate;
    break;
  }
}
if (!host) throw new Error("Token rejected by both www and eu PythonAnywhere APIs");
console.log(`API host: ${host}`);

async function check(res, what) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

// Ensure the web app exists.
const apps = await (await api(host, "/webapps/")).json();
if (!apps.some((app) => app.domain_name === domain)) {
  console.log(`Creating web app ${domain}`);
  await check(
    await api(host, "/webapps/", {
      method: "POST",
      body: new URLSearchParams({ domain_name: domain, python_version: "python310" }),
    }),
    "create webapp",
  );
}

async function upload(remotePath, content) {
  const form = new FormData();
  form.append("content", new Blob([content]), posix.basename(remotePath));
  await check(
    await api(host, `/files/path${remotePath}`, { method: "POST", body: form }),
    `upload ${remotePath}`,
  );
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk("dist");
for (const file of files) {
  const rel = relative("dist", file).split("\\").join("/");
  await upload(`${remoteRoot}/dist/${rel}`, readFileSync(file));
  console.log(`  uploaded ${rel}`);
}

const wsgi = readFileSync("deploy/pythonanywhere/wsgi.py", "utf8").replace(
  'DIST = "/home/YOURUSERNAME/stdbrts/dist"',
  `DIST = "${remoteRoot}/dist"`,
);
await upload(`/var/www/${user}_pythonanywhere_com_wsgi.py`, wsgi);
console.log("  uploaded WSGI config");

await check(await api(host, `/webapps/${domain}/reload/`, { method: "POST" }), "reload");
console.log(`Done: https://${domain}`);
