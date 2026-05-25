import { Templates, formatTime12h } from '../../services/whatsapp';

describe('WhatsApp Service', () => {
  describe('Templates', () => {
    it('CHECK_IN template', () => {
      const msg = Templates.CHECK_IN('Alice Chen', '09:05 AM');
      expect(msg).toContain('Alice Chen');
      expect(msg).toContain('09:05 AM');
      expect(msg).toContain('✅');
    });

    it('CHECK_OUT template', () => {
      const msg = Templates.CHECK_OUT('Bob Smith', '06:00 PM');
      expect(msg).toContain('Bob Smith');
      expect(msg).toContain('🔴');
    });

    it('LATE_ARRIVAL template', () => {
      const msg = Templates.LATE_ARRIVAL('Tom Walker', 30);
      expect(msg).toContain('Tom Walker');
      expect(msg).toContain('30');
      expect(msg).toContain('⚠️');
    });

    it('ABSENT template', () => {
      const msg = Templates.ABSENT('Jane Doe');
      expect(msg).toContain('Jane Doe');
      expect(msg).toContain('❌');
    });

    it('REMOTE template', () => {
      const msg = Templates.REMOTE('Aisha Patel');
      expect(msg).toContain('Aisha Patel');
      expect(msg).toContain('🏠');
    });

    it('LEAVE_APPROVED template', () => {
      const msg = Templates.LEAVE_APPROVED('Sarah', 'Annual', 'Jun 10–14');
      expect(msg).toContain('Sarah');
      expect(msg).toContain('Annual');
      expect(msg).toContain('Jun 10–14');
      expect(msg).toContain('📋');
    });

    it('PAYSLIP_READY template', () => {
      const msg = Templates.PAYSLIP_READY('John', 'May 2026');
      expect(msg).toContain('John');
      expect(msg).toContain('May 2026');
      expect(msg).toContain('💰');
    });

    it('SHIFT_REMINDER template', () => {
      const msg = Templates.SHIFT_REMINDER('Alice', '09:00');
      expect(msg).toContain('Alice');
      expect(msg).toContain('09:00');
      expect(msg).toContain('⏰');
    });

    it('REMOTE_MORNING template', () => {
      const msg = Templates.REMOTE_MORNING('Alice');
      expect(msg).toContain('Alice');
      expect(msg.toLowerCase()).toContain('morning');
    });

    it('REMOTE_MIDDAY template', () => {
      const msg = Templates.REMOTE_MIDDAY('Alice');
      expect(msg).toContain('Alice');
    });

    it('REMOTE_EOD template', () => {
      const msg = Templates.REMOTE_EOD('Alice');
      expect(msg).toContain('Alice');
    });
  });

  describe('formatTime12h', () => {
    it('formats a morning time correctly', () => {
      const d   = new Date('2025-06-15T09:05:00');
      const fmt = formatTime12h(d);
      expect(fmt).toMatch(/09:05 AM/i);
    });

    it('formats an afternoon time correctly', () => {
      const d   = new Date('2025-06-15T14:30:00');
      const fmt = formatTime12h(d);
      expect(fmt).toMatch(/02:30 PM/i);
    });
  });
});
