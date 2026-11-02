// A tiny MCP server over stdio for testing tool calls without installing anything.
// Add it in the app as a "Local command": command `node`, argument: the full path to this file.
//
// Tools: echo(text), add(a, b), now(), draw(color) returns an image,
// render(color) saves a PNG and returns its path (like ComfyUI), wait(seconds).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

/** A solid-color square PNG with a white circle, built without dependencies. */
function png(hex = "#6366f1", size = 256) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const inCircle = (x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 4) ** 2;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = inCircle ? 255 : r;
      raw[o + 1] = inCircle ? 255 : g;
      raw[o + 2] = inCircle ? 255 : b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
  {
    name: "now",
    description: "The current date and time on this computer.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "draw",
    description: "Draw a test image and return it.",
    inputSchema: { type: "object", properties: { color: { type: "string", description: "Hex color like #10b981" } } },
  },
  {
    name: "render",
    description: "Render a test image to a file and return the file path (like ComfyUI).",
    inputSchema: { type: "object", properties: { color: { type: "string" } } },
  },
  {
    name: "wait",
    description: "Wait the given number of seconds, then reply.",
    inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const text = (t) => ({ content: [{ type: "text", text: t }], isError: false });

async function call(name, args = {}) {
  if (name === "echo") return text(`echo: ${args.text ?? ""}`);
  if (name === "add") return text(String(Number(args.a) + Number(args.b)));
  if (name === "now") return text(new Date().toString());
  if (name === "draw") {
    return { content: [{ type: "text", text: "Here is the drawing." }, { type: "image", mimeType: "image/png", data: png(args.color).toString("base64") }] };
  }
  if (name === "render") {
    const file = path.join(os.tmpdir(), `mock_render_${Date.now()}.png`);
    fs.writeFileSync(file, png(args.color ?? "#f97316", 512));
    return text(JSON.stringify({ status: "success", outputs: [file] }));
  }
  if (name === "wait") {
    await new Promise((r) => setTimeout(r, Number(args.seconds) * 1000));
    return text(`waited ${args.seconds}s`);
  }
  return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notifications need no reply
  switch (req.method) {
    case "initialize":
      send({
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "multichat-mock-mcp", version: "1.0.0" },
        },
      });
      break;
    case "ping":
      send({ id: req.id, result: {} });
      break;
    case "tools/list":
      send({ id: req.id, result: { tools: TOOLS } });
      break;
    case "tools/call":
      call(req.params?.name, req.params?.arguments).then((result) => send({ id: req.id, result }));
      break;
    default:
      send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
});
