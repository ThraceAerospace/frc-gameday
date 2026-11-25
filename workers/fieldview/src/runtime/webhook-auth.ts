/** Verify The Blue Alliance's X-TBA-HMAC over the exact raw request body. */
export async function verifyTbaWebhookHmac(
  secret: string,
  signature: string | null,
  rawBody: ArrayBuffer,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<boolean> {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await subtle.sign("HMAC", key, rawBody);
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const actual = signature.toLowerCase();
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}
