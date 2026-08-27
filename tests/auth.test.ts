import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock wechat-api & child_process before importing auth
// ---------------------------------------------------------------------------

vi.mock('../src/wechat-api.js', () => ({
  getQRCode: vi.fn(),
  pollQRStatus: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: (_text: string, _opts: unknown, cb: (qr: string) => void) => {
      cb('[QR]');
    },
  },
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, cb?: () => void) => cb?.()),
}));

// Mock http.createServer so loginWithQRWeb doesn't actually bind a port
vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    default: {
      ...actual,
      createServer: vi.fn(() => ({
        listen: (_port: number, cb: () => void) => cb(),
        address: () => ({ port: 0 }),
        on: vi.fn(),
        close: vi.fn(),
      })),
    },
  };
});

import { loginWithQR, loginWithQRWeb, buildQRPage } from '../src/auth.js';
import { getQRCode, pollQRStatus } from '../src/wechat-api.js';

const mockGetQRCode = vi.mocked(getQRCode);
const mockPollQRStatus = vi.mocked(pollQRStatus);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQRResp(qrcode = 'qr-token-123', content = 'https://qr.example.com') {
  return { qrcode, qrcode_img_content: content };
}

function makeStatus(status: string, extra: Record<string, string> = {}) {
  return { status, ...extra } as any;
}

const CONFIRMED_EXTRA = {
  bot_token: 'tok_abc',
  ilink_bot_id: 'bot_123',
  baseurl: 'https://custom.api.com',
};

// ---------------------------------------------------------------------------
// loginWithQR
// ---------------------------------------------------------------------------

describe('loginWithQR', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockGetQRCode.mockReset();
    mockPollQRStatus.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns LoginResult on first-poll confirmed', async () => {
    mockGetQRCode.mockResolvedValueOnce(makeQRResp());
    mockPollQRStatus.mockResolvedValueOnce(makeStatus('confirmed', CONFIRMED_EXTRA));

    const result = await loginWithQR();
    expect(result).toEqual({
      token: 'tok_abc',
      accountId: 'bot_123',
      baseUrl: 'https://custom.api.com',
    });
  });

  it('handles scanned → confirmed flow', async () => {
    mockGetQRCode.mockResolvedValueOnce(makeQRResp());
    mockPollQRStatus
      .mockResolvedValueOnce(makeStatus('wait'))
      .mockResolvedValueOnce(makeStatus('scaned'))
      .mockResolvedValueOnce(makeStatus('confirmed', CONFIRMED_EXTRA));

    const result = await loginWithQR();
    expect(result.token).toBe('tok_abc');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Scanned'));
  });

  it('refreshes QR on expired and succeeds on second QR', async () => {
    mockGetQRCode
      .mockResolvedValueOnce(makeQRResp('qr1'))
      .mockResolvedValueOnce(makeQRResp('qr2'));
    mockPollQRStatus
      .mockResolvedValueOnce(makeStatus('expired'))
      .mockResolvedValueOnce(makeStatus('confirmed', CONFIRMED_EXTRA));

    const result = await loginWithQR();
    expect(result.token).toBe('tok_abc');
    expect(mockGetQRCode).toHaveBeenCalledTimes(2);
  });

  it('throws after MAX_QR_REFRESH (3) expirations', async () => {
    mockGetQRCode.mockResolvedValue(makeQRResp());
    mockPollQRStatus.mockResolvedValue(makeStatus('expired'));

    await expect(loginWithQR()).rejects.toThrow('QR code expired too many times');
    expect(mockGetQRCode).toHaveBeenCalledTimes(3);
  });

  it('throws when confirmed but missing bot_token', async () => {
    mockGetQRCode.mockResolvedValueOnce(makeQRResp());
    mockPollQRStatus.mockResolvedValueOnce(
      makeStatus('confirmed', { ilink_bot_id: 'bot_123' }),
    );

    await expect(loginWithQR()).rejects.toThrow('missing bot_token or ilink_bot_id');
  });

  it('throws when confirmed but missing ilink_bot_id', async () => {
    mockGetQRCode.mockResolvedValueOnce(makeQRResp());
    mockPollQRStatus.mockResolvedValueOnce(
      makeStatus('confirmed', { bot_token: 'tok_abc' }),
    );

    await expect(loginWithQR()).rejects.toThrow('missing bot_token or ilink_bot_id');
  });

  it('passes baseUrl to getQRCode and pollQRStatus', async () => {
    mockGetQRCode.mockResolvedValueOnce(makeQRResp());
    mockPollQRStatus.mockResolvedValueOnce(makeStatus('confirmed', CONFIRMED_EXTRA));

    await loginWithQR('https://custom.base');
    expect(mockGetQRCode).toHaveBeenCalledWith('https://custom.base');
    expect(mockPollQRStatus).toHaveBeenCalledWith('qr-token-123', 'https://custom.base');
  });
});

