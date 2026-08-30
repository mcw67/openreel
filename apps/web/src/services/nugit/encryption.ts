/**
 * Port of nugit's client-side V4 encryption format.
 *
 * This is a byte-for-byte port of `encryptFile()` from nugit's own frontend
 * (`front/src/lib/encryption.ts`, the function `uploadStore.ts` actually calls
 * for every upload) — NOT a reimplementation. nugit's server is the decrypt
 * oracle for this format; any drift here produces a file the server cannot
 * open. See nugit's `brains/magic-folder-mvp-spec.md` §4, which documents
 * this exact port contract for the Sluice desktop app — this is the browser
 * equivalent of that port.
 *
 * V4 format: 10MiB chunks, PBKDF2(password, salt, 50000, SHA-256) -> AES-GCM-256.
 * Header (57 bytes): version(1)=4 . salt(16) . chunkSize(4 BE) . chunkCount(4 BE) . hash(32, zero)
 * Per chunk: IV(12, random) . AES-GCM ciphertext (tag(16) appended by WebCrypto).
 */

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MiB - must match nugit's CHUNK_SIZE exactly.

export interface NugitEncryptionResult {
  blob: Blob;
  salt: Uint8Array;
  chunkCount: number;
  originalSize: number;
  generatedPassword: string;
}

export interface NugitEncryptionProgress {
  stage: "preparing" | "encrypting" | "finalizing";
  percent: number;
}

/** Matches nugit's `generatePassword()` — 32 random bytes as 64-char hex. */
export function generateNugitPassword(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Plaintext SHA-256, hex-encoded. Same algorithm/output as nugit's
 * `computeFileHash` (which uses hash-wasm for streaming reads); this operates
 * directly on an in-memory buffer since the export blob is already fully
 * buffered by `createNugitVaultWritable`, so no extra dependency is needed.
 */
export async function computeNugitFileHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encrypt a Blob into a nugit V4 ciphertext blob. Server-key mode only
 * (password is always auto-generated and returned) — this editor never
 * offers zero-knowledge/private-key export, matching the "server-key so it
 * can be streamed/sold later" default used by nugit's own upload flow and by
 * Sluice.
 */
export async function encryptForNugitVault(
  file: Blob,
  onProgress?: (progress: NugitEncryptionProgress) => void,
): Promise<NugitEncryptionResult> {
  const password = generateNugitPassword();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 50000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const fileSize = file.size;
  const chunkCount = Math.ceil(fileSize / CHUNK_SIZE);

  onProgress?.({ stage: "preparing", percent: 0 });

  // V4 header: version(1) + salt(16) + chunkSize(4 BE) + chunkCount(4 BE) + hash(32, zero).
  const header = new Uint8Array(1 + 16 + 4 + 4 + 32);
  let offset = 0;
  header[offset++] = 4;
  header.set(salt, offset);
  offset += 16;
  const chunkSizeView = new DataView(new ArrayBuffer(4));
  chunkSizeView.setUint32(0, CHUNK_SIZE, false);
  header.set(new Uint8Array(chunkSizeView.buffer), offset);
  offset += 4;
  const chunkCountView = new DataView(new ArrayBuffer(4));
  chunkCountView.setUint32(0, chunkCount, false);
  header.set(new Uint8Array(chunkCountView.buffer), offset);
  // Remaining 32 bytes (hash) stay zero — V4 authenticates per-chunk via GCM tags.

  // Flat parts array, single Blob construction at the end — nesting
  // intermediate Blobs (as `new Blob([resultBlob, chunk])` per iteration
  // would) makes Safari retain every wrapper's buffer until the whole chain
  // is consumed, which is exactly the memory bug nugit's own port comment
  // warns about for multi-hundred-MB files.
  const parts: BlobPart[] = [header];

  for (let i = 0; i < chunkCount; i++) {
    onProgress?.({
      stage: "encrypting",
      percent: Math.round((i / chunkCount) * 100),
    });

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const chunkBuffer = await file.slice(start, end).arrayBuffer();

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedChunk = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, chunkBuffer);

    const chunkData = new Uint8Array(12 + encryptedChunk.byteLength);
    chunkData.set(iv, 0);
    chunkData.set(new Uint8Array(encryptedChunk), 12);
    parts.push(chunkData);
  }

  onProgress?.({ stage: "finalizing", percent: 100 });

  return {
    blob: new Blob(parts, { type: "application/octet-stream" }),
    salt,
    chunkCount,
    originalSize: fileSize,
    generatedPassword: password,
  };
}
