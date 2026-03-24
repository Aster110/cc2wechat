import http from 'node:http';
import { exec } from 'node:child_process';
import { getQRCode, pollQRStatus } from './wechat-api.js';

const MAX_QR_REFRESH = 3;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

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

export function buildQRPage(qrUrl: string): string {
  // Escape for embedding in JS string literal (not HTML entities!)
  const escapedUrl = qrUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\x3c');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>cc2wechat</title>
  <script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: linear-gradient(135deg, #f0ebe3 0%, #e8e0d4 50%, #f5f0ea 100%);
      color: #2c2c2c;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'SF Pro Display', sans-serif;
    }
    .card {
      background: rgba(255,255,255,0.72);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid rgba(255,255,255,0.5);
      border-radius: 24px;
      padding: 48px 44px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.04);
    }
    h2 { font-size: 24px; font-weight: 600; margin-bottom: 6px; letter-spacing: -0.5px; color: #1a1a1a; }
    .subtitle { color: #8a8a8a; font-size: 14px; margin-bottom: 32px; font-weight: 400; }
    #qr-container {
      display: inline-block;
      border-radius: 20px;
      background: white;
      border: 1px solid rgba(0,0,0,0.06);
      padding: 14px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.04);
    }
    #qr-container img, #qr-container canvas { display: block; width: 192px; height: 192px; }
    #status { color: #8a8a8a; font-size: 13px; margin-top: 24px; transition: all 0.4s ease; letter-spacing: 0.2px; }
    .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #8a8a8a; margin-right: 6px; vertical-align: middle; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
    .success-card { text-align: center; }
    .check-circle { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #34c759, #30b854); display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 28px; color: white; box-shadow: 0 4px 16px rgba(52,199,89,0.3); }
    .cmd-list { text-align: left; background: rgba(0,0,0,0.03); border-radius: 14px; padding: 18px 22px; margin-top: 24px; font-size: 13px; line-height: 2.2; color: #555; }
    .cmd { font-family: 'SF Mono', 'Menlo', monospace; color: #1a73e8; font-weight: 600; font-size: 12px; background: rgba(26,115,232,0.08); padding: 2px 8px; border-radius: 6px; }
    .note { color: #aaa; font-size: 11px; margin-top: 20px; font-weight: 400; }
  </style>
</head>
<body>
  <div class="card" id="main-card">
    <h2>cc2wechat</h2>
    <p class="subtitle">use WeChat to scan the code binding</p>
    <div id="qr-container"></div>
    <p id="status"><span class="dot"></span>waiting for scanning...</p>
  </div>
  <script>
    function renderQR(text) {
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      document.getElementById('qr-container').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
    }
    renderQR("${escapedUrl}");

    const poll = setInterval(async () => {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const el = document.getElementById('status');
        if (data.status === 'scanned') {
          el.innerHTML = '<span class="dot" style="background:#f0ad4e"></span>scanned, please confirm on your phone...';
          el.style.color = '#c49000';
        } else if (data.status === 'success') {
          clearInterval(poll);
          document.getElementById('main-card').innerHTML =
            '<div class="success-card">' +
              '<div class="check-circle">\\u2713</div>' +
              '<h2 style="margin-bottom:8px">binding complete</h2>' +
              '<p class="subtitle">Directly send a message to start the dialogue</p>' +
              '<div class="cmd-list">' +
                '<div><span class="cmd">/new</span> \\u2014 Open a new dialogue</div>' +
                '<div><span class="cmd">/exit</span> \\u2014 End dialogue</div>' +
                '<div><span class="cmd">/help</span> \\u2014 View help</div>' +
              '</div>' +
              '<p class="note">The first session needs about 20 seconds to establish the connection</p>' +
            '</div>';
          setTimeout(() => window.close(), 5000);
        } else if (data.status === 'expired') {
          el.innerHTML = '<span class="dot" style="background:#d9534f"></span>The QR code has expired, refreshing...';
          el.style.color = '#d9534f';
          try {
            const r2 = await fetch('/qr-refresh');
            const d2 = await r2.json();
            if (d2.url) {
              renderQR(d2.url);
              el.innerHTML = '<span class="dot"></span>Please scan again...';
              el.style.color = '#8a8a8a';
            }
          } catch {}
        } else if (data.status === 'failed') {
          el.textContent = 'binding failed: ' + (data.message || '');
          el.style.color = '#d9534f';
          clearInterval(poll);
        }
      } catch {}
    }, 2000);
  <\/script>
</body>
</html>`;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
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
    httpServer.listen(0, () => resolve());
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : 0;
  process.stderr.write(`[wechat-channel] QR login page at http://localhost:${actualPort}\n`);
  openBrowser(`http://localhost:${actualPort}`);

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
            // Wait long enough for browser to poll /status (polls every 2s)
            // and then display the success card (5s auto-close timer)
            await new Promise((r) => setTimeout(r, 3000));
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
