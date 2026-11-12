import { describe, expect, it } from "vitest";
import { StorageObjectTooLargeError } from "./memory.js";
import { createR2Storage, MAX_SIGNED_URL_TTL_SECONDS } from "./r2.js";

const R2_CONFIG = {
  accountId: "acct123",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  bucket: "vervecv-private",
};

describe("createR2Storage", () => {
  it("creates scoped, short-lived PUT and GET signed URLs without leaking secrets", async () => {
    const storage = createR2Storage(R2_CONFIG);

    const putUrlString = await storage.createUploadUrl({
      key: "obj_1234",
      contentType: "application/pdf",
      contentLength: 2048,
      expiresInSeconds: 300,
    });
    const putUrl = new URL(putUrlString);
    expect(putUrl.origin).toBe("https://acct123.r2.cloudflarestorage.com");
    expect(putUrl.pathname).toBe("/vervecv-private/obj_1234");
    expect(putUrl.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(putUrl.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(putUrl.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(putUrl.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    expect(putUrlString).not.toContain(R2_CONFIG.secretAccessKey);

    const getUrlString = await storage.createDownloadUrl({
      key: "obj_1234",
      expiresInSeconds: 180,
    });
    const getUrl = new URL(getUrlString);
    expect(getUrl.pathname).toBe("/vervecv-private/obj_1234");
    expect(getUrl.searchParams.get("X-Amz-Expires")).toBe("180");
    expect(getUrlString).not.toContain(R2_CONFIG.secretAccessKey);
  });

  it("rejects out-of-range signed URL TTL values", async () => {
    const storage = createR2Storage(R2_CONFIG);
    await expect(
      storage.createDownloadUrl({ key: "obj_1", expiresInSeconds: 0 }),
    ).rejects.toThrow(/TTL/);
    await expect(
      storage.createDownloadUrl({
        key: "obj_1",
        expiresInSeconds: MAX_SIGNED_URL_TTL_SECONDS + 1,
      }),
    ).rejects.toThrow(/TTL/);
  });

  it("streams object reads with a maxBytes cap and treats 404 DELETE as idempotent success", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      if (req.method === "DELETE") {
        return new Response(null, { status: 404 });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(600));
          controller.enqueue(new Uint8Array(600));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    const storage = createR2Storage(R2_CONFIG, fakeFetch);
    await expect(storage.get("obj_oversize", { maxBytes: 1_000 })).rejects.toBeInstanceOf(
      StorageObjectTooLargeError,
    );
    await expect(storage.delete("obj_missing")).resolves.toBeUndefined();
  });
});
