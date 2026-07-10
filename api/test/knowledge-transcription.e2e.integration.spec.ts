import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import { TRANSCRIPTION_PROVIDER } from '../src/knowledge/transcription/transcription-provider';
import type { TranscriptionProvider } from '../src/knowledge/transcription/transcription-provider';

interface IdBody {
  id: string;
}
interface DocListItem {
  id: string;
  title: string;
  chunkCount: number;
}

/**
 * Stub Whisper provider: reports enabled and returns a fixed transcript,
 * capturing the args it was called with so the test can assert the upload
 * flow forwarded the media correctly. No network / no real Whisper needed.
 */
class StubTranscriptionProvider implements TranscriptionProvider {
  readonly enabled = true;
  public calls: { filename: string; mimetype: string; bytes: number }[] = [];
  transcribe(
    file: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<string> {
    this.calls.push({ filename, mimetype, bytes: file.length });
    return Promise.resolve(
      'Welkom bij de vergadering. De winkel is maandag tot vrijdag geopend.',
    );
  }
}

describe('audio/video transcription upload e2e (#25)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  const stub = new StubTranscriptionProvider();

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/knowledge`;
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool, {}, [
      { token: TRANSCRIPTION_PROVIDER, value: stub },
    ]));
    token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('transcribes an uploaded audio file and indexes the transcript', async () => {
    const res = await request(app.getHttpServer())
      .post(`${base()}/sources/upload`)
      .set(auth())
      .attach('file', Buffer.from('fake-audio-bytes'), {
        filename: 'vergadering.mp3',
        contentType: 'audio/mpeg',
      })
      .expect(201);
    expect((res.body as { status: string }).status).toBe('processed');

    // The stub provider received the raw media.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      filename: 'vergadering.mp3',
      mimetype: 'audio/mpeg',
    });

    // The transcript went through the normal chunk/embed pipeline.
    const docs = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${(res.body as IdBody).id}`)
      .set(auth())
      .expect(200);
    const list = docs.body as DocListItem[];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('vergadering.mp3');
    expect(list[0].chunkCount).toBeGreaterThan(0);

    const doc = await request(app.getHttpServer())
      .get(`${base()}/documents/${list[0].id}`)
      .set(auth())
      .expect(200);
    const body = doc.body as { chunks: { text: string }[] };
    const allText = body.chunks.map((c) => c.text).join(' ');
    expect(allText).toContain('maandag tot vrijdag');
  });
});

describe('audio/video upload rejected when Whisper disabled (#25)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/knowledge`;
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    // No provider override: the default DisabledTranscriptionProvider is used.
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|u2', email: 'u2@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Beta', slug: 'beta' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('rejects an audio upload with 400 when transcription is not enabled', async () => {
    const res = await request(app.getHttpServer())
      .post(`${base()}/sources/upload`)
      .set(auth())
      .attach('file', Buffer.from('fake-audio-bytes'), {
        filename: 'call.wav',
        contentType: 'audio/wav',
      })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/not enabled/i);
  });
});
