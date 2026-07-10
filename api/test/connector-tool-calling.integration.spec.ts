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
import {
  ConnectorToolService,
  type ToolSource,
} from '../src/connectors/connector-tool.service';
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

/** Test double for ConnectorToolService: overrides the network-calling
 * `callConnector` (protected, made callable here via subclassing) so tests
 * never make a real HTTP call — they inject canned "live" data instead. */
class StubConnectorToolService extends ConnectorToolService {
  public callConnectorResult: string | Error = 'stub not configured';

  protected override callConnector(): Promise<string> {
    if (this.callConnectorResult instanceof Error) {
      return Promise.reject(this.callConnectorResult);
    }
    return Promise.resolve(this.callConnectorResult);
  }
}

describe('Live tool-calling in the answer pipeline', () => {
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
    const tenant = await prov.createTenant({ name: 'ToolCo', slug: 'toolco' });
    tenantId = tenant.id;
    schemaName = tenant.schemaName;
    tenantDb = new TenantDbService(pool);
    const embedder = new FakeEmbeddingProvider(1024);
    ingestion = new IngestionService(tenantDb, new ChunkingService(), embedder);
    retrieval = new RetrievalService(tenantDb, embedder);

    const audit = new AuditService(drizzle(pool, { schema }));
    const encryption = new EncryptionService({
      encryptionKey: keyOf32Bytes(9),
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

  it('calls the routed connector, cites the live data, and does not refuse', async () => {
    const connectorId = await createOrderConnector();
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'Order 123 status: verzonden';

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          return Promise.resolve(
            JSON.stringify({ connectorId, params: { order: '123' } }),
          );
        }
        if (isSelfCheckCall(messages)) {
          return Promise.resolve('{"supported": true}');
        }
        return Promise.resolve(
          'Je bestelling 123 is verzonden, zie de live status [1].',
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
      'wat is de status van mijn bestelling 123',
    );

    expect(res.refused).toBe(false);
    expect(res.answer).toContain('verzonden');
    expect(res.citations.some((c) => c.sourceId === connectorId)).toBe(true);
    const toolCitation = res.citations.find((c) => c.sourceId === connectorId);
    expect(toolCitation?.documentTitle).toBe('Order status API');
    expect(toolCitation?.documentId).toBe(`connector:${connectorId}`);
    expect(toolCitation?.originUrl).toBeNull();
  });

  it('a tool source alone (no KB match) is enough to proceed past the gate', async () => {
    const connectorId = await createOrderConnector();
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'Order 999 status: onderweg';

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          return Promise.resolve(
            JSON.stringify({ connectorId, params: { order: '999' } }),
          );
        }
        if (isSelfCheckCall(messages)) {
          return Promise.resolve('{"supported": true}');
        }
        return Promise.resolve('Bestelling 999 is onderweg [1].');
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
    // A question with no relation whatsoever to the KB doc, so retrieval
    // alone would be below threshold / return nothing useful — only the
    // live tool source should carry this answer past the gate.
    const res = await svc.answer(
      schemaName,
      projectId,
      'wat is de status van bestelling 999 astrofysica kwantum',
    );

    expect(res.refused).toBe(false);
    expect(res.answer).toContain('onderweg');
    expect(res.citations.some((c) => c.sourceId === connectorId)).toBe(true);
  });

  it('router returning null -> normal KB-only path, no tool citation', async () => {
    await createOrderConnector();
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'should never be used';

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          return Promise.resolve('{"connectorId": null, "params": {}}');
        }
        if (isSelfCheckCall(messages)) {
          return Promise.resolve('{"supported": true}');
        }
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

    expect(res.refused).toBe(false);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].documentTitle).toBe('Retourbeleid');
  });

  it('callConnector throwing falls back to KB-only without crashing (KB covers it -> not refused)', async () => {
    await createOrderConnector();
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = new Error('ECONNREFUSED');

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          return Promise.resolve(
            JSON.stringify({ connectorId: 'whatever', params: {} }),
          );
        }
        if (isSelfCheckCall(messages)) {
          return Promise.resolve('{"supported": true}');
        }
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

    // Falls back to KB-only: still answers correctly from the KB, never
    // invents/uses the (failed) live data, and never crashes.
    expect(res.refused).toBe(false);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].documentTitle).toBe('Retourbeleid');
  });

  it('callConnector throwing + no KB coverage -> refuses honestly (never invents data)', async () => {
    await createOrderConnector();
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = new Error('ECONNREFUSED');

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          return Promise.resolve(
            JSON.stringify({ connectorId: 'whatever', params: {} }),
          );
        }
        if (isSelfCheckCall(messages)) {
          return Promise.resolve('{"supported": true}');
        }
        return Promise.resolve('Hier is een verzonnen antwoord [1].');
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
      'hoe werkt kwantumverstrengeling in de ruimtevaart',
    );

    expect(res.refused).toBe(true);
    expect(res.citations).toHaveLength(0);
  });

  it('no ConnectorToolService injected -> unchanged pre-existing behavior, no tool calls', async () => {
    const llm: LlmProvider = {
      complete: (messages) => {
        expect(isToolRouterCall(messages)).toBe(false);
        if (isSelfCheckCall(messages)) {
          return Promise.resolve('{"supported": true}');
        }
        return Promise.resolve(
          'Je kunt artikelen binnen dertig dagen retourneren [1].',
        );
      },
    };
    const svc = new AnswerService(tenantDb, retrieval, llm, cfg());
    const res = await svc.answer(
      schemaName,
      projectId,
      'hoeveel dagen kan ik artikelen retourneren',
    );
    expect(res.refused).toBe(false);
    expect(res.citations).toHaveLength(1);
  });

  it('toolCallingEnabled=false -> never attempts a tool call even with the service injected', async () => {
    await createOrderConnector();
    const tool = new StubConnectorToolService(connectorsService);
    tool.callConnectorResult = 'should never be used';
    let routerCalls = 0;

    const llm: LlmProvider = {
      complete: (messages) => {
        if (isToolRouterCall(messages)) {
          routerCalls++;
        }
        if (isSelfCheckCall(messages)) {
          return Promise.resolve('{"supported": true}');
        }
        return Promise.resolve(
          'Je kunt artikelen binnen dertig dagen retourneren [1].',
        );
      },
    };

    const svc = new AnswerService(
      tenantDb,
      retrieval,
      llm,
      cfg({ toolCallingEnabled: false }),
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
  });

  describe('ConnectorToolService (unit-level via real callConnector)', () => {
    it('maybeCall returns null when the project has no connectors', async () => {
      const noConnectorsProjectId = await tenantDb.withTenant(
        schemaName,
        async (db) => {
          const p = await db.execute(
            sql`INSERT INTO projects (name, settings)
              VALUES ('EmptyBot', '{"confidenceThreshold":0.1}'::jsonb) RETURNING id`,
          );
          return (p.rows[0] as { id: string }).id;
        },
      );
      const tool = new ConnectorToolService(connectorsService);
      const llm: LlmProvider = { complete: () => Promise.resolve('') };
      const result = await tool.maybeCall(
        schemaName,
        noConnectorsProjectId,
        'anything',
        llm,
      );
      expect(result).toBeNull();
    });

    it('maybeCall returns null when the router response is unparseable JSON', async () => {
      const connectorId = await createOrderConnector();
      const tool = new ConnectorToolService(connectorsService);
      const llm: LlmProvider = {
        complete: () => Promise.resolve('not json at all'),
      };
      const result: ToolSource | null = await tool.maybeCall(
        schemaName,
        projectId,
        'status van bestelling',
        llm,
      );
      expect(result).toBeNull();
      // sanity: connector exists but was never reachable via the malformed
      // router response.
      expect(connectorId).toBeTruthy();
    });
  });
});
