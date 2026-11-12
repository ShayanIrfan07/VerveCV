import { AwsClient } from "aws4fetch";
import type { ObjectStorage, SignedUpload } from "./memory.js";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Storage(config: R2Config): ObjectStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;

  return {
    async createUploadUrl(input: SignedUpload): Promise<string> {
      return sign(client, base, input.key, "PUT", input.expiresInSeconds, {
        "content-type": input.contentType,
        "content-length": String(input.contentLength),
      });
    },
    async createDownloadUrl(input): Promise<string> {
      return sign(client, base, input.key, "GET", input.expiresInSeconds);
    },
    async get(key: string): Promise<Uint8Array | null> {
      const url = new URL(`${base}/${encodeKey(key)}`);
      const signed = await client.sign(new Request(url, { method: "GET" }));
      const response = await fetch(signed);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error("Object storage read failed");
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
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
  const signed = await client.sign(new Request(url, { method, headers }), { aws: { signQuery: true } });
  return signed.url;
}

function encodeKey(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}
