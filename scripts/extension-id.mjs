// The Chrome extension ID of an unpacked extension whose manifest carries `key`: the first 128
// bits of the SHA-256 of the DER SubjectPublicKeyInfo, each hex digit mapped 0-f to a-p.
import { createHash } from "node:crypto";

/**
 * @param {string} b64Der base64 DER public key; whitespace (line wrapping) is ignored
 * @returns {string} 32 characters in a-p
 */
export function extensionIdFromKey(b64Der) {
  const compact = String(b64Der).replace(/\s+/g, "");
  if (compact.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("extension key is not base64");
  }
  const der = Buffer.from(compact, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join("");
}
