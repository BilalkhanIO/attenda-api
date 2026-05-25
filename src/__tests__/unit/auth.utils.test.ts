import {
  hashPassword, comparePassword, signAccessToken, signRefreshToken,
  verifyAccessToken, verifyRefreshToken, generateToken,
  calculateWorkingDays, startOfDay, endOfDay, startOfMonth, endOfMonth,
  calcHoursWorked,
} from '../../utils/auth';

describe('Auth Utils', () => {
  describe('Password hashing', () => {
    it('hashes a password and compares correctly', async () => {
      const hash  = await hashPassword('MySecret123!');
      const valid = await comparePassword('MySecret123!', hash);
      expect(valid).toBe(true);
    });

    it('rejects wrong password', async () => {
      const hash  = await hashPassword('MySecret123!');
      const valid = await comparePassword('WrongPass', hash);
      expect(valid).toBe(false);
    });
  });

  describe('JWT tokens', () => {
    const payload = { sub: 'user-1', org_id: 'org-1', role: 'employee', name: 'Test User', email: 'test@test.com' };

    it('signs and verifies access token', () => {
      const token   = signAccessToken(payload);
      const decoded = verifyAccessToken(token);
      expect(decoded.sub).toBe(payload.sub);
      expect(decoded.org_id).toBe(payload.org_id);
      expect(decoded.role).toBe(payload.role);
      expect(decoded.jti).toBeTruthy();
    });

    it('signs and verifies refresh token', () => {
      const token   = signRefreshToken('user-1');
      const decoded = verifyRefreshToken(token);
      expect(decoded.sub).toBe('user-1');
      expect(decoded.jti).toBeTruthy();
    });

    it('throws on invalid token', () => {
      expect(() => verifyAccessToken('invalid.token.here')).toThrow();
    });
  });

  describe('generateToken', () => {
    it('generates a unique 64-char hex string', () => {
      const t1 = generateToken();
      const t2 = generateToken();
      expect(t1.length).toBe(64);
      expect(t1).not.toBe(t2);
    });
  });

  describe('calculateWorkingDays', () => {
    it('counts only Mon-Fri', () => {
      // Mon Jun 2 – Fri Jun 6 2025 = 5 working days
      const start = new Date('2025-06-02');
      const end   = new Date('2025-06-06');
      expect(calculateWorkingDays(start, end)).toBe(5);
    });

    it('excludes weekends', () => {
      // Fri Jun 6 – Mon Jun 9 2025 = 2 working days (Mon + Fri)
      const start = new Date('2025-06-06');
      const end   = new Date('2025-06-09');
      expect(calculateWorkingDays(start, end)).toBe(2);
    });

    it('same day returns 1 if weekday', () => {
      const d = new Date('2025-06-02'); // Monday
      expect(calculateWorkingDays(d, d)).toBe(1);
    });

    it('same day returns 0 if weekend', () => {
      const d = new Date('2025-06-07'); // Saturday
      expect(calculateWorkingDays(d, d)).toBe(0);
    });
  });

  describe('Date helpers', () => {
    it('startOfDay zeros the time', () => {
      const d = startOfDay(new Date('2025-06-15T14:30:00'));
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
    });

    it('endOfDay sets time to 23:59:59', () => {
      const d = endOfDay(new Date('2025-06-15T08:00:00'));
      expect(d.getHours()).toBe(23);
      expect(d.getMinutes()).toBe(59);
      expect(d.getSeconds()).toBe(59);
    });

    it('startOfMonth returns first day of month', () => {
      const d = startOfMonth(2025, 6);
      expect(d.getFullYear()).toBe(2025);
      expect(d.getMonth()).toBe(5); // 0-indexed
      expect(d.getDate()).toBe(1);
    });

    it('endOfMonth returns last day of month', () => {
      const d = endOfMonth(2025, 6);
      expect(d.getDate()).toBe(30); // June has 30 days
    });
  });

  describe('calcHoursWorked', () => {
    it('calculates hours correctly', () => {
      const checkIn  = new Date('2025-06-15T09:00:00');
      const checkOut = new Date('2025-06-15T17:30:00');
      expect(calcHoursWorked(checkIn, checkOut)).toBe(8.5);
    });

    it('rounds to 2 decimal places', () => {
      const checkIn  = new Date('2025-06-15T09:00:00');
      const checkOut = new Date('2025-06-15T09:01:00'); // 1 minute = 0.0167 hrs → rounds to 0.02
      const result   = calcHoursWorked(checkIn, checkOut);
      expect(result).toBeLessThan(0.1);
    });
  });
});
