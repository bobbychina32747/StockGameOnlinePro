import axios from 'axios';

export interface GameSession {
  token: string;
  expiresIn: number;
  user: { id: string; username: string; role: string };
}
export interface GameAccountSetup {
  needsAccountSetup: true;
  identity: { username: string };
}

// Site cookies are HttpOnly. Never send the game's cached Bearer token here.
const client = axios.create({ baseURL: '/api', timeout: 15000, withCredentials: true });
let pending: Promise<GameSession | GameAccountSetup> | null = null;
export const siteAuthApi = {
  session(create = false): Promise<GameSession | GameAccountSetup> {
    if (!create && pending) return pending;
    const request = client.post('/auth/site-session', { create }).then(response => response.data);
    if (!create) {
      pending = request;
      void request.finally(() => { if (pending === request) pending = null; }).catch(() => {});
    }
    return request;
  },
  link: (username: string, password: string): Promise<GameSession> =>
    client.post('/auth/site-link', { username, password }).then(response => response.data),
  logout: () => client.post('/auth/identity/logout', {}),
};

export function siteLoginUrl(origin = window.location.origin) {
  const next = '/api/auth/identity/game-return?origin=' + encodeURIComponent(origin);
  return 'https://bobbycn.cc/login/?next=' + encodeURIComponent(next);
}