// ---------------------------------------------------------------------------
// loginWithQRWeb
// ---------------------------------------------------------------------------

describe('loginWithQRWeb', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockGetQRCode.mockReset();
    mockPollQRStatus.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns LoginResult on confirmed', async () => {
    mockGetQRCode.mockResolvedValueOnce(makeQRResp());
    mockPollQRStatus.mockResolvedValueOnce(makeStatus('confirmed', CONFIRMED_EXTRA));

    const result = await loginWithQRWeb();
    expect(result).toEqual({
      token: 'tok_abc',
      accountId: 'bot_123',
      baseUrl: 'https://custom.api.com',
    });
  });

  it('refreshes QR on expired', async () => {
    mockGetQRCode
      .mockResolvedValueOnce(makeQRResp('qr1'))
      .mockResolvedValueOnce(makeQRResp('qr2'));
    mockPollQRStatus
      .mockResolvedValueOnce(makeStatus('expired'))
      .mockResolvedValueOnce(makeStatus('confirmed', CONFIRMED_EXTRA));

    const result = await loginWithQRWeb();
    expect(result.token).toBe('tok_abc');
    expect(mockGetQRCode).toHaveBeenCalledTimes(2);
  });

  it('throws after too many expirations', async () => {
    mockGetQRCode.mockResolvedValue(makeQRResp());
    mockPollQRStatus.mockResolvedValue(makeStatus('expired'));

    await expect(loginWithQRWeb()).rejects.toThrow('QR code expired too many times');
  });

  it('throws when confirmed but missing credentials', async () => {
    mockGetQRCode.mockResolvedValueOnce(makeQRResp());
    mockPollQRStatus.mockResolvedValueOnce(makeStatus('confirmed', {}));

    await expect(loginWithQRWeb()).rejects.toThrow('missing bot_token or ilink_bot_id');
  });
});

// ---------------------------------------------------------------------------
// buildQRPage — 确保生成的 HTML 中 QR URL 正确、不被转义破坏
// ---------------------------------------------------------------------------

describe('buildQRPage', () => {
  it('embeds URL with & intact in renderQR() call (no HTML entity corruption)', () => {
    const url = 'https://example.com/qr?a=1&b=2&c=3';
    const html = buildQRPage(url);
    // The JS string inside renderQR("...") must contain raw & not &amp;
    expect(html).toContain('renderQR("https://example.com/qr?a=1&b=2&c=3")');
    expect(html).not.toContain('&amp;');
  });

  it('escapes double quotes in URL for JS string safety', () => {
    const url = 'https://example.com/qr?x="test"';
    const html = buildQRPage(url);
    // Quotes must be escaped in the JS string
    expect(html).toContain('\\"test\\"');
    // But should not break the renderQR call
    expect(html).toMatch(/renderQR\(".*\\\"test\\\".*"\)/);
  });

  it('escapes < to prevent script injection', () => {
    const url = 'https://example.com/<script>';
    const html = buildQRPage(url);
    // < should be escaped as \x3c in the JS string
    expect(html).not.toContain('renderQR("https://example.com/<script>")');
    expect(html).toContain('\\x3c');
  });

  it('uses local qrcode-generator lib, not external API', () => {
    const html = buildQRPage('https://example.com');
    // Should NOT use api.qrserver.com
    expect(html).not.toContain('api.qrserver.com');
    // Should use local JS lib
    expect(html).toContain('qrcode-generator');
    expect(html).toContain('renderQR');
  });

  it('contains status polling and all expected UI states', () => {
    const html = buildQRPage('https://example.com');
    expect(html).toContain("fetch('/status')");
    expect(html).toContain("fetch('/qr-refresh')");
    expect(html).toContain('scanned');
    expect(html).toContain('success');
    expect(html).toContain('expired');
    expect(html).toContain('failed');
  });
});
