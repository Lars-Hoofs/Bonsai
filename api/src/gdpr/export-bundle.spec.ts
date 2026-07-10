import { assembleExportBundle, type ExportInput } from './export-bundle';

function baseInput(): ExportInput {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    visitorId: 'visitor-abc',
    conversations: [
      {
        id: 'c1',
        project_id: 'project-1',
        visitor_id: 'visitor-abc',
        channel: 'widget',
        status: 'closed',
        language: 'nl',
        resolution: 'resolved',
        started_at: '2026-07-01T10:00:00.000Z',
        ended_at: '2026-07-01T10:05:00.000Z',
        updated_at: '2026-07-01T10:05:00.000Z',
        csat_score: 5,
        csat_comment: 'great',
      },
      {
        id: 'c2',
        project_id: 'project-1',
        visitor_id: 'visitor-abc',
        channel: 'widget',
        status: 'bot',
        language: 'nl',
        resolution: null,
        started_at: '2026-07-02T10:00:00.000Z',
        ended_at: null,
        updated_at: '2026-07-02T10:01:00.000Z',
        csat_score: null,
        csat_comment: null,
      },
    ],
    messages: [
      {
        id: 'm1',
        conversation_id: 'c1',
        role: 'visitor',
        content: 'hallo',
        confidence: null,
        refused: false,
        model_used: null,
        latency_ms: null,
        created_at: '2026-07-01T10:00:01.000Z',
      },
      {
        id: 'm2',
        conversation_id: 'c1',
        role: 'bot',
        content: 'hoi!',
        confidence: 0.9,
        refused: false,
        model_used: 'fake',
        latency_ms: 42,
        created_at: '2026-07-01T10:00:02.000Z',
      },
      {
        id: 'm3',
        conversation_id: 'c2',
        role: 'visitor',
        content: 'vraag',
        confidence: null,
        refused: false,
        model_used: null,
        latency_ms: null,
        created_at: '2026-07-02T10:00:01.000Z',
      },
    ],
    citations: [
      {
        message_id: 'm2',
        ordinal: 1,
        document_title: 'FAQ',
        origin_url: 'https://example.eu/faq',
      },
    ],
    feedback: [
      {
        message_id: 'm2',
        rating: 'up',
        created_at: '2026-07-01T10:01:00.000Z',
      },
    ],
    handovers: [
      {
        id: 'h1',
        conversation_id: 'c1',
        reason: 'visitor asked for human',
        started_at: '2026-07-01T10:03:00.000Z',
        returned_at: null,
      },
    ],
    exportedAt: new Date('2026-07-10T00:00:00.000Z'),
  };
}

describe('assembleExportBundle', () => {
  it('stamps subject and export metadata', () => {
    const bundle = assembleExportBundle(baseInput());
    expect(bundle.subject).toEqual({
      kind: 'visitor',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      visitorId: 'visitor-abc',
    });
    expect(bundle.exportedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(bundle.counts).toEqual({
      conversations: 2,
      messages: 3,
      handovers: 1,
      feedback: 1,
    });
  });

  it('nests messages under their conversation, in input order', () => {
    const bundle = assembleExportBundle(baseInput());
    expect(bundle.conversations).toHaveLength(2);
    const [c1, c2] = bundle.conversations;
    expect(c1.id).toBe('c1');
    expect(
      (c1.messages as unknown[]).map((m) => (m as { id: string }).id),
    ).toEqual(['m1', 'm2']);
    expect(c2.messages as unknown[]).toHaveLength(1);
  });

  it('nests citations and feedback under the owning message', () => {
    const bundle = assembleExportBundle(baseInput());
    const c1 = bundle.conversations[0];
    const m2 = (c1.messages as Array<Record<string, unknown>>)[1];
    expect(m2.id).toBe('m2');
    expect(m2.citations).toEqual([
      { ordinal: 1, documentTitle: 'FAQ', originUrl: 'https://example.eu/faq' },
    ]);
    expect(m2.feedback).toEqual([
      { rating: 'up', createdAt: '2026-07-01T10:01:00.000Z' },
    ]);
    const m1 = (c1.messages as Array<Record<string, unknown>>)[0];
    expect(m1.citations).toEqual([]);
    expect(m1.feedback).toEqual([]);
  });

  it('nests handovers under their conversation', () => {
    const bundle = assembleExportBundle(baseInput());
    const c1 = bundle.conversations[0];
    expect(c1.handovers as unknown[]).toHaveLength(1);
    expect(bundle.conversations[1].handovers as unknown[]).toHaveLength(0);
  });

  it('produces an empty bundle for a subject with no conversations', () => {
    const input = baseInput();
    input.conversations = [];
    input.messages = [];
    input.citations = [];
    input.feedback = [];
    input.handovers = [];
    const bundle = assembleExportBundle(input);
    expect(bundle.conversations).toEqual([]);
    expect(bundle.counts).toEqual({
      conversations: 0,
      messages: 0,
      handovers: 0,
      feedback: 0,
    });
  });
});
