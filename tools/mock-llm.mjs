// A fake LLM server for local testing without real API keys.
// Speaks OpenAI Chat Completions and Anthropic Messages streaming (SSE), lists models,
// streams reasoning, and calls tools.
//
//   node tools/mock-llm.mjs [port]        (default 9999)
//
// Profiles: OpenAI-compatible base URL http://127.0.0.1:9999/v1
//           Anthropic base URL          http://127.0.0.1:9999
// API key "bad" returns a 401 (to test error handling); "slow" streams slowly.
// When tools are offered and your message contains "tool", the mock calls one
// (preferring `echo`), then answers with the result. A message with the word "html"
// gets a live ```html reply that probes its sandbox (see htmlReply).
// Each request's received context is logged, so you can check trimming/merging.

import http from "node:http";

const port = Number(process.argv[2] ?? 9999);

const MODELS = [
  { id: "mock-gpt", name: "Mock GPT", context_length: 128000, capabilities: { reasoning: true, tool_calling: true } },
  { id: "mock-claude", name: "Mock Claude", context_length: 200000, capabilities: { reasoning: true, tool_calling: true } },
  { id: "mock-tiny", name: "Mock Tiny", context_length: 4096, capabilities: { reasoning: false, tool_calling: false } },
];

function contentText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => b.text ?? (b.type === "tool_result" ? `[tool_result ${JSON.stringify(b.content)}]` : `[${b.type}]`)).join(" ");
  return "";
}

/** The latest tool result in the conversation, if the last turn returned one. */
function lastToolResult(msgs, isAnthropic) {
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  if (!isAnthropic && last.role === "tool") return String(last.content);
  if (isAnthropic && last.role === "user" && Array.isArray(last.content)) {
    const r = last.content.find((b) => b.type === "tool_result");
    if (r) return typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  }
  return null;
}

function lastHumanText(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user" && typeof m.content === "string") return m.content.split("\n").filter(Boolean).pop() ?? "";
  }
  return "";
}

// A live ```html reply that draws a small chart and probes its sandbox: it posts
// {type: "mc-probe", r} to the app with what it could reach (all should be blocked
// except the CDN script). A hit on /pixel in this log means remote images leaked.
function htmlReply() {
  const base = `http://127.0.0.1:${port}`;
  return (
    "Here is a live chart:\n\n```html\n" +
    `<div id="out">waiting</div>\n<canvas id="c" width="220" height="90"></canvas>\n<img src="${base}/pixel" alt="">\n` +
    `<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js" onload="window.cdn='ok'" onerror="window.cdn='blocked'"></script>\n` +
    "<script>\n" +
    "const r = { origin: self.origin, tauri: typeof window.__TAURI_INTERNALS__, rtc: typeof RTCPeerConnection };\n" +
    "try { r.parentDoc = String(!!parent.document.body); } catch (e) { r.parentDoc = 'blocked'; }\n" +
    "const tryFetch = (u, o) => fetch(u, o).then(() => 'ok', () => 'blocked');\n" +
    "const timeout = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok('no answer'), 3000))]);\n" +
    "const invoke = window.__TAURI_INTERNALS__?.invoke;\n" +
    "const tryInvoke = invoke ? timeout(Promise.resolve().then(() => invoke('get_state')).then((s) => 'OPEN ' + Object.keys(s || {}).join(','), (e) => 'blocked: ' + String(e).slice(0, 80))) : 'absent';\n" +
    `Promise.all([tryFetch("${base}/v1/models"), tryFetch("http://ipc.localhost/plugin%3Aapp%7Cversion", { method: "POST" }), tryInvoke]).then(([f, i, v]) => {\n` +
    "  r.fetch = f; r.ipc = i; r.invoke = v; r.cdn = window.cdn || 'pending';\n" +
    "  parent.postMessage({ type: 'mc-probe', r }, '*');\n" +
    "});\n" +
    "document.getElementById('out').textContent = 'Live script ran';\n" +
    "const x = document.getElementById('c').getContext('2d'); x.fillStyle = '#6366f1';\n" +
    "[30, 70, 45, 85].forEach((h, i) => x.fillRect(10 + i * 52, 90 - h, 40, h));\n" +
    "</script>\n```"
  );
}

function reply(model, msgs) {
  if (/\bhtml\b/i.test(lastHumanText(msgs))) return htmlReply();
  return (
    `Mock reply from **${model}**. I received ${msgs.length} message(s); the latest was:\n\n` +
    `> ${lastHumanText(msgs).slice(0, 200)}\n\n` +
    "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"120\"><rect x=\"10\" y=\"10\" width=\"100\" height=\"100\" rx=\"16\" fill=\"#6366f1\"/></svg>\n```"
  );
}

