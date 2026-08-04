// pushChallenge must be a safe no-op when FIREBASE_SERVICE_ACCOUNT is absent
// (the default in dev/CI) and must not touch the DB in that case.

const findUnique = jest.fn();
jest.mock('../../utils/prisma', () => ({
  __esModule: true,
  default: { user: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

describe('pushChallenge service', () => {
  const ORIGINAL_ENV = process.env.FIREBASE_SERVICE_ACCOUNT;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
    else process.env.FIREBASE_SERVICE_ACCOUNT = ORIGINAL_ENV;
    jest.resetModules();
    findUnique.mockReset();
  });

  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../services/pushChallenge');
    mod._resetForTests();
    return mod;
  }

  it('isPushConfigured() is false without FIREBASE_SERVICE_ACCOUNT', () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const { isPushConfigured } = load();
    expect(isPushConfigured()).toBe(false);
  });

  it('sendPresenceChallenge() no-ops (false) when unconfigured', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const { sendPresenceChallenge } = load();
    await expect(sendPresenceChallenge('user-1')).resolves.toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('isPushConfigured() is false when the JSON is malformed', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = 'not-json';
    const { isPushConfigured } = load();
    expect(isPushConfigured()).toBe(false);
  });

  it('logs the disabled line only once across repeated checks', () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { isPushConfigured } = load();
    isPushConfigured();
    isPushConfigured();
    isPushConfigured();
    const lines = spy.mock.calls.filter(c => String(c[0]).includes('FIREBASE_SERVICE_ACCOUNT not set'));
    expect(lines).toHaveLength(1);
    spy.mockRestore();
  });
});
