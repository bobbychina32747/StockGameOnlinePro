import { useEffect, useState } from 'react';
import { siteAuthApi } from '../services/site-auth';
import { useAuthStore } from '../store';

export function useSiteSession() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    let pending = false;
    const sync = async () => {
      if (pending) return;
      pending = true;
      const tokenBefore = useAuthStore.getState().token;
      try {
        const session = await siteAuthApi.session();
        if (!active || useAuthStore.getState().token !== tokenBefore) return;
        if ('token' in session) useAuthStore.getState().setAuth(session.token, session.user);
        else useAuthStore.getState().logout();
      } catch (error: any) {
        if (active && useAuthStore.getState().token === tokenBefore && error.response?.status === 401) {
          useAuthStore.getState().logout();
        }
      } finally {
        pending = false;
        if (active) setReady(true);
      }
    };
    void sync();
    const timer = window.setInterval(sync, 4 * 60 * 1000);
    const onFocus = () => { void sync(); };
    window.addEventListener('focus', onFocus);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, []);
  return ready;
}
