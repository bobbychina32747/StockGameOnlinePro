import { AxiosError } from 'axios';
import api, { setUnauthorizedHandler } from './api.client';

describe('401 session ownership', () => {
  beforeEach(() => localStorage.clear());

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
});
