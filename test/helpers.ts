import { createDb, type Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { handleIncoming } from "../src/engine.js";
import { hashPhone } from "../src/privacy.js";

export async function freshDb(): Promise<Db> {
  const db = await createDb({ memory: true });
  await seedDemo(db, { staffPassword: "test-pass" });
  return db;
}

// A simulated girl: sends messages and reads Ubah's replies from the outbox.
export function girl(db: Db, phone = "0712000001", channel: "simulator" | "sms" | "whatsapp" = "simulator") {
  let seen = 0;
  const replies = async () => {
    const rows = await db.query<{ id: number; body: string }>(`SELECT id, body FROM outbox WHERE to_hash = $1 ORDER BY id`, [hashPhone(phone)]);
    const fresh = rows.slice(seen).map((r) => r.body);
    seen = rows.length;
    return fresh;
  };
  return {
    phone,
    async send(text: string) {
      await handleIncoming(db, { channel, from: phone, text });
      return (await replies()).join("\n---\n");
    },
    async voice(spoken: string) {
      await handleIncoming(db, { channel, from: phone, voice: { audio: Buffer.from("fake"), mimeType: "audio/ogg", mockText: spoken } });
      return (await replies()).join("\n---\n");
    },
    replies,
  };
}
