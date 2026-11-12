import { AwsClient } from "aws4fetch";
import {
  StorageObjectTooLargeError,
  type ObjectStorage,
  type SignedUpload,
  type StorageGetOptions,
} from "./memory.js";

export const MAX_SIGNED_URL_TTL_SECONDS = 3_600;

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Storage(
  config: R2Config,
  fetchImpl: typeof fetch = fetch,
): ObjectStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucket)}`;

  return {
    async createUploadUrl(input: SignedUpload): Promise<string> {
      assertValidSignedUrlTtl(input.expiresInSeconds);
      if (!Number.isInteger(input.contentLength) || input.contentLength < 1) {
        throw new Error("Signed upload contentLength must be a positive integer");
      }
      return sign(client, base, input.key, "PUT", input.expiresInSeconds, {
        "content-type": input.contentType,
        "content-length": String(input.contentLength),
      });
    },

    async createDownloadUrl(input): Promise<string> {
      assertValidSignedUrlTtl(input.expiresInSeconds);
      return sign(client, base, input.key, "GET", input.expiresInSeconds);
    },

    async get(key: string, options?: StorageGetOptions): Promise<Uint8Array | null> {
      const url = new URL(`${base}/${encodeKey(key)}`);
      const signed = await client.sign(new Request(url, { method: "GET" }));
      const response = await fetchImpl(signed);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error("Object storage read failed");
      }
      return readBodyLimited(response, options?.maxBytes);
    },

    async delete(key: string): Promise<void> {
      const url = new URL(`${base}/${encodeKey(key)}`);
      const signed = await client.sign(new Request(url, { method: "DELETE" }));
      const response = await fetchImpl(signed);
      if (response.status === 404 || response.ok) {
        return;
      }
      throw new Error("Object storage delete failed");
    },
  };
}

async function readBodyLimited(
  response: Response,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  if (maxBytes !== undefined) {
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new StorageObjectTooLargeError(maxBytes);
      }
    }
  }

  if (!response.body || maxBytes === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new StorageObjectTooLargeError(maxBytes);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new StorageObjectTooLargeError(maxBytes);
    }
    chunks.push(step.value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function assertValidSignedUrlTtl(expiresInSeconds: number): void {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS
  ) {
    throw new Error(
      `Signed URL TTL must be an integer from 1 to ${MAX_SIGNED_URL_TTL_SECONDS} seconds`,
    );
  }
}

async function sign(
  client: AwsClient,
  base: string,
  key: string,
  method: "GET" | "PUT",
  expiresInSeconds: number,
  headers?: Record<string, string>,
): Promise<string> {
  const url = new URL(`${base}/${encodeKey(key)}`);
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await client.sign(url.toString(), {
    method,
    ...(headers ? { headers } : {}),
    aws: {
      signQuery: true,
      allHeaders: headers !== undefined,
    },
  });
  return signed.url;
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
