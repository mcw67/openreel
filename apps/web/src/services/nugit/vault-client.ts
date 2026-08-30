/**
 * Uploads a finished export straight into a nugit creator's Vault.
 *
 * Same pipeline nugit's own "Sluice" desktop sync app uses (see nugit's
 * `brains/magic-folder-mvp-spec.md`), just running in this browser instead of
 * Electron: hash -> dedup/republish check -> client-side V4 encrypt -> upload
 * -> file into a dedicated vault collection. The API key this uses is scoped
 * upload/collection-only server-side (nugit's `SCOPE_UPLOAD` allowlist) — it
 * cannot reach money, account, or admin endpoints even if it leaks.
 *
 * Every export lands PRIVATE (no price/license fields are ever sent) — the
 * creator decides on nugit's own site whether/how to publish it.
 */

import { computeNugitFileHash, encryptForNugitVault, type NugitEncryptionProgress } from "./encryption";

const NUGIT_API_BASE = "https://nug-it-api-production.nugit.workers.dev";

// Matches nugit's own frontend thresholds (front/src/lib/encryption.ts) so
// upload behavior here is identical to a native nugit upload of the same size.
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
const PART_SIZE = 25 * 1024 * 1024;

const EDITOR_COLLECTION_NAME = "Editor";

export type NugitVaultUploadPhase =
  | "hashing"
  | "checking"
  | "encrypting"
  | "uploading"
  | "filing"
  | "complete";

export interface NugitVaultUploadProgress {
  phase: NugitVaultUploadPhase;
  percent: number;
}

export interface NugitVaultUploadResult {
  fileId: number;
  mediaId: string;
  deduped: boolean;
}

export class NugitVaultError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NugitVaultError";
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function nugitFetch(
  apiKey: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(`${NUGIT_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
  });
  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `nugit request failed (${response.status})`;
    const code = (data as { code?: string } | null)?.code;
    throw new NugitVaultError(message, code);
  }
  return data as T;
}

interface CheckHashResponse {
  exists: boolean;
  fileId?: number;
  mediaId?: string;
  crossUser?: boolean;
}

async function checkHash(apiKey: string, hash: string, size: number): Promise<CheckHashResponse> {
  const response = await nugitFetch(apiKey, "/api/upload/check-hash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash, size }),
  });
  return readJson<CheckHashResponse>(response);
}

interface UploadEncryptedResponse {
  fileId: number;
  mediaId: string;
  deduped?: boolean;
}

async function uploadEncryptedSingleShot(
  apiKey: string,
  title: string,
  originalName: string,
  mimeType: string,
  encrypted: {
    blob: Blob;
    salt: Uint8Array;
    chunkCount: number;
    originalSize: number;
    generatedPassword: string;
  },
  fileHash: string,
): Promise<UploadEncryptedResponse> {
  const form = new FormData();
  form.append("file", encrypted.blob, originalName);
  form.append("title", title);
  form.append("original_name", originalName);
  form.append("encryption_salt", uint8ArrayToBase64(encrypted.salt));
  form.append("original_size", String(encrypted.originalSize));
  form.append("file_hash", fileHash);
  form.append("mime_type", mimeType);
  form.append("chunk_count", String(encrypted.chunkCount));
  form.append("encryption_version", "4");
  form.append("key_mode", "server");
  form.append("decryption_password", encrypted.generatedPassword);

  const response = await nugitFetch(apiKey, "/api/upload-encrypted", {
    method: "POST",
    body: form,
  });
  return readJson<UploadEncryptedResponse>(response);
}

async function uploadEncryptedMultipart(
  apiKey: string,
  title: string,
  originalName: string,
  mimeType: string,
  encrypted: {
    blob: Blob;
    salt: Uint8Array;
    chunkCount: number;
    originalSize: number;
    generatedPassword: string;
  },
  fileHash: string,
  onProgress?: (percent: number) => void,
): Promise<UploadEncryptedResponse> {
  const initResponse = await nugitFetch(apiKey, "/api/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalName,
      mimeType,
      fileSize: encrypted.blob.size,
    }),
  });
  const init = await readJson<{ uploadId: string; objectKey: string; mediaId: string }>(initResponse);

  const totalParts = Math.ceil(encrypted.blob.size / PART_SIZE);
  const parts: Array<{ partNumber: number; etag: string }> = [];

  for (let i = 0; i < totalParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, encrypted.blob.size);
    const partBuffer = await encrypted.blob.slice(start, end).arrayBuffer();
    const partNumber = i + 1;

    const partResponse = await nugitFetch(
      apiKey,
      `/api/upload/part?key=${encodeURIComponent(init.objectKey)}&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=${partNumber}`,
      { method: "PUT", body: partBuffer },
    );
    const part = await readJson<{ partNumber: number; etag: string }>(partResponse);
    parts.push(part);
    onProgress?.(Math.round(((i + 1) / totalParts) * 100));
  }

  const completeResponse = await nugitFetch(apiKey, "/api/upload/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      objectKey: init.objectKey,
      uploadId: init.uploadId,
      mediaId: init.mediaId,
      parts,
      title,
      originalName,
      originalSize: encrypted.originalSize,
      mimeType,
      encryptionSalt: uint8ArrayToBase64(encrypted.salt),
      chunkCount: encrypted.chunkCount,
      decryptionPassword: encrypted.generatedPassword,
      fileHash,
      encryptionVersion: 4,
      keyMode: "server",
    }),
  });
  return readJson<UploadEncryptedResponse>(completeResponse);
}

interface CollectionSummary {
  collection_id: string;
  name: string;
  scope: string;
}

/**
 * GET /api/collections returns ONE flat `collections` array mixing library
 * ('library' scope) and vault ('vault' scope) collections together — verified
 * against `handleGetCollections` (int/src/handlers/collections/core.ts). Filter
 * by scope client-side; there is no separate vault-only field.
 */
async function findEditorCollection(apiKey: string): Promise<string | null> {
  const response = await nugitFetch(apiKey, "/api/collections", { method: "GET" });
  const listed = await readJson<{ collections: CollectionSummary[] }>(response);
  const existing = listed.collections.find((c) => c.scope === "vault" && c.name === EDITOR_COLLECTION_NAME);
  return existing?.collection_id ?? null;
}

/** Find-or-create the shared "Editor" vault collection, tolerating a create race. */
async function ensureEditorCollection(apiKey: string): Promise<string> {
  const existing = await findEditorCollection(apiKey);
  if (existing) return existing;

  const createResponse = await nugitFetch(apiKey, "/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: EDITOR_COLLECTION_NAME, scope: "vault" }),
  });

  if (createResponse.status === 400) {
    // Lost a create race (or the collection appeared between the GET and
    // here) — someone else's request won, refetch and use theirs.
    const found = await findEditorCollection(apiKey);
    if (found) return found;
    throw new NugitVaultError(`Could not find or create the "${EDITOR_COLLECTION_NAME}" vault collection`);
  }

  const created = await readJson<{ collection_id: string }>(createResponse);
  return created.collection_id;
}

async function addToEditorCollection(apiKey: string, collectionId: string, fileId: number): Promise<void> {
  const response = await nugitFetch(apiKey, `/api/vault-collections/${collectionId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media_id: fileId }),
  });
  if (response.status === 400) {
    // "Item already in collection" — not an error for our purposes.
    return;
  }
  await readJson<{ success: boolean }>(response);
}

