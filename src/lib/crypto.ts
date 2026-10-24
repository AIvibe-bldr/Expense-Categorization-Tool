import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export function localDir() {
  const p = process.env.GALAPAGOS_DATA_DIR || join(process.cwd(), ".local");
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}
function key() {
  const configured = process.env.DATA_ENCRYPTION_KEY;
  if (configured) {
    const b = Buffer.from(configured, "base64");
    if (b.length !== 32)
      throw Error("DATA_ENCRYPTION_KEY must be 32 bytes base64");
    return b;
  }
  if (
    process.env.GALAPAGOS_LOCAL_MODE !== "1" ||
    process.env.NODE_ENV === "production"
  )
    throw Error("Encryption key is required");
  const p = join(localDir(), "encryption.key");
  if (!existsSync(p))
    writeFileSync(p, randomBytes(32), { mode: 0o600, flag: "wx" });
  return readFileSync(p);
}
export function encrypt(text: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key(), iv);
  return Buffer.concat([
    iv,
    c.update(text, "utf8"),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
export function decrypt(text: string) {
  const b = Buffer.from(text, "base64"),
    d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(
    "utf8",
  );
}
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
