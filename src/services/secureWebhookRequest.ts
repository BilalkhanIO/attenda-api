import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const TIMEOUT_MS = 5_000;

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  // Accept global-unicast IPv6 only. This excludes loopback, link-local,
  // unique-local, IPv4-mapped, multicast and unspecified addresses.
  if (!/^2[0-9a-f]{3}:/i.test(normalized)) return false;
  return !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:10:') &&
    !normalized.startsWith('2001:0:') && !normalized.startsWith('2002:');
}

/** Resolve, reject non-public destinations, then pin the socket to that IP.
 * This avoids a DNS-rebinding gap between validation and the HTTP request. */
export async function secureWebhookRequest(urlValue: string, body: string, signature: string, previousSignature?: string): Promise<number> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Webhook URL must use public HTTPS on port 443');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Webhook payload exceeds size limit');

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error('Webhook host resolves to a non-public IP address');
  }
  const destination = addresses[0];

  return new Promise<number>((resolve, reject) => {
    let responseBytes = 0;
    const request = https.request({
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'X-Attenda-Signature': signature,
        ...(previousSignature ? { 'X-Attenda-Signature-Previous': previousSignature } : {}),
      },
      timeout: TIMEOUT_MS,
      agent: new https.Agent({ keepAlive: false }),
      lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
    }, response => {
      response.on('data', chunk => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAX_RESPONSE_BYTES) request.destroy(new Error('Webhook response exceeds size limit'));
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) reject(new Error('Webhook redirects are not allowed'));
        else resolve(status);
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Webhook request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}
