import { createHash, randomBytes } from "node:crypto";

export function hashToken(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function mintToken() {
  const secret = `hth_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 12), hash: hashToken(secret) };
}
