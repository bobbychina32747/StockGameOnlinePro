import { AxiosError } from 'axios';
import api, { setUnauthorizedHandler, setSessionRenewedHandler } from './api.client';
import { siteAuthApi } from './site-auth';
jest.mock('./site-auth', () => ({ siteAuthApi: { session: jest.fn() } }));

describe('401 session ownership', () => {
  beforeEach(() => { localStorage.clear(); jest.clearAllMocks(); });

  async function rejectedRequest(switchTo?: string, url = '/account') {
    api.defaults.adapter = async (config) => {
      if (switchTo) localStorage.setItem('token', switchTo);
      const response = { status: 401, statusText: 'Unauthorized', headers: {}, config, data: {} };
      throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, response);
    };
    await expect(api.get(url)).rejects.toThrow('Unauthorized');
  }

  it('does not log out a new account after an old request fails', async () => {
    const logout = jest.fn();
    setUnauthorizedHandler(logout);
    localStorage.setItem('token', 'old');
    await rejectedRequest('new');
    expect(logout).not.toHaveBeenCalled();
    expect(localStorage.getItem('token')).toBe('new');
  });

  it('logs out the current account when its token is rejected', async () => {
    const logout = jest.fn();
    setUnauthorizedHandler(logout);
    localStorage.setItem('token', 'current');
    await rejectedRequest();
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('leaves login errors to the login form', async () => {
    const logout = jest.fn();
    setUnauthorizedHandler(logout);
    localStorage.setItem('token', 'current');
    await rejectedRequest(undefined, '/auth/login');
    expect(logout).not.toHaveBeenCalled();
  });
  const siteToken = btoa(JSON.stringify({ alg: 'EdDSA' })) + '.expired.signature';
  const user = { id: 'site-player', username: 'player', role: 'user' };
  it('renews an expired site token and retries the rejected request once', async () => {
    const logout = jest.fn(); setUnauthorizedHandler(logout);
    setSessionRenewedHandler(session => { localStorage.setItem('token', session.token); });
    localStorage.setItem('token', siteToken);
    (siteAuthApi.session as jest.Mock).mockResolvedValue({ token: 'renewed', user });
    let calls = 0;
    api.defaults.adapter = async config => {
      calls++;
      const response = { status: 200, statusText: 'OK', headers: {}, config, data: { cash: 100 } };
      if (config.headers.Authorization !== 'Bearer renewed') {
        throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { ...response, status: 401 });
      }
      return response;
    };
    expect((await api.get('/account')).data).toEqual({ cash: 100 });
    expect(calls).toBe(2); expect(logout).not.toHaveBeenCalled();
  });
  it('keeps the session during a temporary renewal outage', async () => {
    const logout = jest.fn(); setUnauthorizedHandler(logout);
    localStorage.setItem('token', siteToken);
    (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 503 } });
    await rejectedRequest(); expect(logout).not.toHaveBeenCalled();
  });
  it('logs out when the site itself confirms revocation', async () => {
    const logout = jest.fn(); setUnauthorizedHandler(logout);
    localStorage.setItem('token', siteToken);
    (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 401 } });
    await rejectedRequest(); expect(logout).toHaveBeenCalledTimes(1);
  });
  it('does not revive a logged-out session when renewal finishes late', async () => {
    const logout = jest.fn(), renewed = jest.fn(); setUnauthorizedHandler(logout); setSessionRenewedHandler(renewed);
    localStorage.setItem('token', siteToken);
    (siteAuthApi.session as jest.Mock).mockImplementation(async () => { localStorage.removeItem('token'); return { token: 'renewed', user }; });
    await rejectedRequest(); expect(renewed).not.toHaveBeenCalled(); expect(logout).not.toHaveBeenCalled();
  });
});
