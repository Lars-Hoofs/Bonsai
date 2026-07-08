import { isBlockedIp, assertPublicHttpUrl } from './safe-fetch';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'node:dns/promises';

const mockedLookup = lookup as jest.MockedFunction<typeof lookup>;

describe('isBlockedIp', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['169.254.169.254', 'IPv4 link-local / cloud metadata'],
    ['10.0.0.1', 'IPv4 private 10/8'],
    ['172.16.5.4', 'IPv4 private 172.16/12'],
    ['192.168.1.1', 'IPv4 private 192.168/16'],
    ['0.0.0.0', 'IPv4 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'IPv6 unique local (ULA)'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 loopback'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['1.1.1.1', 'public IPv4'],
    ['172.32.0.1', 'IPv4 just outside the 172.16/12 private range'],
    ['::ffff:8.8.8.8', 'IPv4-mapped IPv6 of a public address'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('blocks multicast and additional edge cases', () => {
    expect(isBlockedIp('224.0.0.1')).toBe(true);
    expect(isBlockedIp('::')).toBe(true);
    expect(isBlockedIp('ff02::1')).toBe(true);
    expect(isBlockedIp('fdff:ffff::1')).toBe(true);
    expect(isBlockedIp('febf:ffff::1')).toBe(true);
  });

  it('treats non-IP input as blocked/unsafe', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });
});

describe('assertPublicHttpUrl', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(
      'Blocked URL',
    );
    await expect(assertPublicHttpUrl('ftp://example.com/')).rejects.toThrow(
      'Blocked URL',
    );
  });

  it('rejects malformed URLs', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(
      'Blocked URL',
    );
  });

  it('rejects an IP-literal loopback URL without doing DNS lookup', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/')).rejects.toThrow(
      'Blocked URL',
    );
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects the cloud metadata IP literal', async () => {
    await expect(
      assertPublicHttpUrl('http://169.254.169.254/'),
    ).rejects.toThrow('Blocked URL');
  });

  it('rejects a private IP literal', async () => {
    await expect(assertPublicHttpUrl('http://10.0.0.1/')).rejects.toThrow(
      'Blocked URL',
    );
  });

  it('accepts a hostname that resolves only to public addresses', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const url = await assertPublicHttpUrl('https://example.com/path');
    expect(url.hostname).toBe('example.com');
    expect(mockedLookup).toHaveBeenCalledWith('example.com', { all: true });
  });

  it('rejects a hostname that resolves to a blocked address (DNS rebinding attempt)', async () => {
    mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      assertPublicHttpUrl('https://evil.example.com/'),
    ).rejects.toThrow('Blocked URL');
  });

  it('rejects a hostname when any resolved address is blocked', async () => {
    mockedLookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(
      assertPublicHttpUrl('https://mixed.example.com/'),
    ).rejects.toThrow('Blocked URL');
  });

  it('rejects when DNS resolution fails', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertPublicHttpUrl('https://nonexistent.invalid/'),
    ).rejects.toThrow('Blocked URL');
  });
});
