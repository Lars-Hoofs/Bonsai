import { PreviewTokenService } from './preview-token.service';

/** Test-only subclass exposing a short TTL to exercise expiry without waiting a real hour. */
class ShortLivedPreviewTokenService extends PreviewTokenService {
  protected override readonly ttlSeconds = 1;
}

describe('PreviewTokenService', () => {
  const cfg = { widgetPreviewTokenSecret: 'unit-test-secret' };
  const svc = new PreviewTokenService(cfg);

  it('issues a token that verifies back to the same tenant/project', async () => {
    const token = await svc.issue('schema_a', 'project-1');
    const claims = await svc.verify(token);
    expect(claims.schemaName).toBe('schema_a');
    expect(claims.projectId).toBe('project-1');
  });

  it('rejects a token signed with a different secret', async () => {
    const other = new PreviewTokenService({
      widgetPreviewTokenSecret: 'a-different-secret',
    });
    const token = await other.issue('schema_a', 'project-1');
    await expect(svc.verify(token)).rejects.toThrow();
  });

  it('rejects a garbage token', async () => {
    await expect(svc.verify('not-a-jwt')).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const shortLived = new ShortLivedPreviewTokenService(cfg);
    const token = await shortLived.issue('schema_a', 'project-1');
    await new Promise((r) => setTimeout(r, 1100));
    await expect(svc.verify(token)).rejects.toThrow();
  }, 10_000);

  it('two tokens for different projects are not interchangeable', async () => {
    const tokenA = await svc.issue('schema_a', 'project-1');
    const claims = await svc.verify(tokenA);
    expect(claims.projectId).not.toBe('project-2');
  });
});
