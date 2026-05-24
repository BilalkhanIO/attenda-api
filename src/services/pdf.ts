// @ts-nocheck
import PDFDocument from 'pdfkit';
import { uploadBuffer, S3Keys, getSignedDownloadUrl, isS3Configured } from './s3';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface PayslipData {
  orgId:         string;
  orgName:       string;
  orgLogoUrl?:   string;
  currency:      string;
  employee: {
    id:          string;
    name:        string;
    email:       string;
    jobTitle?:   string;
    department?: string;
  };
  period: {
    month:  number;
    year:   number;
    label:  string; // e.g. "May 2026"
  };
  earnings: {
    regularHours:  number;
    overtimeHours: number;
    hourlyRate:    number;
    basePay:       number;
    overtimePay:   number;
  };
  deductions: {
    unpaidDays:      number;
    unpaidDeduction: number;
    manualAdjustment: number;
  };
  grossPay:      number;
  processedAt:   Date;
  processedBy?:  string;
}

// ─── Color palette ────────────────────────────────────
const C = {
  dark:    '#0F172A',
  primary: '#1D4ED8',
  gray:    '#64748B',
  light:   '#F8FAFC',
  border:  '#E2E8F0',
  success: '#065F46',
  white:   '#FFFFFF',
};

export async function generatePayslipPDF(data: PayslipData): Promise<{ url: string; key: string }> {
  const buffer = await buildPDF(data);

  if (isS3Configured()) {
    const key = S3Keys.payslip(data.orgId, data.employee.id, data.period.year, data.period.month);
    await uploadBuffer(key, buffer, 'application/pdf');
    const url = await getSignedDownloadUrl(key, 900); // 15 min
    return { url, key };
  }

  // Fallback: save locally in dev
  const filename = `payslip-${data.employee.id}-${data.period.year}-${data.period.month}.pdf`;
  const path = join(tmpdir(), filename);
  writeFileSync(path, buffer);
  return { url: `/tmp/${filename}`, key: path };
}

