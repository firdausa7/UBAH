// Web push keys for the girls' space: npm run vapid-keys, then put both lines in .env.
import { newVapidKeys } from "../src/push.js";

const k = newVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
console.log("\nKeep the private key secret, and never change these once girls have switched notifications on.");
