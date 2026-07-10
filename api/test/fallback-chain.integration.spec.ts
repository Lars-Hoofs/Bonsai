import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { ChunkingService } from '../src/knowledge/chunking/chunking.service';
import { FakeEmbeddingProvider } from '../src/knowledge/embedding/fake-embedding.provider';
import { IngestionService } from '../src/knowledge/ingestion/ingestion.service';
import { RetrievalService } from '../src/rag/retrieval.service';
import { AnswerService } from '../src/rag/answer.service';
import type { LlmMessage, LlmProvider } from '../src/rag/llm-provider';
import type { AppConfig } from '../src/config/config';
import { AuditService } from '../src/audit/audit.service';
import { EncryptionService } from '../src/common/encryption.service';
import { ConnectorsService } from '../src/connectors/connectors.service';
import { ConnectorToolService } from '../src/connectors/connector-tool.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

const isSelfCheckCall = (messages: LlmMessage[]): boolean =>
  messages.some(
    (m) => m.role === 'system' && m.content.includes('BONSAI_SELF_CHECK_V1'),
  );

const isToolRouterCall = (messages: LlmMessage[]): boolean =>
  messages.some(
    (m) => m.role === 'system' && m.content.includes('BONSAI_TOOL_ROUTER_V1'),
  );

