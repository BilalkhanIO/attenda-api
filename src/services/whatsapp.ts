// @ts-nocheck
import axios from 'axios';
import prisma from '../utils/prisma';

const META_API = 'https://graph.facebook.com/v19.0';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30_000;

// ─── Message Templates ────────────────────────────────
export const Templates = {
  CHECK_IN:       (name: string, time: string)       => `✅ ${name} checked in — ${time}`,
  CHECK_OUT:      (name: string, time: string)       => `🔴 ${name} checked out — ${time}`,
  LATE_ARRIVAL:   (name: string, mins: number)       => `⚠️ ${name} has not checked in — shift started ${mins} min ago`,
  ABSENT:         (name: string)                     => `❌ ${name} is absent — no check-in recorded today`,
  REMOTE:         (name: string)                     => `🏠 ${name} is working remotely today`,
  REMOTE_REQUEST: (name: string, duration: string)   => `📋 Remote work request from ${name} (${duration.replace(/_/g, ' ')}) — please review and approve in Attenda`,
  LEAVE_APPROVED: (name: string, type: string, dates: string) => `📋 Leave approved: ${name} — ${type}, ${dates}`,
  LEAVE_REJECTED: (name: string, type: string, dates: string, reason: string) => `📋 Leave rejected: ${name} — ${type}, ${dates}. Reason: ${reason}`,
  SHIFT_REMINDER: (name: string, time: string)       => `⏰ Reminder: ${name}, your shift starts in 30 minutes — ${time}`,
  PAYSLIP_READY:  (name: string, month: string)      => `💰 ${name}, your payslip for ${month} is now available in Attenda`,
  REMOTE_MORNING: (name: string)                     => `Good morning ${name}! 👋 Quick check-in — what are you working on today?`,
  REMOTE_MIDDAY:  (name: string)                     => `Afternoon check-in ${name}! Any updates or blockers I should know about?`,
  REMOTE_EOD:     (name: string)                     => `Wrapping up ${name}? What did you accomplish today? Any carry-overs for tomorrow?`,
};

export type NotificationEvent =
  | 'check_in' | 'check_out' | 'late_arrival' | 'absent'
  | 'remote' | 'remote_request' | 'leave_approved' | 'leave_rejected'
  | 'shift_reminder' | 'payslip_ready'
  | 'remote_morning' | 'remote_midday' | 'remote_eod';

interface SendOptions {
  orgId:         string;
  event:         NotificationEvent;
  message:       string;
  recipientType: 'group' | 'individual';
  recipientId:   string;   // WhatsApp group ID or phone number
}

