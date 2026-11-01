// A fake LLM server for local testing without real API keys.
// Speaks both OpenAI Chat Completions and Anthropic Messages streaming (SSE).
//
//   node tools/mock-llm.mjs [port]        (default 9999)
//
// Profiles: OpenAI-compatible base URL http://127.0.0.1:9999/v1
//           Anthropic base URL          http://127.0.0.1:9999
// API key "bad" returns a 401 (to test error handling); "slow" streams slowly.
// Each request's received context is logged, so you can check trimming/merging.

import http from "node:http";

const port = Number(process.argv[2] ?? 9999);

function reply(model, messages) {
  const last = messages[messages.length - 1]?.content ?? "";
  const lastLine = String(last).split("\n").filter(Boolean).pop() ?? "";
  return (
    `Mock reply from **${model}**. I received ${messages.length} message(s); the latest was:\n\n` +
    `> ${lastLine.slice(0, 200)}\n\n` +
    "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"120\"><rect x=\"10\" y=\"10\" width=\"100\" height=\"100\" rx=\"16\" fill=\"#6366f1\"/></svg>\n```"
  );
}

function chunks(text) {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    let json = {};
    try {
      json = JSON.parse(body || "{}");
    } catch {}
    const key = (req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "") ?? "").toString();
    const isAnthropic = req.url.endsWith("/messages");
    const msgs = isAnthropic ? json.messages ?? [] : (json.messages ?? []).filter((m) => m.role !== "system");
    const system = isAnthropic ? json.system : json.messages?.find((m) => m.role === "system")?.content;

    console.log(
      `\n${req.method} ${req.url} model=${json.model} key=${key ? "yes" : "no"} max_tokens=${json.max_tokens ?? "-"} temperature=${json.temperature ?? "-"} version=${req.headers["anthropic-version"] ?? "-"}`,
    );
    const sys = String(system ?? "");
    const room = sys.split("Room instructions (set by the members of this room):\n")[1];
    console.log(`  system: ${sys.slice(0, 70).replace(/\n/g, " ")}…${room ? ` [room: ${room.slice(0, 60)}]` : ""}`);
    for (const m of msgs) console.log(`  ${m.role.padEnd(9)} ${String(m.content).slice(0, 90).replace(/\n/g, "⏎")}`);

    if (key === "bad") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}. Contact http://127.0.0.1:${port}` } }));
      return;
    }

    const text = reply(json.model, msgs);
    const delay = key === "slow" ? 300 : 25;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (obj, event) => res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(obj)}\n\n`);

    if (isAnthropic) {
      send({ type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", content: [] } }, "message_start");
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
      for (const c of chunks(text)) {
        send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } }, "content_block_delta");
        await sleep(delay);
      }
      send({ type: "content_block_stop", index: 0 }, "content_block_stop");
      send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }, "message_delta");
      send({ type: "message_stop" }, "message_stop");
    } else {
      for (const c of chunks(text)) {
        send({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: c } }] });
        await sleep(delay);
      }
      send({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
    }
    res.end();
  })
  .listen(port, "127.0.0.1", () => console.log(`mock LLM listening on http://127.0.0.1:${port}`));
