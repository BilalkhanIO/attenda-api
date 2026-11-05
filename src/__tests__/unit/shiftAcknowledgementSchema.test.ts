import { shiftAcknowledgementSchema } from '../../schemas';

describe('shiftAcknowledgementSchema', () => {
  it('accepts a confirmation without a note', () => {
    expect(shiftAcknowledgementSchema.safeParse({ status: 'acknowledged' }).success).toBe(true);
  });

  it('requires a useful note when reporting a conflict or asking for help', () => {
    expect(shiftAcknowledgementSchema.safeParse({ status: 'conflict', note: 'No' }).success).toBe(false);
    expect(shiftAcknowledgementSchema.safeParse({ status: 'help_requested', note: 'Need a ride' }).success).toBe(true);
  });

  it('rejects unknown acknowledgement statuses', () => {
    expect(shiftAcknowledgementSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });
});
