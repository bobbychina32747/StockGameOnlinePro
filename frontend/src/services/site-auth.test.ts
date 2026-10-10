import axios from 'axios';
import { siteAuthApi, siteLoginUrl } from './site-auth';
jest.mock('axios', () => ({ __esModule: true, default: { create: jest.fn(() => ({ post: jest.fn() })) } }));
const client = (axios.create as jest.Mock).mock.results[0].value;
beforeEach(() => { client.post.mockReset(); });

it('uses site cookies and does not copy the game token into the site request', async () => {
  localStorage.setItem('token', 'old-game-token'); client.post.mockResolvedValue({ data: { needsAccountSetup: true } });
  await siteAuthApi.session();
  expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({ withCredentials: true }));
  expect(client.post).toHaveBeenCalledWith('/auth/site-session', { create: false });
});
it('shares concurrent silent session requests', async () => {
  let resolve!: (value: any) => void;
  client.post.mockReturnValue(new Promise(done => { resolve = done; }));
  const first = siteAuthApi.session(); const second = siteAuthApi.session();
  expect(first).toBe(second); expect(client.post).toHaveBeenCalledTimes(1);
  resolve({ data: { token: 'token' } }); await first;
});
it('constructs a relative site return route without exposing tokens in URLs', () => {
  const url = new URL(siteLoginUrl('https://game.bobbycn.cc'));
  expect(url.origin).toBe('https://bobbycn.cc'); expect(url.pathname).toBe('/login/');
  const next = new URL(url.searchParams.get('next')!, url.origin);
  expect(next.pathname).toBe('/api/auth/identity/game-return'); expect(next.searchParams.get('origin')).toBe('https://game.bobbycn.cc');
  expect(url.href).not.toContain('token=');
});
