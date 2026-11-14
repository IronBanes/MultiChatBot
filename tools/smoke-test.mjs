// Protocol smoke test: two fake clients exercise the relay end to end.
// Usage: node tools/smoke-test.mjs [ws://127.0.0.1:8787/ws]   (needs Node 22+ for global WebSocket)

const URL_ = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const uuid = () => crypto.randomUUID();

class Client {
  constructor(name) {
    this.name = name;
    this.userId = uuid();
    // Signs in to the account; another device of the same account copies it.
    this.secret = uuid().replaceAll("-", "") + uuid().replaceAll("-", "");
    // Optional device identity for linked-device tests (same account, own device).
    this.deviceId = "";
    this.deviceName = "";
    this.platform = "";
    this.inbox = [];
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_);
      this.ws.onopen = () => {
        this.send({
          type: "hello",
          user_id: this.userId,
          display_name: this.name,
          device_id: this.deviceId,
          device_name: this.deviceName,
          platform: this.platform,
          secret: this.secret,
        });
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
  alice2.secret = alice.secret;
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

// Room summaries: a member's AI shares the summary the whole room then uses;
// only a newer one is accepted, so a repeat never broadcasts.
{
  const upto = human.message.seq; // the "hi humans" message sent earlier
  alice.send({ type: "set_room_summary", room_id: room.id, summary: "Bob said hi.", upto_seq: upto });
  const sum = await alice.wait(type("room_summary", (m) => m.upto_seq === upto), "room_summary");
  ok(sum.summary === "Bob said hi." && sum.updated_by === alice.userId, "a room summary is stored and broadcast to the room");
  // The same `upto_seq` again is refused: no second room_summary.
  alice.send({ type: "set_room_summary", room_id: room.id, summary: "Stale.", upto_seq: upto });
  await new Promise((r) => setTimeout(r, 150));
  ok(!alice.inbox.some((m) => m.type === "room_summary" && m.summary === "Stale."), "an equal upto_seq never broadcasts a second summary");
}

// Persistence: a fresh connection sees the full history with final statuses.
const bob2 = new Client("Bob");
bob2.userId = bob.userId;
bob2.secret = bob.secret;
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

// Delegated AI (device linking phase 2): a PC shares its profiles; a phone of
// the SAME user (same user_id, its own device_id) asks it to reply.
{
  alice.send({ type: "create_room", request_id: "r5", name: "Delegated AI" });
  const created = await alice.wait(type("room_joined", (m) => m.request_id === "r5"), "room_joined (delegated AI)");
  const droom = created.room;

  const pc = new Client("Alice");
  pc.userId = alice.userId; // same account, another device
  pc.secret = alice.secret;
  pc.deviceId = "pc-1";
  pc.deviceName = "Office PC";
  pc.platform = "windows";
  await pc.open();
  await pc.wait(type("welcome"), "welcome (PC)");
  pc.send({ type: "join_room", request_id: "r6", invite_code: droom.invite_code });
  await pc.wait(type("room_joined", (m) => m.request_id === "r6"), "room_joined (PC)");

  const phone = new Client("Alice");
  phone.userId = alice.userId; // same account, the phone
  phone.secret = alice.secret;
  phone.deviceId = "phone-1";
  phone.deviceName = "Pixel";
  phone.platform = "android";
  await phone.open();
  await phone.wait(type("welcome"), "welcome (phone)");
  phone.send({ type: "join_room", request_id: "r7", invite_code: droom.invite_code });
  await phone.wait(type("room_joined", (m) => m.request_id === "r7"), "room_joined (phone)");
  // The account's other devices hear about a room one of them creates, without a request id.
  phone.send({ type: "create_room", request_id: "r7b", name: "Made on the phone" });
  const made = await phone.wait(type("room_joined", (m) => m.request_id === "r7b"), "room_joined (phone creates)");
  const told = await pc.wait(type("room_joined", (m) => m.room.id === made.room.id), "room_joined (PC told)");
  ok(told.request_id === null && told.room.name === "Made on the phone", "a room created on one device reaches the account's other devices");

  // Bob (another user) joins too, to see nothing of this.
  const bobd = new Client("Bob");
  // A real device of another user, in the room: request_ai must still not reach it.
  bobd.deviceId = "bob-dev";
  bobd.deviceName = "Bob's PC";
  bobd.platform = "windows";
  await bobd.open();
  bobd.send({ type: "join_room", request_id: "r8", invite_code: droom.invite_code });
  await bobd.wait(type("room_joined", (m) => m.request_id === "r8"), "room_joined (Bob, delegated room)");

  // The PC shares one profile.
  pc.send({ type: "share_profiles", profiles: [{ id: "prof-1", label: "Claude", model: "claude-opus-5-5" }] });
  const devPc = await phone.wait(
    type("devices", (m) => m.devices.some((d) => d.device_id === "pc-1" && d.profiles.some((p) => p.id === "prof-1"))),
    "devices with the PC's shared profile (phone)",
  );
  ok(devPc.devices.some((d) => d.device_id === "pc-1" && d.profiles.length === 1 && d.profiles[0].model === "claude-opus-5-5"),
    "the PC's shared profile reaches the user's other connections");
  await pc.wait(
    type("devices", (m) => m.devices.some((d) => d.device_id === "pc-1" && d.profiles.length === 1)),
    "devices with the shared profile (PC)",
  );

  // The phone asks the PC to reply to its message with that profile.
  const anchorId = uuid();
  phone.send({ type: "send_message", room_id: droom.id, id: anchorId, content: "please answer from the PC", ai_requested: true });
  const anchorMsg = await pc.wait(type("message", (m) => m.message.id === anchorId), "phone message reaches the PC");
  const reqId = uuid();
  phone.send({ type: "request_ai", request_id: reqId, room_id: droom.id, anchor_id: anchorId, device_id: "pc-1", profile_id: "prof-1" });
  const asked = await pc.wait(type("ai_requested", (m) => m.request_id === reqId), "ai_requested");
  ok(
    asked.room_id === droom.id && asked.anchor_id === anchorId && asked.profile_id === "prof-1" && asked.from_device_id === "phone-1",
    "ai_requested carries the same request, room, anchor, profile and the phone's device_id",
  );
  ok(asked.anchor_seq === anchorMsg.message.seq, "ai_requested carries the anchor's seq, to load back to it");
  ok(
    !bobd.inbox.some((m) => m.type === "ai_requested") && !alice.inbox.some((m) => m.type === "ai_requested"),
    "other users and other connections get nothing",
  );

  // The PC can't do it: the phone gets an error with that request_id.
  pc.send({ type: "ai_request_failed", request_id: reqId, to_device_id: "phone-1", message: "That AI profile isn't on this computer anymore" });
  const failed = await phone.wait(type("error", (m) => m.request_id === reqId), "error for the failed request");
  ok(/AI profile/.test(failed.message), "ai_request_failed reaches the asking device as an error frame");

  // Refusals: offline device, another user's device, an anchor in another room.
  phone.send({ type: "request_ai", request_id: "rq-off", room_id: droom.id, anchor_id: anchorId, device_id: "ghost", profile_id: "prof-1" });
  const off = await phone.wait(type("error", (m) => m.request_id === "rq-off"), "error (offline device)");
  ok(/offline/.test(off.message), "request_ai to an offline device is refused");
  phone.send({ type: "request_ai", request_id: "rq-foreign", room_id: droom.id, anchor_id: anchorId, device_id: "bob-dev", profile_id: "prof-1" });
  const foreign = await phone.wait(type("error", (m) => m.request_id === "rq-foreign"), "error (another user's device)");
  ok(/offline/.test(foreign.message), "request_ai to another user's device id is refused");
  ok(!bobd.inbox.some((m) => m.type === "ai_requested"), "another user's device never receives the request");
  phone.send({ type: "request_ai", request_id: "rq-anchor", room_id: droom.id, anchor_id: room.id, device_id: "pc-1", profile_id: "prof-1" });
  const badAnchor = await phone.wait(type("error", (m) => m.request_id === "rq-anchor"), "error (foreign anchor)");
  ok(/isn't in this room/.test(badAnchor.message), "request_ai anchored outside the room is refused");
  phone.send({ type: "request_ai", request_id: "rq-own", room_id: droom.id, anchor_id: anchorId, device_id: "phone-1", profile_id: "prof-1" });
  const own = await phone.wait(type("error", (m) => m.request_id === "rq-own"), "error (own device)");
  ok(/offline/.test(own.message), "request_ai to one's own connection is refused");

  // Remote control (device linking phase 3): the PC shares its servers and on/off state
  // only when allowed, and device commands stay between one account's devices.
  pc.send({
    type: "share_profiles",
    profiles: [{ id: "prof-1", label: "Claude", model: "m", enabled: false }],
    mcp_servers: [{ id: "srv-1", name: "Files", default_mode: "ask", room_modes: {} }],
    remote_control: false,
  });
  const quiet = await phone.wait(
    type("devices", (m) => m.devices.some((d) => d.device_id === "pc-1" && d.profiles[0]?.enabled === false)),
    "devices (remote control off)",
  );
  ok(quiet.devices.find((d) => d.device_id === "pc-1").mcp_servers.length === 0, "without remote control no MCP server is listed");

  pc.send({
    type: "share_profiles",
    profiles: [{ id: "prof-1", label: "Claude", model: "m", enabled: true }],
    mcp_servers: [
      { id: "srv-1", name: "Files", default_mode: "ask", room_modes: { [droom.id]: "off", bad: "root" } },
      { id: "srv-2", name: "Bogus", default_mode: "root", room_modes: {} },
    ],
    remote_control: true,
  });
  const allowed = await phone.wait(type("devices", (m) => m.devices.some((d) => d.remote_control)), "devices (remote control on)");
  const shared = allowed.devices.find((d) => d.device_id === "pc-1");
  ok(shared.mcp_servers.length === 1 && shared.mcp_servers[0].name === "Files", "a server with a bogus mode isn't listed");
  ok(!("command" in shared.mcp_servers[0]) && !("url" in shared.mcp_servers[0]), "only a server's name and modes are shared");
  ok(JSON.stringify(shared.mcp_servers[0].room_modes) === JSON.stringify({ [droom.id]: "off" }), "room modes pass; a bogus mode is dropped");

  const setMode = { kind: "set_mcp_mode", room_id: droom.id, server_id: "srv-1", mode: "ask" };
  phone.send({ type: "device_command", request_id: "dc1", device_id: "pc-1", command: setMode });
  const cmd = await pc.wait(type("device_command", (m) => m.request_id === "dc1"), "device_command");
  ok(cmd.from_device_id === "phone-1" && cmd.command.kind === "set_mcp_mode" && cmd.command.mode === "ask", "a device command reaches the target with the sender's device id");
  pc.send({ type: "device_reply", request_id: "dc1", to_device_id: "phone-1", error: null });
  await phone.wait(type("device_reply", (m) => m.request_id === "dc1"), "device_reply");
  ok(true, "a device's answer reaches the asking device");

  phone.send({ type: "device_command", request_id: "dc2", device_id: "pc-1", command: setMode });
  await pc.wait(type("device_command", (m) => m.request_id === "dc2"), "device_command (refused)");
  pc.send({ type: "device_reply", request_id: "dc2", to_device_id: "phone-1", error: "Remote control is off" });
  const refusedCmd = await phone.wait(type("error", (m) => m.request_id === "dc2"), "error (command refused)");
  ok(/Remote control/.test(refusedCmd.message), "a refused command reaches the asking device as an error frame");

  // Tool arguments go to that one device: not the room, not the other member.
  const approval = { kind: "tool_approval", room_id: droom.id, message_id: "m1", call_id: "c1", server: "Files", tool: "read", args: "SECRET-ARGS" };
  pc.send({ type: "device_command", request_id: "dc3", device_id: "phone-1", command: approval });
  const offered = await phone.wait(type("device_command", (m) => m.request_id === "dc3"), "tool_approval");
  ok(offered.command.args === "SECRET-ARGS", "a tool approval carries its arguments to the asking device");
  await new Promise((r) => setTimeout(r, 150));
  ok(![...bobd.inbox, ...alice.inbox].some((m) => JSON.stringify(m).includes("SECRET-ARGS")), "tool arguments never reach another user or connection");

  phone.send({ type: "device_command", request_id: "dc4", device_id: "bob-dev", command: setMode });
  const foreignCmd = await phone.wait(type("error", (m) => m.request_id === "dc4"), "error (command to another user)");
  ok(/offline/.test(foreignCmd.message), "a device command to another user's device is refused");
  ok(!bobd.inbox.some((m) => m.type === "device_command"), "another user's device never receives a command");
  phone.send({ type: "device_command", request_id: "dc5", device_id: "phone-1", command: setMode });
  const selfCmd = await phone.wait(type("error", (m) => m.request_id === "dc5"), "error (command to itself)");
  ok(/offline/.test(selfCmd.message), "a device command to one's own connection is refused");
  pc.send({ type: "device_reply", request_id: "dc6", to_device_id: "bob-dev", error: null });
  await new Promise((r) => setTimeout(r, 150));
  ok(!bobd.inbox.some((m) => m.type === "device_reply"), "a device reply can't reach another user's device");
  const huge = { ...approval, args: "x".repeat(70_000) };
  pc.send({ type: "device_command", request_id: "dc7", device_id: "phone-1", command: huge });
  const tooBig = await pc.wait(type("error", (m) => m.request_id === "dc7"), "error (command too large)");
  ok(/too large/.test(tooBig.message), "an oversized device command is refused");

  pc.close();
  phone.close();
  bobd.close();
}

// Lending tools to a room: one member's connection publishes its servers, the
// other's AI calls one, the lender answers, and only the right connections see
// any of it.
{
  // Bob's earlier connection closed mid-stream above, so this is a fresh one
  // on the same account.
  const bobL = new Client("Bob");
  bobL.userId = bob.userId;
  bobL.secret = bob.secret;
  bobL.deviceId = "bob-lend";
  await bobL.open();
  await bobL.wait(type("welcome"), "welcome (lending, Bob)");
  alice.send({ type: "create_room", request_id: "r-lend", name: "Lending" });
  const lentRoom = (await alice.wait(type("room_joined", (m) => m.request_id === "r-lend"), "room_joined (lending)")).room;
  bobL.send({ type: "join_room", request_id: "r-lend-join", invite_code: lentRoom.invite_code });
  await bobL.wait(type("room_joined", (m) => m.request_id === "r-lend-join"), "room_joined (lending, Bob)");

  // Alice lends one server with one tool.
  alice.send({
    type: "lend_tools",
    room_id: lentRoom.id,
    servers: [{ id: "srv-lend", name: "ComfyUI", tools: [{ name: "generate", description: "Make a picture", input_schema: { type: "object" } }] }],
  });
  const tools = await bobL.wait(type("room_tools", (m) => m.servers.length > 0), "room_tools (Bob)");
  ok(tools.user_id === alice.userId && tools.display_name === "Alice" && tools.servers.length === 1 && tools.servers[0].tools[0].name === "generate",
    "Bob hears what Alice lends, stamped with Alice's id and name");
  // Alice hears her own broadcast too (she's in the room); Bob's own join
  // may have brought another one, so just check one arrived at all.
  await new Promise((r) => setTimeout(r, 150));
  ok(alice.inbox.some((m) => m.type === "room_tools" && m.user_id === alice.userId && m.servers.length === 1),
    "the lender's own room_tools broadcast reaches the room (the lender included)");

  // Bob's AI calls the lent tool; Alice's connection gets it with Bob's real id.
  const req = uuid();
  bobL.send({ type: "call_lent_tool", request_id: req, room_id: lentRoom.id, user_id: alice.userId, device_id: tools.device_id, server_id: "srv-lend", tool: "generate", args: { prompt: "a cat" } });
  const call = await alice.wait(type("lent_tool_call", (m) => m.args?.prompt === "a cat"), "lent_tool_call");
  ok(call.request_id !== req, "the lender sees an id the relay made, not the caller's");
  ok(call.from_user_id === bob.userId && call.from_name === "Bob" && call.server_id === "srv-lend" && call.tool === "generate",
    "the lender receives the call stamped with the caller's real user id and name");
  ok(call.args && call.args.prompt === "a cat", "the lender receives the tool arguments");
  // Bob can't answer his own call, whichever id he tries.
  bobL.send({ type: "lent_tool_result", request_id: req, content: "forged", is_error: false, images: [] });
  bobL.send({ type: "lent_tool_result", request_id: call.request_id, content: "forged", is_error: false, images: [] });
  await new Promise((r) => setTimeout(r, 150));
  ok(!bobL.inbox.some((m) => m.type === "lent_tool_result" && m.request_id === req), "a lent_tool_result from the caller is ignored");

  // Alice answers; only Bob gets it.
  alice.send({ type: "lent_tool_result", request_id: call.request_id, content: "meow.png", is_error: false, images: [] });
  const result = await bobL.wait(type("lent_tool_result", (m) => m.request_id === req), "lent_tool_result (Bob)");
  ok(result.content === "meow.png" && result.is_error === false, "the lender's answer reaches the caller");
  // A second answer for a finished call goes nowhere.
  alice.send({ type: "lent_tool_result", request_id: call.request_id, content: "again", is_error: false, images: [] });
  await new Promise((r) => setTimeout(r, 150));
  ok(!bobL.inbox.some((m) => m.type === "lent_tool_result" && m.request_id === req && m.content === "again"),
    "a lent_tool_result for a finished call is ignored");

  // Another member claims Alice's device id and lends the same server: Bob's call to
  // Alice's account still reaches Alice, never the impostor.
  const carol = new Client("Carol");
  carol.deviceId = tools.device_id;
  await carol.open();
  await carol.wait(type("welcome"), "welcome (lending, Carol)");
  carol.send({ type: "join_room", request_id: "r-lend-carol", invite_code: lentRoom.invite_code });
  await carol.wait(type("room_joined", (m) => m.request_id === "r-lend-carol"), "room_joined (lending, Carol)");
  carol.send({
    type: "lend_tools",
    room_id: lentRoom.id,
    servers: [{ id: "srv-lend", name: "ComfyUI", tools: [{ name: "generate", description: "Make a picture", input_schema: { type: "object" } }] }],
  });
  await bobL.wait(type("room_tools", (m) => m.user_id === carol.userId && m.servers.length > 0), "room_tools (Carol)");
  bobL.send({ type: "call_lent_tool", request_id: uuid(), room_id: lentRoom.id, user_id: alice.userId, device_id: tools.device_id, server_id: "srv-lend", tool: "generate", args: { prompt: "a fox" } });
  const toAlice = await alice.wait(type("lent_tool_call", (m) => m.args?.prompt === "a fox"), "lent_tool_call (not to the impostor)");
  await new Promise((r) => setTimeout(r, 150));
  ok(!!toAlice && !carol.inbox.some((m) => m.type === "lent_tool_call"), "a call goes to the lender's account, not another member claiming its device id");
  alice.send({ type: "lent_tool_result", request_id: toAlice.request_id, content: "fox.png", is_error: false, images: [] });
  carol.close();

  // The caller cancels: the lender hears it under the relay's id.
  const req2 = uuid();
  bobL.send({ type: "call_lent_tool", request_id: req2, room_id: lentRoom.id, user_id: alice.userId, device_id: tools.device_id, server_id: "srv-lend", tool: "generate", args: { prompt: "a dog" } });
  const call2 = await alice.wait(type("lent_tool_call", (m) => m.args?.prompt === "a dog"), "lent_tool_call (to cancel)");
  bobL.send({ type: "cancel_lent_tool", request_id: req2 });
  await alice.wait(type("lent_tool_cancelled", (m) => m.request_id === call2.request_id), "lent_tool_cancelled");
  ok(true, "a cancelled call reaches the lender as lent_tool_cancelled");

  // A call to something that isn't lent is refused.
  bobL.send({ type: "call_lent_tool", request_id: "lend-missing", room_id: lentRoom.id, user_id: alice.userId, device_id: tools.device_id, server_id: "srv-lend", tool: "nope", args: {} });
  await bobL.wait(type("error", (m) => m.request_id === "lend-missing"), "error (tool not lent)");
  ok(true, "a call to a tool that isn't lent gets an error frame");

  // A non-member's call is refused.
  const mallory = new Client("Mallory");
  await mallory.open();
  await mallory.wait(type("welcome"), "welcome (lending non-member)");
  mallory.send({ type: "call_lent_tool", request_id: "lend-x", room_id: lentRoom.id, user_id: alice.userId, device_id: tools.device_id, server_id: "srv-lend", tool: "generate", args: { marker: "mallory-call" } });
  const refused = await mallory.wait(type("error", (m) => m.request_id === "lend-x"), "error (non-member call)");
  ok(/Not a member/.test(refused.message), "a call from a non-member gets an error frame");
  await new Promise((r) => setTimeout(r, 150));
  ok(!alice.inbox.some((m) => m.type === "lent_tool_call" && m.args?.marker === "mallory-call"), "the non-member's call never reaches the lender");
  mallory.close();
  bobL.close();
}

// Accounts are authenticated: knowing someone's user id (every room member does)
// isn't enough to connect as them; a link code hands over the account's secret.
{
  const fake = new Client("Alice");
  fake.userId = alice.userId; // the id is public, the secret isn't
  await fake.open();
  const refused = await fake.wait(type("error", (m) => /isn't signed in/.test(m.message)), "hello refused (wrong secret)");
  ok(!!refused, "hello with another user's id and the wrong secret is refused");
  ok(!fake.inbox.some((m) => m.type === "welcome" || m.type === "devices"), "the impostor gets no welcome or device list");
  fake.send({ type: "request_ai", request_id: "rq-fake", room_id: room.id, anchor_id: human.message.id, device_id: "pc-1", profile_id: "prof-1" });
  const unbound = await fake.wait(type("error", (m) => /hello first/.test(m.message)), "request_ai refused (not signed in)");
  ok(!!unbound, "an impostor can't send request_ai");
  fake.close();

  const blank = new Client("Alice");
  blank.userId = alice.userId;
  blank.secret = "";
  await blank.open();
  await blank.wait(type("error", (m) => /isn't signed in/.test(m.message)), "hello refused (no secret)");
  ok(true, "hello with no secret for an account that has one is refused");
  blank.close();

  // Linking: the code carries the account's secret to the new device.
  alice.send({ type: "create_link_code", request_id: "lc-bad", secret: "not-alices" });
  await alice.wait(type("error", (m) => m.request_id === "lc-bad"), "create_link_code refused (wrong secret)");
  ok(true, "create_link_code with the wrong secret is refused");
  alice.send({ type: "create_link_code", request_id: "lc1", secret: alice.secret });
  const lc = await alice.wait(type("link_code", (m) => m.request_id === "lc1"), "link_code");
  ok(/^[A-Z2-9]{8}$/.test(lc.code), "link codes are 8 characters (too many to guess in ten minutes)");
  const newdev = new Client("New phone");
  await newdev.open();
  await newdev.wait(type("welcome"), "welcome (new device, own account)");
  newdev.send({ type: "redeem_link_code", request_id: "rd1", code: lc.code });
  const linked = await newdev.wait(type("linked", (m) => m.request_id === "rd1"), "linked");
  ok(linked.user_id === alice.userId && linked.secret === alice.secret, "redeeming a link code hands over the account's id and secret");
  newdev.close();
  const asAlice = new Client("Alice");
  asAlice.userId = linked.user_id;
  asAlice.secret = linked.secret;
  await asAlice.open();
  const w = await asAlice.wait(type("welcome"), "welcome (linked device)");
  ok(w.user_id === alice.userId, "the linked device signs in to the account");
  asAlice.close();
}

alice.close();
bob2.close();
console.log("\nAll relay smoke tests passed.");
process.exit(0);
