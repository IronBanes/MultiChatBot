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
  // A repeated `false` (nothing to end) is dropped.
  alice.send({ type: "typing", room_id: room.id, typing: false });
  // After 1.1s the throttle window has passed and a `true` goes through again.
  await new Promise((r) => setTimeout(r, 1100));
  alice.send({ type: "typing", room_id: room.id, typing: true });
  await bob.wait(type("typing", (m) => m.user_id === alice.userId && m.typing), "typing true after throttle window");
  ok(true, "typing true accepted again after the 1s window");
  ok(
    !bob.inbox.some((m) => m.type === "typing" && m.user_id === alice.userId),
    "a repeated typing false is not relayed",
  );
  // A second device of Alice's account: one device stopping while the other still
  // types doesn't end Alice's indicator; the last one stopping does.
  const alice2 = new Client("Alice");
  alice2.userId = alice.userId;
  await alice2.open();
  await alice2.wait(type("welcome"), "welcome (second device)");
  alice2.send({ type: "typing", room_id: room.id, typing: true });
  await bob.wait(type("typing", (m) => m.user_id === alice.userId && m.typing), "typing true (second device)");
  alice2.send({ type: "typing", room_id: room.id, typing: false });
  // Barrier: a reaction alice2 sends after its stop reaches Bob after anything that
  // stop would have broadcast, so by then Bob must have seen no typing false.
  const barrier = { type: "react", room_id: room.id, message_id: human.message.id, emoji: "👀" };
  alice2.send({ ...barrier, on: true });
  await bob.wait(type("reactions", (m) => m.message_id === human.message.id), "barrier reaction");
  ok(
    !bob.inbox.some((m) => m.type === "typing" && m.user_id === alice.userId),
    "one device stopping while another types sends no typing false",
  );
  alice2.send({ ...barrier, on: false });
  await bob.wait(type("reactions", (m) => m.message_id === human.message.id), "barrier reaction removed");
  alice.send({ type: "typing", room_id: room.id, typing: false });
  const last = await bob.wait(type("typing", (m) => m.user_id === alice.userId), "typing false (last device)");
  ok(last.typing === false, "the last device stopping sends typing false");
  alice2.close();
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

// Older messages: a fresh room with 205 human messages pages its history.
{
  alice.send({ type: "create_room", request_id: "r3", name: "Deep history" });
  const big = await alice.wait(type("room_joined", (m) => m.request_id === "r3"), "room_joined (deep history)");
  const bigRoom = big.room;
  for (let i = 1; i <= 205; i++) {
    alice.send({ type: "send_message", room_id: bigRoom.id, id: uuid(), content: `m${i}`, ai_requested: false });
  }
  alice.send({ type: "open_room", room_id: bigRoom.id });
  const hist = await alice.wait(type("room_history", (m) => m.room_id === bigRoom.id), "room_history (paged)", 20000);
  ok(hist.messages.length === 200 && hist.has_more === true, "room_history holds the newest 200 messages with has_more: true");
  ok(hist.messages[hist.messages.length - 1].content === "m205", "the history page ends at the newest message");
  const before = hist.messages[0].seq;
  alice.send({ type: "load_older", room_id: bigRoom.id, before_seq: before });
  const older = await alice.wait(type("older_messages"), "older_messages", 20000);
  ok(older.messages.length === 5, "load_older returns the 5 messages before the page start");
  ok(older.messages.map((m) => m.content).join(",") === "m1,m2,m3,m4,m5", "older messages are oldest first");
  ok(older.messages.every((m) => m.seq < before), "every older message predates before_seq");
  ok(older.has_more === false, "has_more: false once the history is exhausted");
  // Asking past the very first message: an empty page with has_more: false.
  alice.send({ type: "load_older", room_id: bigRoom.id, before_seq: older.messages[0].seq });
  const empty = await alice.wait(type("older_messages"), "older_messages (empty page)");
  ok(empty.messages.length === 0 && empty.has_more === false, "an empty page is a valid answer");
  // A search jump target: load_older with until_seq reaches back to it. Message
  // 3 sits below the loaded page (m6 and up), so the page must stretch down.
  const targetSeq = older.messages.find((m) => m.content === "m3").seq;
  alice.send({ type: "load_older", room_id: bigRoom.id, before_seq: before, until_seq: targetSeq });
  const deep = await alice.wait(type("older_messages"), "older_messages (until_seq)", 20000);
  ok(
    deep.messages.some((m) => m.content === "m3"),
    "load_older with until_seq returns a page that includes the target message",
  );
  // A non-member is refused.
  const mallory = new Client("Mallory");
  await mallory.open();
  await mallory.wait(type("welcome"), "welcome (non-member)");
  mallory.send({ type: "load_older", room_id: bigRoom.id, before_seq: before });
  await mallory.wait(type("error", (m) => /Not a member/.test(m.message)), "load_older refused for a non-member");
  ok(true, "load_older from a non-member gets an error frame");
  mallory.close();
}

