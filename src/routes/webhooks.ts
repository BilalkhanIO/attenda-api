import { Router, Request, Response } from 'express';
import { createHmac } from 'crypto';
import { handleWebhookReply } from '../services/whatsapp';

const router = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'attenda_webhook_verify';
const APP_SECRET   = process.env.WHATSAPP_APP_SECRET   || '';

// ─── Verify Meta HMAC signature ───────────────────────
function verifySignature(rawBody: Buffer, signature: string): boolean {
  if (!APP_SECRET) return true; // Skip in dev if not configured
  const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  if (signature.length !== expected.length) return false;
  // Constant-time comparison to prevent timing attacks
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── GET /webhooks/whatsapp — verification ─────────────
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook] WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Forbidden' });
});

// ─── POST /webhooks/whatsapp — receive messages ─────────
router.post('/whatsapp', async (req: Request, res: Response) => {
  // Always respond 200 quickly to avoid Meta retrying
  res.status(200).json({ status: 'received' });

  try {
    // Verify HMAC signature from Meta
    const signature = req.headers['x-hub-signature-256'] as string || '';
    const rawBody   = (req as Request & { rawBody?: Buffer }).rawBody;
    if (rawBody && signature && !verifySignature(rawBody, signature)) {
      console.warn('[Webhook] Invalid WhatsApp signature — ignoring');
      return;
    }

    const body = req.body;
    if (body?.object === 'whatsapp_business_account') {
      await handleWebhookReply(body);
    }
  } catch (err) {
    console.error('[Webhook] WhatsApp processing error:', err);
  }
});

export default router;
