// Cross-platform launcher used by start.sh / start.cmd once the toolchain is present.
// Installs npm deps if needed, (re)builds the app and relay only when sources changed,
// optionally hosts the relay, then runs the desktop app.
//
//   node app/scripts/launch.mjs [--server] [--port 8787] [--instance NAME]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appDir = join(root, "app");
const serverDir = join(root, "server");
const isWin = process.platform === "win32";
const exeSuffix = isWin ? ".exe" : "";

function parseArgs(argv) {
  const opts = { server: false, port: 8787, instance: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") opts.server = true;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--instance") opts.instance = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: start [--server] [--port 8787] [--instance NAME]

  --server          Also host the relay server for friends (listens on all interfaces).
  --port N          Relay port when hosting (default 8787).
  --instance NAME   Run as a separate local identity (e.g. a second test user).`);
      process.exit(0);
    } else {
      console.error(`Unknown option: ${a} (try --help)`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error("--port must be a number between 1 and 65535");
    process.exit(2);
  }
  return opts;
}

const step = (msg) => console.log(`\n==> ${msg}`);

function run(cmd, args, cwd) {
  // npm/npx are .cmd shims on Windows, which Node only spawns through a shell.
  // Arguments here are fixed strings, so joining them is safe.
  const res = isWin
    ? spawnSync([cmd, ...args].join(" "), { cwd, stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

const SKIP = new Set(["node_modules", "target", "dist", "gen", ".git"]);

/** Newest modification time (ms) of a file or anything under a directory. */
function newest(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const name of readdirSync(path)) {
    if (!SKIP.has(name)) max = Math.max(max, newest(join(path, name)));
  }
  return max;
}

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

function ensureNpmDeps() {
  // npm writes package-lock.json a moment after its own marker, hence the slack.
  const marker = join(appDir, "node_modules", ".package-lock.json");
  const inputs = Math.max(mtime(join(appDir, "package-lock.json")), mtime(join(appDir, "package.json")));
  if (mtime(marker) > 0 && mtime(marker) + 5000 >= inputs) {
    step("JavaScript dependencies are up to date");
    return;
  }
  step("Installing JavaScript dependencies (npm install)");
  run("npm", ["install", "--no-audit", "--no-fund"], appDir);
}

function ensureAppBuilt() {
  const exe = join(appDir, "src-tauri", "target", "release", `multichat${exeSuffix}`);
  const sources = [
    join(appDir, "src"),
    join(appDir, "index.html"),
    join(appDir, "package.json"),
    join(appDir, "vite.config.ts"),
    join(appDir, "src-tauri"), // skips target/ and gen/
  ];
  const stale = Math.max(...sources.map(newest)) > mtime(exe);
  if (!stale) {
    step("Desktop app is up to date");
  } else {
    step(existsSync(exe) ? "Sources changed, rebuilding the desktop app" : "Building the desktop app (first build takes a few minutes)");
    run("npx", ["tauri", "build", "--no-bundle"], appDir);
  }
  return exe;
}

function ensureServerBuilt() {
  step("Building the relay server (fast when nothing changed)");
  run("cargo", ["build", "--release"], serverDir);
  return join(serverDir, "target", "release", `multichat-relay${exeSuffix}`);
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

async function waitForHealth(port, child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const opts = parseArgs(process.argv.slice(2));
ensureNpmDeps();
const appExe = ensureAppBuilt();

let server = null;
if (opts.server) {
  const relayExe = ensureServerBuilt();
  step(`Starting the relay on port ${opts.port}`);
  server = spawn(relayExe, [], {
    cwd: serverDir,
    stdio: "inherit",
    env: { ...process.env, MULTICHAT_ADDR: `0.0.0.0:${opts.port}`, MULTICHAT_DB: join(serverDir, "multichat.db") },
  });
  if (!(await waitForHealth(opts.port, server))) {
    console.error(`The relay did not start. Is port ${opts.port} already in use?`);
    server.kill();
    process.exit(1);
  }
  console.log(`\nRelay is running. In the app's relay server field:`);
  console.log(`  you:      ws://127.0.0.1:${opts.port}/ws`);
  console.log(`  friends on the same network, one of (usually your Wi-Fi/Ethernet 192.168.x.x or 10.x.x.x):`);
  for (const ip of lanAddresses()) console.log(`            ws://${ip}:${opts.port}/ws`);
  console.log(`  friends elsewhere: use a tunnel, see README ("Playing with a friend").`);
  if (isWin) console.log(`  If Windows asks, allow the relay through the firewall on private networks.`);
}

step(opts.instance ? `Launching Multichat (instance "${opts.instance}")` : "Launching Multichat");
const env = { ...process.env };
if (opts.instance) {
  env.MULTICHAT_INSTANCE = opts.instance;
  env.WEBVIEW2_USER_DATA_FOLDER = join(tmpdir(), `multichat-webview-${opts.instance}`);
}
const app = spawn(appExe, [], { stdio: "inherit", env });

const shutdown = () => {
  server?.kill();
  if (app.exitCode === null) app.kill();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.on("exit", (code) => {
  if (server) console.log("\nApp closed, stopping the relay.");
  server?.kill();
  process.exit(code ?? 0);
});