// Message search: FTS hits with markers, edits and deletes reflected live, and
// a non-member refused with the request id.
{
  alice.send({ type: "create_room", request_id: "r4", name: "Search room" });
  const created = await alice.wait(type("room_joined", (m) => m.request_id === "r4"), "room_joined (search room)");
  const sroom = created.room;
  const send = async (content) => {
    const id = uuid();
    alice.send({ type: "send_message", room_id: sroom.id, id, content, ai_requested: false });
    await alice.wait(type("message", (m) => m.message.id === id), `message "${content}"`);
    return id;
  };
  const fox = await send("the quick brown fox");
  await send("lazy dog");
  const think = await send("Quick thinking");
  // "quick" matches two messages, newest first, with the STX marker in snippets.
  alice.send({ type: "search_messages", request_id: "s1", room_id: sroom.id, query: "quick" });
  const res = await alice.wait(type("search_results", (m) => m.request_id === "s1"), "search_results");
  ok(res.hits.length === 2, `search "quick" returns 2 hits (got ${res.hits.length})`);
  ok(res.hits[0].id === think && res.hits[1].id === fox, "search hits are newest first");
  ok(res.hits.every((h) => h.snippet.includes("\u0002")), "each snippet marks the matched word with the STX character");
  ok(res.hits.every((h) => h.author_name === "Alice"), "hits carry the author name");
  // Editing the word away removes the hit.
  alice.send({ type: "edit_message", room_id: sroom.id, message_id: fox, content: "the slow brown fox" });
  await alice.wait(type("message_updated", (m) => m.message.id === fox), "message_updated (edit)");
  alice.send({ type: "search_messages", request_id: "s2", room_id: sroom.id, query: "quick" });
  const res2 = await alice.wait(type("search_results", (m) => m.request_id === "s2"), "search_results (after edit)");
  ok(res2.hits.length === 1 && res2.hits[0].id === think, "an edit that removes the word drops the hit");
  // Deleting the other match leaves nothing.
  alice.send({ type: "delete_message", room_id: sroom.id, message_id: think });
  await alice.wait(type("message_updated", (m) => m.message.id === think), "message_updated (delete)");
  alice.send({ type: "search_messages", request_id: "s3", room_id: sroom.id, query: "quick" });
  const res3 = await alice.wait(type("search_results", (m) => m.request_id === "s3"), "search_results (after delete)");
  ok(res3.hits.length === 0, "a deleted message is not found");
  // A non-member gets the error with their request_id.
  const mallory = new Client("Mallory");
  await mallory.open();
  await mallory.wait(type("welcome"), "welcome (search non-member)");
  mallory.send({ type: "search_messages", request_id: "s4", room_id: sroom.id, query: "quick" });
  const denied = await mallory.wait(type("error", (m) => m.request_id === "s4"), "search refused for a non-member");
  ok(/Not a member/.test(denied.message), "search from a non-member gets an error frame with the request_id");
  mallory.close();
}

alice.close();
bob2.close();
console.log("\nAll relay smoke tests passed.");
process.exit(0);
