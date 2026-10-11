import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Login from './Login';
import { siteAuthApi } from '../../services/site-auth';
import { useAuthStore } from '../../store';
import { authApi } from '../../services/api.client';
jest.mock('../../services/api.client', () => ({ authApi: { login: jest.fn(), register: jest.fn() }, setUnauthorizedHandler: jest.fn(), setSessionRenewedHandler: jest.fn() }));

jest.mock('../../services/site-auth', () => ({
  siteAuthApi: { session: jest.fn(), link: jest.fn() },
  siteLoginUrl: () => 'https://bobbycn.cc/login/?next=game',
}));
const setup = { needsAccountSetup: true, identity: { username: '站点玩家' } };
const session = { token: 'site-token', expiresIn: 600, user: { id: 'game-user', username: '玩家', role: 'user' } };
function page() {
  render(<MemoryRouter initialEntries={['/login']}><Routes>
    <Route path="/login" element={<Login />} /><Route path="/" element={<p>游戏已打开</p>} />
  </Routes></MemoryRouter>);
}
beforeEach(() => { jest.clearAllMocks(); useAuthStore.getState().logout(); });

it('uses the central site login when there is no site cookie', async () => {
  (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 401 } }); page();
  expect(await screen.findByRole('link', { name: '使用站点账号登录' })).toHaveAttribute('href', 'https://bobbycn.cc/login/?next=game');
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
});
it('offers the linked site session while leaving the game login choice available', async () => {
  (siteAuthApi.session as jest.Mock).mockResolvedValue(session); page();
  fireEvent.click(await screen.findByRole('button', { name: '继续使用站点账号' }));
  expect(await screen.findByText('游戏已打开')).toBeInTheDocument(); expect(useAuthStore.getState().token).toBe('site-token');
});
it('waits for a first-time player to choose before creating an account', async () => {
  (siteAuthApi.session as jest.Mock).mockResolvedValue(setup); page();
  await screen.findByText('绑定旧游戏账号');
  expect(siteAuthApi.session).toHaveBeenCalledWith();
  expect(siteAuthApi.session).not.toHaveBeenCalledWith(true);
  (siteAuthApi.session as jest.Mock).mockResolvedValue(session);
  fireEvent.click(screen.getByText('首次游玩，创建游戏账户'));
  expect(await screen.findByText('游戏已打开')).toBeInTheDocument(); expect(siteAuthApi.session).toHaveBeenCalledWith(true);
});
it('binds the legacy game credentials and enters the original game account', async () => {
  (siteAuthApi.session as jest.Mock).mockResolvedValue(setup); (siteAuthApi.link as jest.Mock).mockResolvedValue(session); page();
  fireEvent.click(await screen.findByText('绑定旧游戏账号'));
  fireEvent.change(screen.getByLabelText('旧游戏用户名'), { target: { value: 'old-user' } });
  fireEvent.change(screen.getByLabelText('旧游戏密码'), { target: { value: 'old-password' } });
  fireEvent.click(screen.getByText('绑定并进入游戏'));
  expect(await screen.findByText('游戏已打开')).toBeInTheDocument();
  expect(siteAuthApi.link).toHaveBeenCalledWith('old-user', 'old-password');
});
it('shows a binding error without signing in or retaining the password', async () => {
  (siteAuthApi.session as jest.Mock).mockResolvedValue(setup);
  (siteAuthApi.link as jest.Mock).mockRejectedValue({ response: { status: 409, data: { message: '账号已绑定' } } }); page();
  fireEvent.click(await screen.findByText('绑定旧游戏账号'));
  fireEvent.change(screen.getByLabelText('旧游戏用户名'), { target: { value: 'old-user' } });
  fireEvent.change(screen.getByLabelText('旧游戏密码'), { target: { value: 'old-password' } });
  fireEvent.click(screen.getByText('绑定并进入游戏'));
  expect(await screen.findByRole('alert')).toHaveTextContent('账号已绑定');
  expect(screen.getByLabelText('旧游戏密码')).toHaveValue(''); expect(useAuthStore.getState().token).toBeNull();
});
it('a stale session response cannot overwrite a newer sign-in', async () => {
  let resolve!: (value: any) => void;
  (siteAuthApi.session as jest.Mock).mockReturnValue(new Promise(done => { resolve = done; })); page();
  await act(async () => { useAuthStore.getState().setAuth('new-token', { id: 'new-user', username: 'new', role: 'user' }); resolve(session); });
  await waitFor(() => expect(useAuthStore.getState().token).toBe('new-token'));
});
it('signs in with a game password without requiring a site identity', async () => {
  (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 401 } });
  (authApi.login as jest.Mock).mockResolvedValue(session); page();
  await waitFor(() => expect(screen.getByRole('button', { name: '游戏账号' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: '游戏账号' }));
  fireEvent.change(screen.getByLabelText('游戏用户名'), { target: { value: '  old-user  ' } });
  fireEvent.change(screen.getByLabelText('游戏密码'), { target: { value: 'old-password' } });
  fireEvent.click(screen.getByRole('button', { name: '登录游戏' }));
  expect(await screen.findByText('游戏已打开')).toBeInTheDocument();
  expect(authApi.login).toHaveBeenCalledWith('old-user', 'old-password');
});
it('requires matching registration passwords, then registers and signs in', async () => {
  (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 401 } });
  (authApi.register as jest.Mock).mockResolvedValue(session); page();
  await waitFor(() => expect(screen.getByRole('button', { name: '游戏账号' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: '游戏账号' }));
  fireEvent.click(screen.getByRole('button', { name: '没有游戏账号，去注册' }));
  fireEvent.change(screen.getByLabelText('游戏用户名'), { target: { value: 'new-user' } });
  fireEvent.change(screen.getByLabelText('游戏密码'), { target: { value: 'new-password' } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'wrong-password' } });
  fireEvent.click(screen.getByRole('button', { name: '注册并进入游戏' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('两次密码不一致');expect(authApi.register).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'new-password' } });
  fireEvent.click(screen.getByRole('button', { name: '注册并进入游戏' }));
  expect(await screen.findByText('游戏已打开')).toBeInTheDocument();expect(authApi.register).toHaveBeenCalledWith('new-user', 'new-password');
});
it('shows duplicate registration errors and clears both passwords', async () => {
  (siteAuthApi.session as jest.Mock).mockRejectedValue({ response: { status: 401 } });
  (authApi.register as jest.Mock).mockResolvedValue({ success: false, error: '注册失败，请更换用户名' });page();
  await waitFor(() => expect(screen.getByRole('button', { name: '游戏账号' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: '游戏账号' }));fireEvent.click(screen.getByRole('button', { name: '没有游戏账号，去注册' }));
  fireEvent.change(screen.getByLabelText('游戏用户名'), { target: { value: 'duplicate' } });
  for(const label of ['游戏密码','确认密码'])fireEvent.change(screen.getByLabelText(label), { target: { value: 'new-password' } });
  fireEvent.click(screen.getByRole('button', { name: '注册并进入游戏' }));expect(await screen.findByRole('alert')).toHaveTextContent('注册失败');
  expect(screen.getByLabelText('游戏密码')).toHaveValue('');expect(screen.getByLabelText('确认密码')).toHaveValue('');expect(useAuthStore.getState().token).toBeNull();
});
