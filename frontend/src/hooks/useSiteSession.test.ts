import { act, renderHook, waitFor } from '@testing-library/react';
import { useSiteSession } from './useSiteSession';
import { siteAuthApi } from '../services/site-auth';
import { useAuthStore, useAccountStore } from '../store';
jest.mock('../services/site-auth', () => ({ siteAuthApi: { session: jest.fn() } }));
const session = { token: 'new-token', user: { id: 'site-game-user', username: 'alice', role: 'user' } };
beforeEach(() => { jest.clearAllMocks(); useAuthStore.getState().logout(); });

it('waits for site authentication and restores the game session', async () => {
  (siteAuthApi.session as jest.Mock).mockResolvedValue(session);
  const hook = renderHook(() => useSiteSession()); expect(hook.result.current).toBe(false);
  await waitFor(() => expect(hook.result.current).toBe(true)); expect(useAuthStore.getState().token).toBe('new-token');
});
it('clears cached game auth when the site session is revoked', async () => {
  useAuthStore.getState().setAuth('old-token', session.user);
  (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 401 } });
  const hook = renderHook(() => useSiteSession()); await waitFor(() => expect(hook.result.current).toBe(true));
  expect(useAuthStore.getState().token).toBeNull();
});
it('never restores a late response after logout', async () => {
  useAuthStore.getState().setAuth('old-token', session.user);
  let resolve!: (value: any) => void;
  (siteAuthApi.session as jest.Mock).mockReturnValue(new Promise(done => { resolve = done; }));
  const hook = renderHook(() => useSiteSession());
  await act(async () => { useAuthStore.getState().logout(); resolve(session); });
  await waitFor(() => expect(hook.result.current).toBe(true)); expect(useAuthStore.getState().token).toBeNull();
});
it('clears previous-player assets when the site account changes', async () => {
  useAuthStore.getState().setAuth('old-token', { id: 'old-user', username: 'old', role: 'user' });
  useAccountStore.setState({ account: { cash: 123 }, positions: [{ symbol: 'old' }] });
  (siteAuthApi.session as jest.Mock).mockResolvedValue(session);
  const hook = renderHook(() => useSiteSession()); await waitFor(() => expect(hook.result.current).toBe(true));
  expect(useAccountStore.getState().account).toBeNull(); expect(useAccountStore.getState().positions).toEqual([]);
});
