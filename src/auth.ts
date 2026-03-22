import http from 'node:http';
import { exec } from 'node:child_process';
import { getQRCode, pollQRStatus } from './wechat-api.js';

const MAX_QR_REFRESH = 3;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const QR_WEB_PORT = 18891;

export interface LoginResult {
  token: string;
  accountId: string;
  baseUrl?: string;
}

/**
 * Full QR login flow: fetch QR code, display in terminal, poll until confirmed.
 * Writes to stderr so it doesn't interfere with stdio MCP transport.
 */
export async function loginWithQR(baseUrl?: string): Promise<LoginResult> {
  let qrRefreshCount = 0;

  while (qrRefreshCount < MAX_QR_REFRESH) {
    qrRefreshCount++;
    const qrResp = await getQRCode(baseUrl);

    // Display QR code in terminal via stderr
    process.stderr.write('\n--- Scan this QR code with WeChat ---\n');
    try {
      const qrterm = await import('qrcode-terminal');
      // qrcode-terminal writes to stdout by default; we redirect
      qrterm.default.generate(qrResp.qrcode_img_content, { small: true }, (qr: string) => {
        process.stderr.write(qr + '\n');
      });
    } catch {
      process.stderr.write(`QR URL: ${qrResp.qrcode_img_content}\n`);
    }
    process.stderr.write('Waiting for scan...\n');

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let scannedLogged = false;

    while (Date.now() < deadline) {
      const status = await pollQRStatus(qrResp.qrcode, baseUrl);

      switch (status.status) {
        case 'wait':
          break;
        case 'scaned':
          if (!scannedLogged) {
            process.stderr.write('Scanned! Confirm on your phone...\n');
            scannedLogged = true;
          }
          break;
        case 'expired':
          process.stderr.write(`QR expired (${qrRefreshCount}/${MAX_QR_REFRESH}), refreshing...\n`);
          break;
        case 'confirmed':
          if (!status.ilink_bot_id || !status.bot_token) {
            throw new Error('Login confirmed but missing bot_token or ilink_bot_id');
          }
          process.stderr.write('Login successful!\n');
          return {
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl,
          };
      }

      if (status.status === 'expired') break; // break inner loop to refresh QR

      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error('Login failed: QR code expired too many times');
}

// ---------------------------------------------------------------------------
// Web-based QR login (opens browser, avoids stderr QR display issue in MCP)
// ---------------------------------------------------------------------------

function buildQRPage(qrUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WeChat Login - Claude Code</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; color: #e0e0e0; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: system-ui, -apple-system, sans-serif; }
    .container { text-align: center; }
    h2 { font-size: 1.6rem; margin-bottom: 8px; }
    .subtitle { color: #888; margin-bottom: 24px; }
    #qr-container { margin: 0 auto 20px; }
    #qr-img { width: 300px; height: 300px; border-radius: 12px; background: white; padding: 16px; }
    #status { color: #888; font-size: 1.1rem; transition: color 0.3s; }
    .success-box { background: #1e3a1e; border: 1px solid #5cb85c; border-radius: 12px; padding: 32px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>WeChat × Claude Code</h2>
    <p class="subtitle">Scan with WeChat to connect</p>
    <div id="qr-container">
      <img id="qr-img" src="${qrUrl}" onerror="this.alt='QR failed to load: ${qrUrl}'" />
    </div>
    <p id="status">Waiting for scan...</p>
  </div>
  <script>
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const el = document.getElementById('status');
        if (data.status === 'scanned') {
          el.textContent = 'Scanned! Confirm on your phone...';
          el.style.color = '#f0ad4e';
        } else if (data.status === 'success') {
          el.textContent = 'Connected!';
          el.style.color = '#5cb85c';
          document.getElementById('qr-container').style.display = 'none';
          clearInterval(poll);
          setTimeout(() => window.close(), 3000);
        } else if (data.status === 'expired') {
          el.textContent = 'QR expired, refreshing...';
          el.style.color = '#d9534f';
          try {
            const r2 = await fetch('/qr-refresh');
            const d2 = await r2.json();
            if (d2.url) {
              document.getElementById('qr-img').src = d2.url;
              el.textContent = 'QR refreshed, scan again...';
              el.style.color = '#888';
            }
          } catch {}
        } else if (data.status === 'failed') {
          el.textContent = 'Login failed: ' + (data.message || 'unknown error');
          el.style.color = '#d9534f';
          clearInterval(poll);
        }
      } catch {}
    }, 2000);
  </script>
</body>
</html>`;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} ${url}`, () => {});
}

/**
 * Web-based QR login: opens a local browser page with the QR code.
 * Solves the MCP stderr capture issue where terminal QR codes are invisible.
 */
export async function loginWithQRWeb(baseUrl?: string): Promise<LoginResult> {
  let currentStatus: 'waiting' | 'scanned' | 'expired' | 'success' | 'failed' = 'waiting';
  let currentQrUrl = '';
  let failMessage = '';
  let qrRefreshCount = 0;
  let currentQrCode = ''; // the qrcode token for polling

  // Fetch initial QR code
  const qrResp = await getQRCode(baseUrl);
  currentQrUrl = qrResp.qrcode_img_content;
  currentQrCode = qrResp.qrcode;
  qrRefreshCount = 1;

  // Start HTTP server
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildQRPage(currentQrUrl));
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: currentStatus, message: failMessage }));
      return;
    }
    if (req.url === '/qr-refresh') {
      // The refresh is triggered by the polling loop setting status to 'expired',
      // but the actual new QR is fetched there too. Just return current URL.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: currentQrUrl }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(QR_WEB_PORT, () => resolve());
  });

  process.stderr.write(`[wechat-channel] QR login page at http://localhost:${QR_WEB_PORT}\n`);
  openBrowser(`http://localhost:${QR_WEB_PORT}`);

  // Poll for QR scan
  try {
    while (qrRefreshCount <= MAX_QR_REFRESH) {
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;

      while (Date.now() < deadline) {
        const status = await pollQRStatus(currentQrCode, baseUrl);

        switch (status.status) {
          case 'wait':
            currentStatus = 'waiting';
            break;
          case 'scaned':
            currentStatus = 'scanned';
            break;
          case 'expired':
            currentStatus = 'expired';
            break;
          case 'confirmed':
            if (!status.ilink_bot_id || !status.bot_token) {
              throw new Error('Login confirmed but missing bot_token or ilink_bot_id');
            }
            currentStatus = 'success';
            // Give the browser a moment to show success
            await new Promise((r) => setTimeout(r, 500));
            return {
              token: status.bot_token,
              accountId: status.ilink_bot_id,
              baseUrl: status.baseurl,
            };
        }

        if (status.status === 'expired') break;

        await new Promise((r) => setTimeout(r, 1000));
      }

      // Refresh QR
      qrRefreshCount++;
      if (qrRefreshCount <= MAX_QR_REFRESH) {
        process.stderr.write(
          `[wechat-channel] QR expired (${qrRefreshCount - 1}/${MAX_QR_REFRESH}), refreshing...\n`,
        );
        const newQr = await getQRCode(baseUrl);
        currentQrUrl = newQr.qrcode_img_content;
        currentQrCode = newQr.qrcode;
        currentStatus = 'waiting';
      }
    }

    currentStatus = 'failed';
    failMessage = 'QR code expired too many times';
    throw new Error('Login failed: QR code expired too many times');
  } finally {
    // Shut down HTTP server
    httpServer.close();
  }
}
