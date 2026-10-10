import api from '../services/api.client';
import { useAccountStore, useAuthStore } from './index';

jest.mock('../services/api.client', () => ({
  __esModule: true,
  default: { get: jest.fn() },
  setUnauthorizedHandler: jest.fn(),
}));

function pendingAccount() {
  let resolve!: (value: any) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('account response ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.getState().logout();
  });

  it('keeps the latest market when an older request finishes last', async () => {
    const old = pendingAccount();
    const latest = pendingAccount();
    (api.get as jest.Mock).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const cn = useAccountStore.getState().fetchAccount('CN');
    const us = useAccountStore.getState().fetchAccount('US');
    latest.resolve({ data: { account: { mode: 'US' }, positions: [] } });
    await us;
    old.resolve({ data: { account: { mode: 'CN' }, positions: [] } });
    await cn;
    expect(useAccountStore.getState().account).toEqual({ mode: 'US' });
  });

  it('does not restore account data after logout', async () => {
    const request = pendingAccount();
    (api.get as jest.Mock).mockReturnValue(request.promise);
    const fetch = useAccountStore.getState().fetchAccount('CN');
    useAuthStore.getState().logout();
    request.resolve({ data: { account: { mode: 'CN' }, positions: [{}] } });
    await fetch;
    expect(useAccountStore.getState().account).toBeNull();
    expect(useAccountStore.getState().positions).toEqual([]);
  });

  it('does not overwrite a newer pushed account with a pending response', async () => {
    const request = pendingAccount();
    (api.get as jest.Mock).mockReturnValue(request.promise);
    const fetch = useAccountStore.getState().fetchAccount('CN');
    useAccountStore.getState().setAccount({ account: { cash: 200 }, positions: [] });
    request.resolve({ data: { account: { cash: 100 }, positions: [] } });
    await fetch;
    expect(useAccountStore.getState().account).toEqual({ cash: 200 });
  });
});
