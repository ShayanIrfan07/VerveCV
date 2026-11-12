export interface SignedUpload {
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}

export interface StorageGetOptions {
  maxBytes?: number;
}

export class StorageObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Stored object exceeds maximum allowed size of ${maxBytes} bytes`);
    this.name = "StorageObjectTooLargeError";
  }
}

export interface ObjectStorage {
  createUploadUrl(input: SignedUpload): Promise<string>;
  createDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<string>;
  get(key: string, options?: StorageGetOptions): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();

  async createUploadUrl(input: SignedUpload): Promise<string> {
    return `memory://upload/${input.key}`;
  }

  async createDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<string> {
    return `memory://download/${input.key}`;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes);
  }

  async get(key: string, options?: StorageGetOptions): Promise<Uint8Array | null> {
    const found = this.objects.get(key) ?? null;
    if (found && options?.maxBytes !== undefined && found.byteLength > options.maxBytes) {
      throw new StorageObjectTooLargeError(options.maxBytes);
    }
    return found;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