const chunks = (text) => text.match(/\S+\s*|\s+/g) ?? [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uses the tool named in the message ("use tool draw"), else one ending in echo. */
function pickTool(tools, isAnthropic, said) {
  const names = tools.map((t) => (isAnthropic ? t.name : t.function?.name));
  const short = (n) => n.split("__").pop();
  const mentioned = (n) => said.toLowerCase().split(/\W+/).includes(short(n).toLowerCase());
  const named = said.match(/(\w+) tool/i)?.[1]?.toLowerCase();
  const name = names.find((n) => short(n).toLowerCase() === named) ?? names.find(mentioned) ?? names.find((n) => /echo/.test(n)) ?? names[0];
  const seconds = Number(said.match(/(\d+)\s*s(ec|econds)?/)?.[1] ?? 3);
  const args = { echo: { text: "hello from the mock model" }, draw: { color: "#10b981" }, render: { color: "#f97316" }, wait: { seconds } }[short(name)] ?? {};
  return { name, args };
}

http
  .createServer(async (req, res) => {
    if (req.url === "/pixel") {
      console.log("\nGET /pixel: a live HTML reply loaded a remote image");
      res.end();
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    let json = {};
    try {
      json = JSON.parse(body || "{}");
    } catch {}
    const key = (req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "") ?? "").toString();

    if (req.method === "GET" && /\/models/.test(req.url)) {
      console.log(`\nGET ${req.url} key=${key ? "yes" : "no"}`);
      if (key === "bad") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: MODELS }));
      return;
    }

    const isAnthropic = req.url.endsWith("/messages");
    const msgs = isAnthropic ? (json.messages ?? []) : (json.messages ?? []).filter((m) => m.role !== "system");
    const system = isAnthropic ? json.system : json.messages?.find((m) => m.role === "system")?.content;
    const tools = json.tools ?? [];

    console.log(
      `\n${req.method} ${req.url} model=${json.model} key=${key ? "yes" : "no"} max_tokens=${json.max_tokens ?? "-"} temperature=${json.temperature ?? "-"} version=${req.headers["anthropic-version"] ?? "-"}` +
        ` thinking=${json.thinking ? JSON.stringify(json.thinking) : "-"} effort=${json.reasoning_effort ?? json.output_config?.effort ?? "-"} tools=${tools.length} tool_choice=${JSON.stringify(json.tool_choice ?? "-")}`,
    );
    const sys = String(system ?? "");
    const room = sys.split("Room instructions (set by the members of this room):\n")[1];
    console.log(`  system: ${sys.slice(0, 70).replace(/\n/g, " ")}…${room ? ` [room: ${room.slice(0, 60)}]` : ""}`);
    for (const m of msgs) console.log(`  ${m.role.padEnd(9)} ${contentText(m.content).slice(0, 90).replace(/\n/g, "⏎")}${m.tool_calls ? ` [tool_calls ${m.tool_calls.map((t) => t.function.name)}]` : ""}`);

    if (key === "bad") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}. Contact http://127.0.0.1:${port}` } }));
      return;
    }

    const toolResult = lastToolResult(msgs, isAnthropic);
    const wantsTool = tools.length > 0 && !toolResult && /tool/i.test(lastHumanText(msgs)) && json.tool_choice !== "none" && json.tool_choice?.type !== "none";
    const text = toolResult ? `The tool returned: **${toolResult}**` : wantsTool ? "Let me use a tool for that." : reply(json.model, msgs);
    const reasoning = `The user said "${lastHumanText(msgs).slice(0, 60)}". ${toolResult ? "I have the tool result, so I can answer." : wantsTool ? "A tool would help here." : "I'll answer directly."}`;
    const delay = key === "slow" ? 300 : 20;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (obj, event) => res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(obj)}\n\n`);

    if (isAnthropic) {
      let i = 0;
      send({ type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", content: [] } }, "message_start");
      if (json.thinking) {
        send({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }, "content_block_start");
        for (const c of chunks(reasoning)) {
          send({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: c } }, "content_block_delta");
          await sleep(delay);
        }
        send({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "mock-signature" } }, "content_block_delta");
        send({ type: "content_block_stop", index: i++ }, "content_block_stop");
      }
      send({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }, "content_block_start");
      for (const c of chunks(text)) {
        send({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: c } }, "content_block_delta");
        await sleep(delay);
      }
      send({ type: "content_block_stop", index: i++ }, "content_block_stop");
      if (wantsTool) {
        const { name, args } = pickTool(tools, true, lastHumanText(msgs));
        send({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: "toolu_mock1", name, input: {} } }, "content_block_start");
        const raw = JSON.stringify(args);
        for (const part of [raw.slice(0, 5), raw.slice(5)]) {
          send({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: part } }, "content_block_delta");
        }
        send({ type: "content_block_stop", index: i++ }, "content_block_stop");
      }
      send({ type: "message_delta", delta: { stop_reason: wantsTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } }, "message_delta");
      send({ type: "message_stop" }, "message_stop");
    } else {
      for (const c of chunks(reasoning)) {
        send({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning: c } }] });
        await sleep(delay);
      }
      for (const c of chunks(text)) {
        send({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: c } }] });
        await sleep(delay);
      }
      if (wantsTool) {
        const { name, args } = pickTool(tools, false, lastHumanText(msgs));
        const raw = JSON.stringify(args);
        send({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name, arguments: raw.slice(0, 5) } }] } }] });
        send({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(5) } }] } }] });
      }
      send({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: wantsTool ? "tool_calls" : "stop" }] });
      res.write("data: [DONE]\n\n");
    }
    res.end();
  })
  .listen(port, "127.0.0.1", () => console.log(`mock LLM listening on http://127.0.0.1:${port}`));