// ─── Core send function ───────────────────────────────
async function sendWhatsAppMessage(
  phoneNumberId: string,
  accessToken:   string,
  to:            string,
  body:          string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const res = await axios.post(
      `${META_API}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );
    return { success: true, messageId: res.data?.messages?.[0]?.id };
  } catch (err: any) {
    const error = err?.response?.data?.error?.message || err.message || 'Unknown error';
    return { success: false, error };
  }
}

// ─── Notify with retry + logging ─────────────────────
export async function notify(opts: SendOptions): Promise<void> {
  const { orgId, event, message, recipientType, recipientId } = opts;

  // Get org WhatsApp config
  const org = await prisma.organisation.findUnique({ where: { id: orgId } });
  if (!org?.wa_enabled || !org.wa_phone_number_id || !org.wa_access_token) {
    return; // WhatsApp not configured
  }

  // Check if this event type is enabled
  const events = (org.wa_events as Record<string, boolean>) || {};
  if (events[event] === false) return; // explicitly disabled

  // Create log entry
  const log = await prisma.whatsappLog.create({
    data: { org_id: orgId, event_type: event, recipient_type: recipientType, recipient_id: recipientId, message_body: message, status: 'pending' },
  });

  // Attempt send with retries
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await prisma.whatsappLog.update({ where: { id: log.id }, data: { attempts: attempt } });

    const result = await sendWhatsAppMessage(org.wa_phone_number_id, org.wa_access_token, recipientId, message);

    if (result.success) {
      await prisma.whatsappLog.update({
        where: { id: log.id },
        data: { status: 'sent', sent_at: new Date() },
      });
      return;
    }

    lastError = result.error || 'Failed';
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  // All retries exhausted
  await prisma.whatsappLog.update({ where: { id: log.id }, data: { status: 'failed' } });
  console.error(`[WhatsApp] PERMANENT FAILURE for org ${orgId} event ${event}: ${lastError}`);
}

// ─── High-level event dispatchers ────────────────────
export async function notifyCheckIn(orgId: string, name: string, time: string, department?: string): Promise<void> {
  const org = await getOrgGroups(orgId, department);
  for (const groupId of org.groupIds) {
    await notify({ orgId, event: 'check_in', message: Templates.CHECK_IN(name, time), recipientType: 'group', recipientId: groupId });
  }
}

export async function notifyCheckOut(orgId: string, name: string, time: string, department?: string): Promise<void> {
  const org = await getOrgGroups(orgId, department);
  for (const groupId of org.groupIds) {
    await notify({ orgId, event: 'check_out', message: Templates.CHECK_OUT(name, time), recipientType: 'group', recipientId: groupId });
  }
}

export async function notifyLateArrival(orgId: string, name: string, minutesLate: number, managerPhone: string): Promise<void> {
  // Manager only (not group)
  await notify({ orgId, event: 'late_arrival', message: Templates.LATE_ARRIVAL(name, minutesLate), recipientType: 'individual', recipientId: managerPhone });
}

export async function notifyAbsent(orgId: string, name: string, managerPhone: string): Promise<void> {
  await notify({ orgId, event: 'absent', message: Templates.ABSENT(name), recipientType: 'individual', recipientId: managerPhone });
}

export async function notifyRemote(orgId: string, name: string, department?: string): Promise<void> {
  const org = await getOrgGroups(orgId, department);
  for (const groupId of org.groupIds) {
    await notify({ orgId, event: 'remote', message: Templates.REMOTE(name), recipientType: 'group', recipientId: groupId });
  }
}

export async function notifyRemotePending(orgId: string, employeeName: string, duration: string, managerPhone: string): Promise<void> {
  await notify({ orgId, event: 'remote_request', message: Templates.REMOTE_REQUEST(employeeName, duration), recipientType: 'individual', recipientId: managerPhone });
}

export async function notifyLeaveApproved(orgId: string, name: string, type: string, dates: string, employeePhone: string): Promise<void> {
  await notify({ orgId, event: 'leave_approved', message: Templates.LEAVE_APPROVED(name, type, dates), recipientType: 'individual', recipientId: employeePhone });
}

export async function notifyLeaveRejected(orgId: string, name: string, type: string, dates: string, reason: string, employeePhone: string): Promise<void> {
  await notify({ orgId, event: 'leave_rejected', message: Templates.LEAVE_REJECTED(name, type, dates, reason), recipientType: 'individual', recipientId: employeePhone });
}

export async function notifyPayslip(orgId: string, name: string, month: string, employeePhone: string): Promise<void> {
  await notify({ orgId, event: 'payslip_ready', message: Templates.PAYSLIP_READY(name, month), recipientType: 'individual', recipientId: employeePhone });
}

export async function notifyShiftReminder(orgId: string, name: string, time: string, employeePhone: string): Promise<void> {
  await notify({ orgId, event: 'shift_reminder', message: Templates.SHIFT_REMINDER(name, time), recipientType: 'individual', recipientId: employeePhone });
}

// AI remote nudges
export async function sendRemoteNudge(orgId: string, name: string, nudgeType: 'morning' | 'midday' | 'eod', employeePhone: string): Promise<void> {
  const event = nudgeType === 'morning' ? 'remote_morning' : nudgeType === 'midday' ? 'remote_midday' : 'remote_eod';
  const message = nudgeType === 'morning' ? Templates.REMOTE_MORNING(name) : nudgeType === 'midday' ? Templates.REMOTE_MIDDAY(name) : Templates.REMOTE_EOD(name);
  await notify({ orgId, event, message, recipientType: 'individual', recipientId: employeePhone });
}

// ─── WhatsApp webhook handler (inbound replies) ───────
export async function handleWebhookReply(body: any): Promise<void> {
  const entry    = body?.entry?.[0];
  const change   = entry?.changes?.[0];
  const value    = change?.value;
  const messages = value?.messages;
  if (!messages?.length) return;

  for (const msg of messages) {
    if (msg.type !== 'text') continue;
    const from    = msg.from;       // phone number
    const text    = msg.text?.body;
    const timestamp = new Date(parseInt(msg.timestamp) * 1000);

    // Match to a user by phone
    const user = await prisma.user.findFirst({ where: { phone: `+${from}` } });
    if (!user) continue;

    // Find active remote session for today
    const today = new Date(); today.setHours(0,0,0,0);
    const attendance = await prisma.attendanceRecord.findFirst({
      where: { user_id: user.id, date: today, status: 'remote' },
      include: { remote_session: true },
    });
    if (!attendance?.remote_session) continue;

    const session = attendance.remote_session;

    // Determine which nudge this is a reply to
    let nudgeType: 'morning' | 'midday' | 'end_of_day' = 'morning';
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 12 && hour < 16) nudgeType = 'midday';
    else if (hour >= 16) nudgeType = 'end_of_day';

    // Log the raw reply
    await prisma.remoteCheckinLog.create({
      data: {
        remote_session_id: session.id,
        nudge_type: nudgeType,
        nudge_sent_at: nudgeType === 'morning' ? (session.morning_nudge_at || new Date()) : (session.midday_nudge_at || new Date()),
        reply_text: text,
        reply_at: timestamp,
      },
    });

    // Parse with Claude AI
    await parseRemoteReplyWithClaude(session.id, text, user, nudgeType);
  }
}

// ─── Claude AI reply parser ───────────────────────────
async function parseRemoteReplyWithClaude(
  sessionId: string,
  replyText: string,
  user: any,
  nudgeType: string,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key — store raw text
    await prisma.remoteCheckinLog.updateMany({
      where: { remote_session_id: sessionId, nudge_type: nudgeType, task_summary: null },
      data: { task_summary: replyText.substring(0, 500) },
    });
    return;
  }

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are parsing a remote employee work check-in reply. Extract structured information.

Employee: ${user.name}
Check-in type: ${nudgeType}
Their reply: "${replyText}"

Respond ONLY with valid JSON (no markdown):
{
  "task_summary": "brief summary of what they're working on (max 100 chars)",
  "blockers": "any blockers mentioned or null",
  "sentiment": "positive|neutral|negative"
}`,
        }],
      },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } },
    );

    const content = res.data?.content?.[0]?.text;
    if (!content) return;

    const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
    await prisma.remoteCheckinLog.updateMany({
      where: { remote_session_id: sessionId, nudge_type: nudgeType, task_summary: null },
      data: {
        task_summary: parsed.task_summary || replyText.substring(0, 100),
        blockers:     parsed.blockers || null,
        sentiment:    parsed.sentiment || 'neutral',
      },
    });

    // If morning reply → mark as checked in
    if (nudgeType === 'morning') {
      const session = await prisma.remoteSession.findUnique({ where: { id: sessionId } });
      if (session) {
        await prisma.attendanceRecord.update({
          where: { id: session.attendance_id },
          data: { check_in_at: new Date() },
        });
      }
    }
  } catch (err) {
    console.error('[Claude] Failed to parse remote reply:', err);
  }
}

// ─── Helpers ──────────────────────────────────────────
async function getOrgGroups(orgId: string, department?: string): Promise<{ groupIds: string[] }> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId } });
  if (!org) return { groupIds: [] };

  // If a department is provided, prefer the department-specific group
  if (department) {
    const deptGroups = (org.wa_dept_groups as Record<string, string>) || {};
    const deptGroupId = deptGroups[department];
    if (deptGroupId) return { groupIds: [deptGroupId] };
  }

  return { groupIds: org.wa_group_ids || [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatTime12h(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}
