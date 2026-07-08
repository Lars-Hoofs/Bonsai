import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { StorageService } from '../src/storage/storage.service';
import type { AppConfig } from '../src/config/config';

describe('StorageService (MinIO / S3)', () => {
  let minio: StartedTestContainer;
  let storage: StorageService;

  beforeAll(async () => {
    minio = await new GenericContainer('minio/minio:latest')
      .withExposedPorts(9000)
      .withEnvironment({
        MINIO_ROOT_USER: 'minioadmin',
        MINIO_ROOT_PASSWORD: 'minioadmin',
      })
      .withCommand(['server', '/data'])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    const cfg = {
      s3Endpoint: endpoint,
      s3Region: 'us-east-1',
      s3AccessKey: 'minioadmin',
      s3SecretKey: 'minioadmin',
      s3Bucket: 'bonsai-test',
    } as AppConfig;
    storage = new StorageService(cfg);
    await storage.ensureBucket();
  }, 180000);

  afterAll(async () => {
    await minio.stop();
  });

  it('is enabled when configured', () => {
    expect(storage.enabled).toBe(true);
  });

  it('stores and retrieves a raw file byte-for-byte', async () => {
    const key = 't_abc/uploads/hello.txt';
    const body = Buffer.from('Hallo opslag — €ü test', 'utf8');
    await storage.put(key, body, 'text/plain');
    const got = await storage.get(key);
    expect(got.equals(body)).toBe(true);
  });

  it('a non-configured storage reports disabled and refuses put', async () => {
    const off = new StorageService({ s3Region: 'us-east-1' } as AppConfig);
    expect(off.enabled).toBe(false);
    await expect(off.put('k', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      /not configured/,
    );
  });
});
