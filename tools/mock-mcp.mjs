// A tiny MCP server over stdio for testing tool calls without installing anything.
// Add it in the app as a "Local command": command `node`, argument: the full path to this file.
//
// Tools: echo(text), add(a, b), now()

import readline from "node:readline";

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
];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const text = (t) => ({ content: [{ type: "text", text: t }], isError: false });

function call(name, args = {}) {
  if (name === "echo") return text(`echo: ${args.text ?? ""}`);
  if (name === "add") return text(String(Number(args.a) + Number(args.b)));
  if (name === "now") return text(new Date().toString());
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
      send({ id: req.id, result: call(req.params?.name, req.params?.arguments) });
      break;
    default:
      send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
});
