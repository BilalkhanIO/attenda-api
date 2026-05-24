// @ts-nocheck
import { Router } from 'express';
import { handleWebhookReply } from '../services/whatsapp';

const router = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'attenda_webhook_verify';

// ─── GET /webhooks/whatsapp — verification ─────────────
router.get('/whatsapp', (req, res) => {
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
router.post('/whatsapp', async (req, res) => {
  // Always respond 200 quickly to avoid Meta retrying
  res.status(200).json({ status: 'received' });

  try {
    // Verify signature (X-Hub-Signature-256) in production
    const body = req.body;
    if (body?.object === 'whatsapp_business_account') {
      await handleWebhookReply(body);
    }
  } catch (err) {
    console.error('[Webhook] WhatsApp processing error:', err);
  }
});

export default router;
