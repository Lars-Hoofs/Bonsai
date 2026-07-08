import { Inject, Injectable } from '@nestjs/common';
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

/**
 * S3-compatible object storage (MinIO on the VPS) for raw uploaded files/media.
 * Optional: when not configured, `enabled` is false and callers skip storing
 * the raw bytes (text is still extracted and indexed). Path-style addressing is
 * used for MinIO compatibility.
 */
@Injectable()
export class StorageService {
  private readonly client?: S3Client;
  private readonly bucket?: string;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    if (cfg.s3Endpoint && cfg.s3Bucket && cfg.s3AccessKey && cfg.s3SecretKey) {
      this.client = new S3Client({
        endpoint: cfg.s3Endpoint,
        region: cfg.s3Region,
        credentials: {
          accessKeyId: cfg.s3AccessKey,
          secretAccessKey: cfg.s3SecretKey,
        },
        forcePathStyle: true,
      });
      this.bucket = cfg.s3Bucket;
    }
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  /** Best-effort bucket creation (idempotent-ish); ignore already-exists. */
  async ensureBucket(): Promise<void> {
    if (!this.client || !this.bucket) return;
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch {
      // Already exists / owned — fine.
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    if (!this.client || !this.bucket) {
      throw new Error('Object storage is not configured');
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer> {
    if (!this.client || !this.bucket) {
      throw new Error('Object storage is not configured');
    }
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
}
