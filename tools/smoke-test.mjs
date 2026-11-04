// Protocol smoke test: two fake clients exercise the relay end to end.
// Usage: node tools/smoke-test.mjs [ws://127.0.0.1:8787/ws]   (needs Node 22+ for global WebSocket)

const URL_ = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const uuid = () => crypto.randomUUID();

class Client {
  constructor(name) {
    this.name = name;
    this.userId = uuid();
    this.inbox = [];
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_);
      this.ws.onopen = () => {
        this.send({ type: "hello", user_id: this.userId, display_name: this.name });
        resolve();
      };
      this.ws.onerror = () => reject(new Error(`${this.name}: cannot connect to ${URL_}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        this.inbox.push(msg);
        this.waiters = this.waiters.filter((w) => !(w.pred(msg) && (w.resolve(msg), true)));
      };
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  /** Resolves with the first message (already received or future) matching pred. */
  wait(pred, label, ms = 3000) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (m) => {
          clearTimeout(t);
          this.inbox.splice(this.inbox.indexOf(m), 1);
          resolve(m);
        },
      };
      const t = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${label}`)), ms);
      this.waiters.push(w);
    });
  }
  close() {
    this.ws.close();
  }
}

const ok = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ✓ ${what}`);
};
const type = (t, extra = () => true) => (m) => m.type === t && extra(m);

const alice = new Client("Alice");
const bob = new Client("Bob");
await alice.open();
await bob.open();
await alice.wait(type("welcome"), "welcome");
await bob.wait(type("welcome"), "welcome");
ok(true, "both clients connected and got welcome");

alice.send({ type: "create_room", request_id: "r1", name: "Smoke test" });
const created = await alice.wait(type("room_joined"), "room_joined");
const room = created.room;
ok(/^[A-Z0-9]{6}$/.test(room.invite_code), `room created with invite code ${room.invite_code}`);

bob.send({ type: "join_room", request_id: "r2", invite_code: room.invite_code.toLowerCase() });
const joined = await bob.wait(type("room_joined"), "room_joined");
ok(joined.room.members.length === 2, "Bob joined by code; member list has 2 members");
await alice.wait(type("member_joined", (m) => m.member.user_id === bob.userId), "member_joined");
await alice.wait(type("presence", (m) => m.user_id === bob.userId && m.online), "presence online");
ok(true, "Alice saw Bob join and come online");

bob.send({ type: "send_message", room_id: room.id, id: uuid(), content: "hi humans", ai_requested: false });
const human = await alice.wait(type("message", (m) => m.message.content === "hi humans"), "human message");
ok(human.message.author_name === "Bob" && !human.message.ai_requested, "human-only message relayed");

// Typing indicators: live relayed, throttled, and never stored.
{
  // A third client that never joins the room: its typing frames must be ignored
  // silently (no error, nothing broadcast).
  const mallory = new Client("Mallory");
  await mallory.open();
  await mallory.wait(type("welcome"), "welcome");
  mallory.send({ type: "typing", room_id: room.id, typing: true });
  mallory.send({ type: "typing", room_id: room.id, typing: false });

  alice.send({ type: "typing", room_id: room.id, typing: true });
  const t1 = await bob.wait(type("typing", (m) => m.user_id === alice.userId), "typing true");
  ok(t1.typing === true && t1.display_name === "Alice" && t1.room_id === room.id, "typing true relayed with Alice's id and name");
  // A second `true` right away is throttled away server-side; `false` always passes.
  alice.send({ type: "typing", room_id: room.id, typing: true });
  alice.send({ type: "typing", room_id: room.id, typing: false });
  const t2 = await bob.wait(type("typing", (m) => m.user_id === alice.userId && !m.typing), "typing false");
  ok(t2.typing === false, "typing false relayed (never throttled)");
  // Nothing else about typing arrived from Alice: the throttled frame never reached Bob.
  ok(
    !bob.inbox.some((m) => m.type === "typing" && m.user_id === alice.userId),
    "second typing true within 1s was not delivered",
  );
  // After 1.1s the throttle window has passed and a `true` goes through again.
  await new Promise((r) => setTimeout(r, 1100));
  alice.send({ type: "typing", room_id: room.id, typing: true });
  await bob.wait(type("typing", (m) => m.user_id === alice.userId && m.typing), "typing true after throttle window");
  ok(true, "typing true accepted again after the 1s window");
  // By now Mallory's frames (sent first) have long been handled.
  ok(!mallory.inbox.some((m) => m.type === "error"), "typing from a non-member gets no error frame");
  ok(
    ![alice, bob].some((c) => c.inbox.some((m) => m.type === "typing" && m.user_id === mallory.userId)),
    "typing from a non-member is not broadcast",
  );
  mallory.close();
}

// Alice triggers an AI reply; her client streams it.
const trigger = uuid();
alice.send({ type: "send_message", room_id: room.id, id: trigger, content: "Let's generate a square.", ai_requested: true });
await bob.wait(type("message", (m) => m.message.id === trigger), "trigger message");
const aiA = uuid();
alice.send({ type: "ai_start", room_id: room.id, id: aiA, anchor_id: trigger, model: "model-a" });
alice.send({ type: "ai_reasoning", room_id: room.id, id: aiA, delta: "Squares have four equal sides." });
alice.send({ type: "ai_tool", room_id: room.id, id: aiA, activity: { call_id: "c1", server: "Files", tool: "read", status: "running" } });
alice.send({ type: "ai_tool", room_id: room.id, id: aiA, activity: { call_id: "c1", server: "Files", tool: "read", status: "done" } });
const attId = uuid();
const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwAEAQH/7dJ4ZwAAAABJRU5ErkJggg==";
alice.send({ type: "ai_attachment", room_id: room.id, id: aiA, attachment: { attachment_id: attId, mime: "image/png", call_id: "c1", width: 1, height: 1 }, data: pngB64 });
alice.send({ type: "ai_attachment", room_id: room.id, id: aiA, attachment: { attachment_id: uuid(), mime: "text/html", call_id: "c1" }, data: "PGI+" });
alice.send({ type: "ai_delta", room_id: room.id, id: aiA, delta: "Here is " });
// Concurrent reply from Bob's profile anchored to the same message (regenerate).
const aiB = uuid();
bob.send({ type: "ai_start", room_id: room.id, id: aiB, anchor_id: trigger, model: "model-b" });
bob.send({ type: "ai_delta", room_id: room.id, id: aiB, delta: "Bob's " });
// Bob must not be able to write into Alice's stream.
bob.send({ type: "ai_delta", room_id: room.id, id: aiA, delta: "HIJACK" });
alice.send({ type: "ai_delta", room_id: room.id, id: aiA, delta: "a square." });
alice.send({ type: "ai_complete", room_id: room.id, id: aiA, content: "Here is a square." });
const start = await bob.wait(type("message", (m) => m.message.id === aiA), "ai_start broadcast");
ok(start.message.status === "streaming" && start.message.model === "model-a" && start.message.author_name === "Alice", "AI message labeled via Alice · model-a");
const reasoning = await bob.wait(type("ai_reasoning", (m) => m.id === aiA), "ai_reasoning");
ok(reasoning.delta === "Squares have four equal sides.", "reasoning relayed");
await bob.wait(type("ai_tool", (m) => m.id === aiA && m.activity.status === "running"), "ai_tool running");
await bob.wait(type("ai_tool", (m) => m.id === aiA && m.activity.status === "done"), "ai_tool done");
ok(true, "tool activity relayed (names and status only)");
const att = await bob.wait(type("ai_attachment", (m) => m.id === aiA), "ai_attachment");
ok(att.attachment.attachment_id === attId && att.data === undefined, "image attachment announced without its bytes");
await alice.wait(type("error", (m) => /Image rejected/.test(m.message)), "non-image rejected");
ok(true, "non-image attachment rejected");
bob.send({ type: "get_attachment", attachment_id: attId });
const fetched = await bob.wait(type("attachment", (m) => m.attachment_id === attId), "attachment data");
ok(fetched.data === pngB64 && fetched.mime === "image/png", "image bytes fetched on demand by a room member");
const deltas = [];
deltas.push((await bob.wait(type("ai_delta", (m) => m.id === aiA), "delta 1")).delta);
deltas.push((await bob.wait(type("ai_delta", (m) => m.id === aiA), "delta 2")).delta);
ok(deltas.join("") === "Here is a square.", "Bob received Alice's deltas in order, no hijack");
await bob.wait(type("ai_complete", (m) => m.id === aiA), "ai_complete");
ok(true, "ai_complete relayed");

// Bob uploads an image and disconnects mid-stream -> interrupted, image kept.
const bobAtt = uuid();
bob.send({ type: "ai_attachment", room_id: room.id, id: aiB, attachment: { attachment_id: bobAtt, mime: "image/png", call_id: "b1", width: 1, height: 1 }, data: pngB64 });
bob.close();
const intr = await alice.wait(type("ai_interrupted", (m) => m.id === aiB), "ai_interrupted");
ok(intr.content === "Bob's ", "Bob's in-flight reply marked interrupted with partial text");
await alice.wait(type("presence", (m) => m.user_id === bob.userId && !m.online), "presence offline");
ok(true, "Bob shown offline");

// Errors are relayed.
const t2 = uuid();
alice.send({ type: "send_message", room_id: room.id, id: t2, content: "again", ai_requested: true });
const aiErr = uuid();
alice.send({ type: "ai_start", room_id: room.id, id: aiErr, anchor_id: t2, model: "m" });
alice.send({ type: "ai_error", room_id: room.id, id: aiErr, error: "HTTP 401: invalid key" });
await alice.wait(type("ai_error", (m) => m.id === aiErr), "ai_error");
ok(true, "ai_error relayed");

alice.send({ type: "set_room_prompt", room_id: room.id, system_prompt: "Be brief." });
await alice.wait(type("room_updated", (m) => m.system_prompt === "Be brief."), "room_updated");
ok(true, "room prompt updated");

// Persistence: a fresh connection sees the full history with final statuses.
const bob2 = new Client("Bob");
bob2.userId = bob.userId;
await bob2.open();
const welcome = await bob2.wait(type("welcome"), "welcome");
ok(welcome.rooms.some((r) => r.id === room.id && r.system_prompt === "Be brief."), "Bob's rooms restored on reconnect");
bob2.send({ type: "open_room", room_id: room.id });
const hist = await bob2.wait(type("room_history"), "room_history");
const status = Object.fromEntries(hist.messages.map((m) => [m.id, m.status]));
ok(
  status[aiA] === "complete" && status[aiB] === "interrupted" && status[aiErr] === "error" && hist.messages.length === 6,
  "history persisted: complete / interrupted / error statuses",
);
const finalA = hist.messages.find((m) => m.id === aiA);
ok(finalA.content === "Here is a square.", "final AI text persisted");
ok(finalA.reasoning === "Squares have four equal sides." && finalA.tools.length === 1 && finalA.tools[0].status === "done", "reasoning and tool activity persisted");
ok(finalA.attachments.length === 1 && finalA.attachments[0].attachment_id === attId, "attachment metadata persisted");
const finalB = hist.messages.find((m) => m.id === aiB);
ok(finalB.attachments.some((a) => a.attachment_id === bobAtt), "image uploaded just before a disconnect stays in history");

alice.close();
bob2.close();
console.log("\nAll relay smoke tests passed.");
process.exit(0);
