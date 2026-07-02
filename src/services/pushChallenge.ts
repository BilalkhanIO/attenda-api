// FCM presence-challenge service (roadmap #24, server half).
//
// Before the heartbeat-expiry job auto-checks a user out, it can send a
// high-priority FCM DATA message { type: 'presence_challenge' } to the user's
// registered device. FCM high-priority messages punch through Android Doze,
// so a device that is still on the office network wakes up and answers via
// its normal POST /attendance/heartbeat — cancelling the checkout.
//
// firebase-admin is initialized lazily from the FIREBASE_SERVICE_ACCOUNT env
// var (the service-account JSON as a string). When the var is absent or
// malformed, isPushConfigured() returns false, every function no-ops, and a
// single log line is emitted — the rest of the API behaves exactly as before.
import type { App } from 'firebase-admin/app';
import prisma from '../utils/prisma';

let app: App | null = null;
let initAttempted = false;

function getApp(): App | null {
  if (initAttempted) return app;
  initAttempted = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log('[push] FIREBASE_SERVICE_ACCOUNT not set — FCM presence challenges disabled');
    return null;
  }

  try {
    // Required lazily so environments without Firebase creds never touch the SDK.
    const { initializeApp, cert } = require('firebase-admin/app');
    const serviceAccount = JSON.parse(raw);
    app = initializeApp({ credential: cert(serviceAccount) }, 'attenda-push');
    console.log('[push] firebase-admin initialized — FCM presence challenges enabled');
  } catch (err) {
    app = null;
    console.error('[push] Failed to initialize firebase-admin from FIREBASE_SERVICE_ACCOUNT:', (err as Error).message);
  }
  return app;
}

/** True when firebase-admin initialized successfully from FIREBASE_SERVICE_ACCOUNT. */
export function isPushConfigured(): boolean {
  return getApp() !== null;
}

/**
 * Send a high-priority FCM data message { type: 'presence_challenge' } to the
 * user's registered device token. Returns true if a message was handed to FCM,
 * false when push is unconfigured, the user has no token, or the send failed.
 */
export async function sendPresenceChallenge(userId: string): Promise<boolean> {
  const firebase = getApp();
  if (!firebase) return false;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fcm_token: true },
  });
  if (!user?.fcm_token) return false;

  try {
    const { getMessaging } = require('firebase-admin/messaging');
    await getMessaging(firebase).send({
      token: user.fcm_token,
      android: { priority: 'high' as const },
      data: { type: 'presence_challenge' },
    });
    return true;
  } catch (err) {
    console.error(`[push] presence challenge send failed for user ${userId}:`, (err as Error).message);
    return false;
  }
}

/** Test-only: reset the lazy-init state so env changes take effect. */
export function _resetForTests(): void {
  app = null;
  initAttempted = false;
}
