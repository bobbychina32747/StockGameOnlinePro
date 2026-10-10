import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Login from './Login';
import { siteAuthApi } from '../../services/site-auth';
import { useAuthStore } from '../../store';

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
it('restores a linked site session without showing a password form', async () => {
  (siteAuthApi.session as jest.Mock).mockResolvedValue(session); page();
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
