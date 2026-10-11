import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AxiosError } from 'axios';
import App from './App';
import api from './services/api.client';
import { siteAuthApi } from './services/site-auth';
import { useAuthStore } from './store';

jest.mock('./services/site-auth', () => ({ siteAuthApi: { session: jest.fn() }, siteLoginUrl: () => '/site-login' }));
jest.mock('./components/Layout/AppLayout', () => ({ AppLayout: () => { const { Outlet } = jest.requireActual('react-router-dom'); return <Outlet />; } }));
jest.mock('./pages/Dashboard/Dashboard', () => ({ __esModule: true, default: function Dashboard() {
  const React = jest.requireActual<typeof import('react')>('react');
  const { accountApi } = jest.requireActual<typeof import('./services/api.client')>('./services/api.client');
  const [cash, setCash] = React.useState<number>();
  React.useEffect(() => { void accountApi.get().then(data => setCash(data.cash)).catch(() => {}); }, []);
  return <p>游戏账户：{cash ?? '加载中'}</p>;
} }));
const token = (alg: string, suffix: string) => btoa(JSON.stringify({ alg })) + '.' + suffix + '.signature';
const user = { id: 'integration-player', username: '玩家', role: 'user' };
function page() { return render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>); }
beforeEach(() => { jest.clearAllMocks(); useAuthStore.getState().logout(); });

it('keeps the actual protected route open after password login, focus and remount with no site cookie', async () => {
  (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 401 } });
  const passwordToken = token('HS256', 'password');
  useAuthStore.getState().setAuth(passwordToken, user);
  api.defaults.adapter = async config => ({ config, status: 200, statusText: 'OK', headers: {}, data: { cash: 123 } });
  const first = page(); await screen.findByText('游戏账户：123');
  fireEvent.focus(window); await act(async () => {});
  expect(useAuthStore.getState().token).toBe(passwordToken);
  first.unmount(); page(); await screen.findByText('游戏账户：123');
  expect(siteAuthApi.session).not.toHaveBeenCalled();
});

it('shows the GUI, renews a rejected site token, and stays on the game route', async () => {
  const expired = token('EdDSA', 'expired'), renewed = token('EdDSA', 'renewed');
  (siteAuthApi.session as jest.Mock).mockResolvedValueOnce({ token: expired, user }).mockResolvedValue({ token: renewed, user });
  api.defaults.adapter = async config => {
    const response = { config, status: 200, statusText: 'OK', headers: {}, data: { cash: 456 } };
    if (config.headers.Authorization === 'Bearer ' + expired) throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { ...response, status: 401 });
    return response;
  };
  page(); await screen.findByText('游戏账户：456');
  expect(useAuthStore.getState().token).toBe(renewed);
  expect(screen.queryByText('站点账号或游戏账号均可登录')).not.toBeInTheDocument();
});

it('returns to login when the site confirms that the session has been revoked', async () => {
  (siteAuthApi.session as jest.Mock).mockResolvedValueOnce({ token: token('EdDSA', 'valid'), user }).mockRejectedValue({ response: { status: 401 } });
  api.defaults.adapter = async config => ({ config, status: 200, statusText: 'OK', headers: {}, data: { cash: 789 } });
  page(); await screen.findByText('游戏账户：789');
  fireEvent.focus(window);
  await waitFor(() => expect(useAuthStore.getState().token).toBeNull());
  await screen.findByText('站点账号或游戏账号均可登录');
});
