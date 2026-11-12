export interface SignedUpload {
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}

export interface ObjectStorage {
  createUploadUrl(input: SignedUpload): Promise<string>;
  createDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
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

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }
}
