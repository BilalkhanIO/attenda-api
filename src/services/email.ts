// @ts-nocheck
import nodemailer from 'nodemailer';

interface MailOptions {
  to:      string;
  subject: string;
  html:    string;
  text?:   string;
}

// ─── Transporter ─────────────────────────────────────
function getTransporter() {
  // In development, log to console instead of sending
  if (process.env.NODE_ENV === 'development' || !process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      jsonTransport: true,
    });
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ─── Send wrapper ─────────────────────────────────────
export async function sendEmail(opts: MailOptions): Promise<void> {
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from:    `"Attenda" <${process.env.SMTP_FROM || 'noreply@attenda.app'}>`,
    to:      opts.to,
    subject: opts.subject,
    html:    opts.html,
    text:    opts.text || opts.html.replace(/<[^>]*>/g, ''),
  });

  if (process.env.NODE_ENV === 'development') {
    console.log(`[EMAIL] To: ${opts.to} | Subject: ${opts.subject}`);
    console.log('[EMAIL] (dev mode — not actually sent)');
  }
}

// ─── Base HTML wrapper ────────────────────────────────
function baseTemplate(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;border:1px solid #E2E8F0;overflow:hidden;">
        <!-- Header -->
        <tr>
          <td style="background:#0F172A;padding:24px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <span style="color:#1D4ED8;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Attenda</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Body -->
        <tr><td style="padding:32px;">${body}</td></tr>
        <!-- Footer -->
        <tr>
          <td style="padding:24px 32px;border-top:1px solid #E2E8F0;background:#F8FAFC;">
            <p style="margin:0;font-size:12px;color:#64748B;text-align:center;">
              © 2026 Attenda. Your team, always accounted for.<br>
              <a href="#" style="color:#1D4ED8;">Unsubscribe</a> · <a href="#" style="color:#1D4ED8;">Privacy Policy</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Email templates ──────────────────────────────────

// Welcome / Setup Account
export async function sendWelcomeEmail(to: string, name: string, orgName: string, setupLink: string): Promise<void> {
  const body = `
    <h2 style="margin:0 0 8px;color:#0F172A;font-size:22px;font-weight:700;">Welcome to Attenda, ${name}! 👋</h2>
    <p style="margin:0 0 24px;color:#64748B;font-size:15px;line-height:1.6;">
      <strong>${orgName}</strong> has added you to their Attenda workspace. 
      Click the button below to set your password and get started.
    </p>
    <a href="${setupLink}" style="display:inline-block;background:#1D4ED8;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;margin-bottom:24px;">
      Set Up My Account →
    </a>
    <p style="margin:0 0 8px;color:#64748B;font-size:13px;">This link expires in <strong>7 days</strong>. If it has expired, ask your HR Admin to resend your invite.</p>
    <div style="background:#F1F5F9;border-radius:10px;padding:16px;margin-top:24px;">
      <p style="margin:0;font-size:13px;color:#64748B;">
        <strong style="color:#0F172A;">What you can do with Attenda:</strong><br>
        ✅ Auto check-in via office WiFi · 📅 Request leave · 💰 View payslips · ⏰ See your schedule
      </p>
    </div>
  `;
  await sendEmail({ to, subject: `Welcome to ${orgName} on Attenda — Set up your account`, html: baseTemplate('Welcome to Attenda', body) });
}

// Password Reset
export async function sendPasswordResetEmail(to: string, name: string, resetLink: string): Promise<void> {
  const body = `
    <h2 style="margin:0 0 8px;color:#0F172A;font-size:22px;font-weight:700;">Reset your password</h2>
    <p style="margin:0 0 24px;color:#64748B;font-size:15px;line-height:1.6;">
      Hi ${name}, we received a request to reset your Attenda password. Click below to choose a new one.
    </p>
    <a href="${resetLink}" style="display:inline-block;background:#1D4ED8;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;margin-bottom:24px;">
      Reset Password →
    </a>
    <p style="margin:0;color:#64748B;font-size:13px;">
      This link expires in <strong>15 minutes</strong>. If you didn't request this, ignore this email — your account is safe.
    </p>
  `;
  await sendEmail({ to, subject: 'Reset your Attenda password', html: baseTemplate('Password Reset', body) });
}

// Payslip Ready
export async function sendPayslipEmail(to: string, name: string, period: string, downloadUrl: string): Promise<void> {
  const body = `
    <h2 style="margin:0 0 8px;color:#0F172A;font-size:22px;font-weight:700;">Your payslip is ready 💰</h2>
    <p style="margin:0 0 24px;color:#64748B;font-size:15px;line-height:1.6;">
      Hi ${name}, your payslip for <strong>${period}</strong> has been processed and is now available.
    </p>
    <a href="${downloadUrl}" style="display:inline-block;background:#065F46;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;margin-bottom:24px;">
      Download Payslip →
    </a>
    <p style="margin:0;color:#64748B;font-size:12px;">
      This download link expires in 15 minutes. You can also access your payslip any time in the Attenda app under Profile → Payslips.
    </p>
  `;
  await sendEmail({ to, subject: `Your ${period} payslip is now available`, html: baseTemplate('Payslip Ready', body) });
}

// Leave Approved
export async function sendLeaveApprovedEmail(to: string, name: string, leaveType: string, dates: string, approverName: string): Promise<void> {
  const body = `
    <h2 style="margin:0 0 8px;color:#0F172A;font-size:22px;font-weight:700;">Leave approved ✅</h2>
    <p style="margin:0 0 24px;color:#64748B;font-size:15px;line-height:1.6;">
      Hi ${name}, your <strong>${leaveType} leave</strong> request for <strong>${dates}</strong> has been approved by ${approverName}.
    </p>
    <div style="background:#D1FAE5;border-radius:10px;padding:16px;border-left:4px solid #065F46;">
      <p style="margin:0;color:#065F46;font-weight:600;">Enjoy your time off! Your team has been notified.</p>
    </div>
  `;
  await sendEmail({ to, subject: `Leave approved — ${leaveType} ${dates}`, html: baseTemplate('Leave Approved', body) });
}

// Leave Rejected
export async function sendLeaveRejectedEmail(to: string, name: string, leaveType: string, dates: string, reason: string): Promise<void> {
  const body = `
    <h2 style="margin:0 0 8px;color:#0F172A;font-size:22px;font-weight:700;">Leave request declined</h2>
    <p style="margin:0 0 24px;color:#64748B;font-size:15px;line-height:1.6;">
      Hi ${name}, your <strong>${leaveType} leave</strong> request for <strong>${dates}</strong> has been declined.
    </p>
    <div style="background:#FEE2E2;border-radius:10px;padding:16px;border-left:4px solid #991B1B;">
      <p style="margin:0 0 4px;color:#991B1B;font-weight:700;font-size:13px;">REASON</p>
      <p style="margin:0;color:#991B1B;font-size:14px;">${reason}</p>
    </div>
    <p style="margin-top:16px;color:#64748B;font-size:13px;">
      Please speak with your manager if you have questions about this decision.
    </p>
  `;
  await sendEmail({ to, subject: `Leave request declined — ${leaveType} ${dates}`, html: baseTemplate('Leave Declined', body) });
}

// Account Deactivated
export async function sendDeactivationEmail(to: string, name: string, orgName: string): Promise<void> {
  const body = `
    <h2 style="margin:0 0 8px;color:#0F172A;font-size:22px;font-weight:700;">Account deactivated</h2>
    <p style="margin:0 0 24px;color:#64748B;font-size:15px;line-height:1.6;">
      Hi ${name}, your Attenda account for <strong>${orgName}</strong> has been deactivated. You can no longer log in.
    </p>
    <p style="color:#64748B;font-size:13px;">If you believe this is an error, please contact your HR Admin.</p>
  `;
  await sendEmail({ to, subject: 'Your Attenda account has been deactivated', html: baseTemplate('Account Deactivated', body) });
}