function keyOf32Bytes(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

const cfg = (extra: Partial<AppConfig> = {}): AppConfig =>
  ({
    selfCheckEnabled: true,
    verificationMode: 'self-check',
    followupSuggestionsEnabled: false,
    multiQueryEnabled: false,
    toolCallingEnabled: true,
    llmApiUrl: 'https://llm.example.invalid',
    ...extra,
  }) as AppConfig;

/** Same test double as the tool-calling suite: overrides the network call so
 * tests inject canned "live" connector data. */
class StubConnectorToolService extends ConnectorToolService {
  public callConnectorResult: string | Error = 'stub not configured';

  protected override callConnector(): Promise<string> {
    if (this.callConnectorResult instanceof Error) {
      return Promise.reject(this.callConnectorResult);
    }
    return Promise.resolve(this.callConnectorResult);
  }
}

describe('Configurable fallback chain (#29) in the answer pipeline', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let retrieval: RetrievalService;
  let ingestion: IngestionService;
  let connectorsService: ConnectorsService;
  let schemaName: string;
  let tenantId: string;
  let projectId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    const tenant = await prov.createTenant({
      name: 'ChainCo',
      slug: 'chainco',
    });
    tenantId = tenant.id;
    schemaName = tenant.schemaName;
    tenantDb = new TenantDbService(pool);
    const embedder = new FakeEmbeddingProvider(1024);
    ingestion = new IngestionService(tenantDb, new ChunkingService(), embedder);
    retrieval = new RetrievalService(tenantDb, embedder);

    const audit = new AuditService(drizzle(pool, { schema }));
    const encryption = new EncryptionService({
      encryptionKey: keyOf32Bytes(7),
    });
    connectorsService = new ConnectorsService(tenantDb, audit, encryption);

    projectId = await tenantDb
      .withTenant(schemaName, async (db) => {
        const p = await db.execute(
          sql`INSERT INTO projects (name, settings)
            VALUES ('Bot', '{"confidenceThreshold":0.1}'::jsonb) RETURNING id`,
        );
        const id = (p.rows[0] as { id: string }).id;
        const s = await db.execute(
          sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${id}, 'manual', 'Retourbeleid',
              ${JSON.stringify({
                title: 'Retourbeleid',
                body: 'Je kunt artikelen binnen dertig dagen retourneren met een geldig bonnetje.',
                language: 'nl',
              })}::jsonb, 'pending') RETURNING id`,
        );
        return { id, sourceId: (s.rows[0] as { id: string }).id };
      })
      .then(async (r) => {
        await ingestion.ingestSource(schemaName, r.sourceId);
        return r.id;
      });
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  /** Sets (or clears) the project's fallbackChain setting, preserving the
   * confidenceThreshold. */
  async function setFallbackChain(chain: unknown): Promise<void> {
    await tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`UPDATE projects
            SET settings = jsonb_set(settings, '{fallbackChain}', ${JSON.stringify(chain)}::jsonb)
            WHERE id = ${projectId}`,
      );
    });
  }

  async function clearFallbackChain(): Promise<void> {
    await tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`UPDATE projects SET settings = settings - 'fallbackChain'
            WHERE id = ${projectId}`,
      );
    });
  }

  async function createOrderConnector(): Promise<string> {
    const connector = await connectorsService.create(
      schemaName,
      projectId,
      {
        name: 'Order status API',
        description: 'Looks up the live shipping status of an order by id',
        baseUrl: 'https://api.example.invalid/orders',
        method: 'GET',
        requestSchema: { order: { type: 'string' } },
        responseTemplate: 'Order ${order} status: ${status}',
        usageHint: 'Use to answer questions about a specific order status',
        auth: { type: 'bearer', token: 'test-token-123' },
      },
      randomUUID(),
      tenantId,
    );
    return connector.id;
  }

  afterEach(async () => {
    await clearFallbackChain();
  });

  it('default (no chain): connector is tried and a human handover is suggested on refusal', async () => {
    const connectorId = await createOrderConnector();
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'Order 123 status: verzonden';
    let routerCalls = 0;

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          routerCalls++;
          return Promise.resolve(
            JSON.stringify({ connectorId, params: { order: '123' } }),
          );
        }
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        return Promise.resolve('Bestelling 123 is verzonden [1].');
      },
    };
    const svc = new AnswerService(
      tenantDb,
      retrieval,
      llm,
      cfg(),
      undefined,
      undefined,
      tool,
    );

    const res = await svc.answer(
      schemaName,
      projectId,
      'wat is de status van bestelling 123 astrofysica kwantum',
    );
    expect(routerCalls).toBe(1);
    expect(res.refused).toBe(false);
    expect(res.citations.some((c) => c.sourceId === connectorId)).toBe(true);
  });

  it('chain without a connector stage never attempts a tool call (KB-only)', async () => {
    await createOrderConnector();
    await setFallbackChain(['kb', 'human']);
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'should never be used';
    let routerCalls = 0;

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) routerCalls++;
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        return Promise.resolve(
          'Je kunt artikelen binnen dertig dagen retourneren [1].',
        );
      },
    };
    const svc = new AnswerService(
      tenantDb,
      retrieval,
      llm,
      cfg(),
      undefined,
      undefined,
      tool,
    );

    const res = await svc.answer(
      schemaName,
      projectId,
      'hoeveel dagen kan ik artikelen retourneren',
    );
    expect(routerCalls).toBe(0);
    expect(res.refused).toBe(false);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].documentTitle).toBe('Retourbeleid');
  });

  it('chain without a human stage refuses WITHOUT suggesting escalation', async () => {
    await setFallbackChain(['kb', 'connector']);
    const llm: LlmProvider = {
      complete: (messages) => {
        // A KB-only project with no connector match and no human fallback.
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        return Promise.resolve('Hier is een verzonnen antwoord [1].');
      },
    };
    const svc = new AnswerService(tenantDb, retrieval, llm, cfg());

    const res = await svc.answer(
      schemaName,
      projectId,
      'hoe werkt kwantumverstrengeling in de ruimtevaart',
    );
    expect(res.refused).toBe(true);
    expect(res.escalationSuggested).toBe(false);
  });

  it('default chain (with human) refuses AND suggests escalation on an off-topic question', async () => {
    const llm: LlmProvider = {
      complete: (messages) => {
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        return Promise.resolve('Hier is een verzonnen antwoord [1].');
      },
    };
    const svc = new AnswerService(tenantDb, retrieval, llm, cfg());

    const res = await svc.answer(
      schemaName,
      projectId,
      'hoe werkt kwantumverstrengeling in de ruimtevaart',
    );
    expect(res.refused).toBe(true);
    expect(res.escalationSuggested).toBe(true);
  });

  it('connector-only chain (no kb): a live source alone answers, KB is not retrieved', async () => {
    const connectorId = await createOrderConnector();
    await setFallbackChain(['connector', 'human']);
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'Order 555 status: onderweg';

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          return Promise.resolve(
            JSON.stringify({ connectorId, params: { order: '555' } }),
          );
        }
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        return Promise.resolve('Bestelling 555 is onderweg [1].');
      },
    };
    const svc = new AnswerService(
      tenantDb,
      retrieval,
      llm,
      cfg(),
      undefined,
      undefined,
      tool,
    );

    // A question that WOULD match the KB doc, but with kb removed from the
    // chain only the live connector source is used.
    const res = await svc.answer(
      schemaName,
      projectId,
      'hoeveel dagen kan ik artikelen retourneren bestelling 555',
    );
    expect(res.refused).toBe(false);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].sourceId).toBe(connectorId);
  });

  it('connector-only chain (no kb) with no connector match refuses (no KB fallback)', async () => {
    await setFallbackChain(['connector', 'human']);
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'unused';

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          return Promise.resolve('{"connectorId": null, "params": {}}');
        }
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        return Promise.resolve(
          'Je kunt artikelen binnen dertig dagen retourneren [1].',
        );
      },
    };
    const svc = new AnswerService(
      tenantDb,
      retrieval,
      llm,
      cfg(),
      undefined,
      undefined,
      tool,
    );

    // Even though this matches the KB doc, kb is not in the chain, so the
    // (null) connector decision leaves nothing to answer from -> refuse.
    const res = await svc.answer(
      schemaName,
      projectId,
      'hoeveel dagen kan ik artikelen retourneren',
    );
    expect(res.refused).toBe(true);
    expect(res.escalationSuggested).toBe(true);
  });

  it('a malformed stored fallbackChain falls back to default behavior', async () => {
    await createOrderConnector();
    await setFallbackChain('not-an-array');
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'Order 123 status: verzonden';
    let routerCalls = 0;

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          routerCalls++;
          return Promise.resolve('{"connectorId": null, "params": {}}');
        }
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        return Promise.resolve(
          'Je kunt artikelen binnen dertig dagen retourneren [1].',
        );
      },
    };
    const svc = new AnswerService(
      tenantDb,
      retrieval,
      llm,
      cfg(),
      undefined,
      undefined,
      tool,
    );

    const res = await svc.answer(
      schemaName,
      projectId,
      'hoeveel dagen kan ik artikelen retourneren',
    );
    // Default chain applied: connector stage IS attempted (routerCalls>0) and
    // KB answers normally.
    expect(routerCalls).toBe(1);
    expect(res.refused).toBe(false);
    expect(res.citations[0].documentTitle).toBe('Retourbeleid');
  });
});
