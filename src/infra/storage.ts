import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Object storage port (S3 in AWS, MinIO locally — same API, zero cost in dev). */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  ensureBucket(): Promise<void>;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly opts: {
      bucket: string;
      region: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    },
  ) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
      ...(opts.accessKeyId && opts.secretAccessKey
        ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
        : {}), // otherwise the default chain (IRSA in EKS)
      maxAttempts: 3, // SDK-level retries with backoff
    });
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // In AWS the bucket enforces SSE-KMS by default policy; MinIO dev runs without KMS.
        ...(this.opts.endpoint ? {} : { ServerSideEncryption: 'aws:kms' as const }),
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    if (!res.Body) throw new Error(`object ${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async ensureBucket() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.opts.bucket }));
    }
  }
}

/** Test/dev fallback. */
export class InMemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) throw new Error(`object ${key} not found`);
    return v;
  }
  async ensureBucket() {}
}
