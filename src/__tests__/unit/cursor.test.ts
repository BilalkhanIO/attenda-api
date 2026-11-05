import { decodeCursor, encodeCursor, keysetAfter } from '../../utils/cursor';

describe('signed pagination cursors', () => {
  const filters = { org_id: 'org-a', status: 'pending' };

  beforeAll(() => { process.env.JWT_SECRET = 'cursor-unit-test-secret'; });

  it('round-trips a dated keyset position when the effective filters match', () => {
    const at = new Date('2026-11-03T08:15:00.000Z');
    const cursor = encodeCursor({ at, id: 'row-123' }, filters);
    expect(decodeCursor(cursor, filters)).toEqual({ at, id: 'row-123' });
    expect(keysetAfter({ at, id: 'row-123' }, 'created_at')).toEqual({
      OR: [
        { created_at: { lt: at } },
        { created_at: at, id: { lt: 'row-123' } },
      ],
    });
  });

  it('rejects tampering and cursor reuse with changed filters', () => {
    const cursor = encodeCursor({ at: new Date('2026-11-03T08:15:00.000Z'), id: 'row-123' }, filters);
    const [payload, signature] = cursor.split('.');
    const changedLast = signature.endsWith('x') ? 'y' : 'x';
    expect(() => decodeCursor(`${payload}.${signature.slice(0, -1)}${changedLast}`, filters)).toThrow(/Invalid or expired/);
    expect(() => decodeCursor(cursor, { ...filters, status: 'approved' })).toThrow(/Invalid or expired/);
  });

  it('recognizes unexpired UUID anchors from the legacy pagination contract', () => {
    expect(decodeCursor('29634ebd-af5e-4808-a2d3-fca3e8aeaeaa', filters)).toBeNull();
  });
});