/**
 * Encrypt and upload `file` into the signed-in nugit creator's Vault, filing
 * it into the shared "Editor" collection. Throws `NugitVaultError` on any
 * failure (including a 409 republish block) — callers should surface
 * `error.message` to the user rather than retry automatically.
 */
export async function uploadExportToNugitVault(
  file: Blob,
  filename: string,
  mimeType: string,
  title: string,
  apiKey: string,
  onProgress?: (progress: NugitVaultUploadProgress) => void,
): Promise<NugitVaultUploadResult> {
  onProgress?.({ phase: "hashing", percent: 0 });
  const plaintextBuffer = await file.arrayBuffer();
  const fileHash = await computeNugitFileHash(plaintextBuffer);

  onProgress?.({ phase: "checking", percent: 0 });
  const check = await checkHash(apiKey, fileHash, file.size);
  if (check.exists && !check.crossUser && check.fileId && check.mediaId) {
    // Already in this creator's Vault under this exact hash+size — skip
    // re-uploading, but still make sure it's filed in "Editor".
    const collectionId = await ensureEditorCollection(apiKey);
    await addToEditorCollection(apiKey, collectionId, check.fileId);
    onProgress?.({ phase: "complete", percent: 100 });
    return { fileId: check.fileId, mediaId: check.mediaId, deduped: true };
  }

  onProgress?.({ phase: "encrypting", percent: 0 });
  const encrypted = await encryptForNugitVault(new Blob([plaintextBuffer], { type: mimeType }), (p: NugitEncryptionProgress) => {
    onProgress?.({ phase: "encrypting", percent: p.percent });
  });

  onProgress?.({ phase: "uploading", percent: 0 });
  const uploadResult =
    encrypted.blob.size > MULTIPART_THRESHOLD
      ? await uploadEncryptedMultipart(apiKey, title, filename, mimeType, encrypted, fileHash, (percent) =>
          onProgress?.({ phase: "uploading", percent }),
        )
      : await uploadEncryptedSingleShot(apiKey, title, filename, mimeType, encrypted, fileHash);

  onProgress?.({ phase: "filing", percent: 0 });
  const collectionId = await ensureEditorCollection(apiKey);
  await addToEditorCollection(apiKey, collectionId, uploadResult.fileId);

  onProgress?.({ phase: "complete", percent: 100 });
  return { fileId: uploadResult.fileId, mediaId: uploadResult.mediaId, deduped: uploadResult.deduped ?? false };
}
