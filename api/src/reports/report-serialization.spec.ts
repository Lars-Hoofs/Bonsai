import {
  csvField,
  reportFilename,
  serializeReport,
  toCsv,
  toJson,
  toMetricRows,
  type ReportData,
} from './report-serialization';

const sample = (): ReportData => ({
  projectId: 'abcdef12-0000-0000-0000-000000000000',
  tenantId: 'tenant-1',
  generatedAt: '2026-07-10T12:34:56.000Z',
  analytics: {
    conversations: 10,
    escalations: 2,
    activeHandovers: 1,
    botMessages: 40,
    refused: 4,
    refusalRate: 0.1,
    resolutionRate: 0.8,
    avgConfidence: 0.75,
  },
  csat: {
    ratedConversations: 5,
    avgScore: 4.2,
    percentPositive: 0.8,
    messageFeedbackUp: 12,
    messageFeedbackDown: 3,
  },
  usage: {
    months: [
      {
        period: '2026-06',
        answers: 100,
        estimatedTokens: 150000,
        estimatedCost: 0,
      },
      {
        period: '2026-07',
        answers: 40,
        estimatedTokens: 60000,
        estimatedCost: 0,
      },
    ],
    totalAnswers: 140,
    totalEstimatedTokens: 210000,
    totalEstimatedCost: 0,
    costPer1kTokens: 0,
    estTokensPerAnswer: 1500,
  },
});

describe('csvField', () => {
  it('leaves plain values unquoted', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
  });

  it('serializes null to an empty field', () => {
    expect(csvField(null)).toBe('');
  });

  it('quotes and escapes commas, quotes and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('toMetricRows', () => {
  it('flattens every section including per-month usage', () => {
    const rows = toMetricRows(sample());
    const find = (section: string, metric: string): unknown =>
      rows.find((r) => r.section === section && r.metric === metric)?.value;

    expect(find('meta', 'projectId')).toBe(
      'abcdef12-0000-0000-0000-000000000000',
    );
    expect(find('analytics', 'conversations')).toBe(10);
    expect(find('analytics', 'refusalRate')).toBe(0.1);
    expect(find('csat', 'avgScore')).toBe(4.2);
    expect(find('usage', 'totalAnswers')).toBe(140);
    expect(find('usage.month', '2026-06.answers')).toBe(100);
    expect(find('usage.month', '2026-07.estimatedTokens')).toBe(60000);
  });

  it('preserves a null analytics value as null (not the string "null")', () => {
    const data = sample();
    data.analytics.avgConfidence = null;
    const row = toMetricRows(data).find(
      (r) => r.section === 'analytics' && r.metric === 'avgConfidence',
    );
    expect(row?.value).toBeNull();
  });
});

describe('toCsv', () => {
  it('emits a header row and CRLF-separated data rows', () => {
    const csv = toCsv(sample());
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('section,metric,value');
    expect(lines).toContain('analytics,conversations,10');
    expect(lines).toContain('usage.month,2026-06.answers,100');
  });

  it('renders a null value as an empty trailing field', () => {
    const data = sample();
    data.analytics.avgConfidence = null;
    const csv = toCsv(data);
    expect(csv.split('\r\n')).toContain('analytics,avgConfidence,');
  });
});

describe('toJson', () => {
  it('round-trips to the original object', () => {
    const data = sample();
    expect(JSON.parse(toJson(data))).toEqual(data);
  });
});

describe('serializeReport', () => {
  it('dispatches by format', () => {
    const data = sample();
    expect(serializeReport(data, 'csv')).toBe(toCsv(data));
    expect(serializeReport(data, 'json')).toBe(toJson(data));
  });
});

describe('reportFilename', () => {
  it('builds a safe dated filename from the project id', () => {
    expect(
      reportFilename(
        'abcdef12-0000-0000-0000-000000000000',
        'csv',
        '2026-07-10T12:34:56.000Z',
      ),
    ).toBe('report_abcdef12_2026-07-10.csv');
    expect(
      reportFilename('abcdef12-x', 'json', '2026-01-02T00:00:00.000Z'),
    ).toBe('report_abcdef12_2026-01-02.json');
  });
});