function buildPDF(data: PayslipData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data',  (chunk) => chunks.push(chunk));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { employee, period, earnings, deductions, grossPay, orgName, currency } = data;
    const sym = currency === 'KES' ? 'KES ' : currency === 'GBP' ? '£' : '$';
    const fmt = (n: number) => `${sym}${n.toFixed(2)}`;

    // ── Header bar ──────────────────────────────────
    doc.rect(0, 0, doc.page.width, 80).fill(C.dark);
    doc.fillColor(C.white)
      .font('Helvetica-Bold').fontSize(22)
      .text('ATTENDA', 50, 25);
    doc.fillColor('rgba(255,255,255,0.6)')
      .font('Helvetica').fontSize(10)
      .text('Workforce Management', 50, 50);

    // Payslip title on right
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(14)
      .text('PAYSLIP', doc.page.width - 150, 28, { width: 100, align: 'right' });
    doc.fillColor('rgba(255,255,255,0.7)').font('Helvetica').fontSize(10)
      .text(period.label, doc.page.width - 150, 48, { width: 100, align: 'right' });

    // ── Org + Employee info ──────────────────────────
    let y = 110;
    doc.fillColor(C.gray).font('Helvetica').fontSize(9).text('EMPLOYER', 50, y);
    doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(12).text(orgName, 50, y + 14);

    doc.fillColor(C.gray).font('Helvetica').fontSize(9).text('EMPLOYEE', 310, y);
    doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(12).text(employee.name, 310, y + 14);
    doc.fillColor(C.gray).font('Helvetica').fontSize(9)
      .text(`${employee.jobTitle || ''}${employee.department ? ` · ${employee.department}` : ''}`, 310, y + 30)
      .text(employee.email, 310, y + 44);

    // Divider
    y = 185;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(C.border).lineWidth(1).stroke();

    // ── Earnings table ───────────────────────────────
    y = 200;
    sectionHeader(doc, 'EARNINGS', y);
    y += 22;

    const rows: [string, string, string, string][] = [
      ['Regular Hours',  fmt(earnings.hourlyRate) + '/hr', `${earnings.regularHours.toFixed(2)} hrs`, fmt(earnings.basePay)],
    ];
    if (earnings.overtimeHours > 0) {
      rows.push(['Overtime (1.5×)', fmt(earnings.hourlyRate * 1.5) + '/hr', `${earnings.overtimeHours.toFixed(2)} hrs`, fmt(earnings.overtimePay)]);
    }
    tableHeader(doc, ['Description', 'Rate', 'Units', 'Amount'], y);
    y += 20;
    for (const row of rows) {
      tableRow(doc, row, y);
      y += 20;
    }

    y += 10;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(C.border).lineWidth(0.5).stroke();

    // ── Deductions table ─────────────────────────────
    y += 15;
    const hasDeductions = deductions.unpaidDeduction > 0 || deductions.manualAdjustment !== 0;

    if (hasDeductions) {
      sectionHeader(doc, 'DEDUCTIONS', y);
      y += 22;
      tableHeader(doc, ['Description', 'Days', '', 'Amount'], y);
      y += 20;

      if (deductions.unpaidDeduction > 0) {
        tableRow(doc, ['Unpaid Leave', `${deductions.unpaidDays} days`, '', `-${fmt(deductions.unpaidDeduction)}`], y, true);
        y += 20;
      }
      if (deductions.manualAdjustment !== 0) {
        const isPos = deductions.manualAdjustment > 0;
        tableRow(doc, ['Manual Adjustment', '', '', `${isPos ? '+' : ''}${fmt(deductions.manualAdjustment)}`], y, !isPos);
        y += 20;
      }
      y += 5;
      doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(C.border).lineWidth(0.5).stroke();
      y += 10;
    }

    // ── Gross Pay Summary ────────────────────────────
    y += 10;
    doc.rect(50, y, doc.page.width - 100, 52).fill(C.primary);
    doc.fillColor(C.white).font('Helvetica').fontSize(10).text('GROSS PAY', 70, y + 12);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(22).text(fmt(grossPay), 70, y + 26);
    doc.fillColor('rgba(255,255,255,0.7)').font('Helvetica').fontSize(9)
      .text(`For ${period.label}`, doc.page.width - 200, y + 28, { width: 130, align: 'right' });

    // ── Summary breakdown box ─────────────────────────
    y += 75;
    doc.rect(50, y, doc.page.width - 100, 70).fill(C.light).stroke(C.border);
    const summaryItems = [
      ['Total Earnings',   fmt(earnings.basePay + earnings.overtimePay)],
      ['Total Deductions', fmt(deductions.unpaidDeduction + Math.max(0, -deductions.manualAdjustment))],
      ['Net Gross Pay',    fmt(grossPay)],
    ];
    const colW = (doc.page.width - 100) / 3;
    summaryItems.forEach(([label, value], i) => {
      const cx = 50 + i * colW + 20;
      doc.fillColor(C.gray).font('Helvetica').fontSize(8).text(label, cx, y + 12);
      doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(13).text(value, cx, y + 26);
      if (i < 2) {
        doc.moveTo(50 + (i + 1) * colW, y + 8).lineTo(50 + (i + 1) * colW, y + 62)
          .strokeColor(C.border).lineWidth(0.5).stroke();
      }
    });

    // ── Footer ────────────────────────────────────────
    const footerY = doc.page.height - 60;
    doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.fillColor(C.gray).font('Helvetica').fontSize(8)
      .text(`Generated by Attenda on ${data.processedAt.toDateString()}${data.processedBy ? ` · Processed by ${data.processedBy}` : ''}`, 50, footerY + 10, { align: 'center', width: doc.page.width - 100 })
      .text('This payslip is computer-generated and does not require a signature.', 50, footerY + 24, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  });
}

// ─── PDF Helper functions ─────────────────────────────
function sectionHeader(doc: PDFKit.PDFDocument, title: string, y: number) {
  doc.fillColor(C.primary).font('Helvetica-Bold').fontSize(9).text(title, 50, y, { characterSpacing: 1 });
}

function tableHeader(doc: PDFKit.PDFDocument, cols: string[], y: number) {
  const widths = [220, 100, 80, 100];
  let x = 50;
  doc.rect(50, y, doc.page.width - 100, 18).fill('#EFF6FF');
  cols.forEach((col, i) => {
    doc.fillColor(C.gray).font('Helvetica-Bold').fontSize(8)
      .text(col, x + 5, y + 5, { width: widths[i], align: i > 0 ? 'right' : 'left' });
    x += widths[i];
  });
}

function tableRow(doc: PDFKit.PDFDocument, cols: string[], y: number, isDeduction = false) {
  const widths = [220, 100, 80, 100];
  let x = 50;
  cols.forEach((col, i) => {
    doc.fillColor(i === 3 && isDeduction ? '#991B1B' : C.dark)
      .font(i === 0 ? 'Helvetica' : 'Helvetica-Bold').fontSize(9)
      .text(col, x + 5, y + 4, { width: widths[i], align: i > 0 ? 'right' : 'left' });
    x += widths[i];
  });
}
