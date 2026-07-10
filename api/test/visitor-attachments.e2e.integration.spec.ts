import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import { StorageService } from '../src/storage/storage.service';

interface IdBody {
  id: string;
}
interface StartBody {
  id: string;
  visitorSecret: string;
}
interface AttachmentBody {
  id: string;
  conversationId: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Visitor file/image attachment (#14) end-to-end: a widget visitor uploads a
 * file within their conversation (widget-key + visitor-secret gated), it is
 * stored in MinIO, associated with the conversation/message, and exposed to an
 * agent (OIDC + membership gated) who can list and download it. A real MinIO
 * container backs StorageService so the bytes round-trip for real.
 */
describe('visitor attachments e2e (#14)', () => {
  let container: StartedPostgreSqlContainer;
  let minio: StartedTestContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;
  let tenantSchema: string;

  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  async function startConversation(): Promise<{
    conversationId: string;
    visitorSecret: string;
  }> {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const body = started.body as StartBody;
    return { conversationId: body.id, visitorSecret: body.visitorSecret };
  }

  beforeAll(async () => {
    ({ container, pool } = await startPg());

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

    ({ app, idp } = await buildTestApp(pool, {
      s3Endpoint: endpoint,
      s3Region: 'us-east-1',
      s3AccessKey: 'minioadmin',
      s3SecretKey: 'minioadmin',
      s3Bucket: 'bonsai-attachments-test',
    }));
    // Create the bucket the app itself will write to, using the app's own
    // StorageService instance (same config it was built with).
    await app.get(StorageService).ensureBucket();

    token = await idp.sign({ sub: 'oidc|att', email: 'att@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'AttachCo', slug: 'attachco' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;

    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;

    const tenantRow = await pool.query<{ schema_name: string }>(
      'SELECT schema_name FROM tenants WHERE id = $1',
      [tenantId],
    );
    tenantSchema = tenantRow.rows[0].schema_name;
  }, 300000);

  afterAll(async () => {
    await app.close();
    await minio.stop();
    await container.stop();
  });

  it('stores a visitor image upload in MinIO, ties it to the conversation, and exposes it to an agent for download', async () => {
    const { conversationId, visitorSecret } = await startConversation();
    // Minimal valid PNG header bytes (enough to round-trip as bytes).
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
    ]);

    const up = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/attachments`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .field('caption', 'Here is my screenshot')
      .attach('file', pngBytes, {
        filename: 'screenshot.png',
        contentType: 'image/png',
      })
      .expect(201);
    const attachment = up.body as AttachmentBody;
    expect(attachment.id).toBeDefined();
    expect(attachment.conversationId).toBe(conversationId);
    expect(attachment.messageId).toBeTruthy();
    expect(attachment.filename).toBe('screenshot.png');
    expect(attachment.contentType).toBe('image/png');
    expect(attachment.sizeBytes).toBe(pngBytes.length);

    // A visitor message was created and carries the caption.
    const detail = await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationId}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .expect(200);
    const body = detail.body as {
      messages: { role: string; content: string }[];
      attachments: AttachmentBody[];
    };
    expect(
      body.messages.some(
        (m) => m.role === 'visitor' && m.content === 'Here is my screenshot',
      ),
    ).toBe(true);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].id).toBe(attachment.id);

    // The storage key was recorded and points at the tenant schema namespace.
    const row = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM "${tenantSchema}".message_attachments WHERE id = $1`,
      [attachment.id],
    );
    expect(row.rows[0].storage_key).toContain(
      `${tenantSchema}/visitor-attachments/${conversationId}/`,
    );

    // Agent lists the attachment.
    const list = await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${projectId}/conversations/${conversationId}/attachments`,
      )
      .set(auth())
      .expect(200);
    const listBody = list.body as AttachmentBody[];
    expect(listBody).toHaveLength(1);
    expect(listBody[0].id).toBe(attachment.id);

    // Agent downloads the bytes; they match what the visitor uploaded.
    const dl = await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${projectId}/conversations/${conversationId}/attachments/${attachment.id}/download`,
      )
      .set(auth())
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(dl.headers['content-disposition']).toContain('screenshot.png');
    expect((dl.body as Buffer).equals(pngBytes)).toBe(true);
  });

  it('rejects an upload with a wrong/missing visitor secret and never writes', async () => {
    const { conversationId } = await startConversation();
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/attachments`)
      .set('x-bonsai-key', widgetKey)
      .attach('file', Buffer.from([0x89, 0x50]), {
        filename: 'x.png',
        contentType: 'image/png',
      })
      .expect(401);

    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/attachments`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', 'wrong-secret-padding-0000000000000000')
      .attach('file', Buffer.from([0x89, 0x50]), {
        filename: 'x.png',
        contentType: 'image/png',
      })
      .expect(401);

    const row = await pool.query(
      `SELECT id FROM "${tenantSchema}".message_attachments WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rowCount).toBe(0);
  });

  it('rejects a disallowed file type (400) and stores nothing', async () => {
    const { conversationId, visitorSecret } = await startConversation();
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/attachments`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .attach('file', Buffer.from('<svg></svg>'), {
        filename: 'evil.svg',
        contentType: 'image/svg+xml',
      })
      .expect(400);

    const row = await pool.query(
      `SELECT id FROM "${tenantSchema}".message_attachments WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rowCount).toBe(0);
  });

  it('rejects a request with no file part (400)', async () => {
    const { conversationId, visitorSecret } = await startConversation();
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/attachments`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .expect(400);
  });

  it('cross-conversation isolation: visitor A cannot upload into visitor B conversation', async () => {
    const a = await startConversation();
    const b = await startConversation();
    await request(app.getHttpServer())
      .post(`${widgetBase}/${b.conversationId}/attachments`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', a.visitorSecret)
      .attach('file', Buffer.from([0x89, 0x50]), {
        filename: 'sneaky.png',
        contentType: 'image/png',
      })
      .expect(401);
  });

  it('agent cannot download an attachment via a mismatched conversation id (404)', async () => {
    const { conversationId, visitorSecret } = await startConversation();
    const up = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/attachments`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'ok.png',
        contentType: 'image/png',
      })
      .expect(201);
    const attachmentId = (up.body as AttachmentBody).id;

    const other = await startConversation();
    await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${projectId}/conversations/${other.conversationId}/attachments/${attachmentId}/download`,
      )
      .set(auth())
      .expect(404);
  });
});
