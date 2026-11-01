// Launches an extra client instance with its own identity and profiles.
//   npm run instance -- bob
// Requires `npm run tauri dev` (or at least `npm run dev`) to be running, since
// debug builds load the UI from the Vite dev server.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const name = process.argv[2] ?? "bob";
const exe = join("src-tauri", "target", "debug", process.platform === "win32" ? "multichat.exe" : "multichat");
if (!existsSync(exe)) {
  console.error(`${exe} not found. Run \`npm run tauri dev\` once first to build it.`);
  process.exit(1);
}

const env = {
  ...process.env,
  MULTICHAT_INSTANCE: name,
  // Separate WebView2 profile per instance on Windows (keeps UI preferences apart).
  WEBVIEW2_USER_DATA_FOLDER: join(tmpdir(), `multichat-webview-${name}`),
};
const child = spawn(exe, [], { env, stdio: "inherit" });
console.log(`Started instance "${name}" (pid ${child.pid})`);
child.on("exit", (code) => process.exit(code ?? 0));
