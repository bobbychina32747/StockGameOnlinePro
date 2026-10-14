export type SiteLocale = 'zh-CN' | 'zh-TW' | 'en';

export function normalizeLocale(value: unknown): SiteLocale | null {
    const code = String(value || '').toLowerCase().replace(/_/g, '-');
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(code)) return 'zh-TW';
    if (/^zh(-|$)/.test(code)) return 'zh-CN';
    if (/^en(-|$)/.test(code)) return 'en';
    return null;
}

export function requestLocale(req: any): SiteLocale {
    const explicit = normalizeLocale(req?.query?.lang || req?.body?.lang);
    if (explicit) return explicit;
    const preferred = String(req?.headers?.['accept-language'] || '').split(',').map((part, order) => {
        const [code, ...params] = part.trim().split(';');
        const weight = params.find(p => p.trim().startsWith('q='));
        const q = weight ? Number(weight.trim().slice(2)) : 1;
        return { code, order, q };
    }).filter(p => Number.isFinite(p.q) && p.q > 0 && p.q <= 1).sort((a, b) => b.q - a.q || a.order - b.order);
    for (const p of preferred) { const locale = normalizeLocale(p.code); if (locale) return locale; }
    return 'zh-CN';
}

const COPY = {
    'zh-CN': {
        verifySubject: '【bobbycn.cc】验证你的邮箱', resetSubject: '【bobbycn.cc】重置密码',
        welcome: '欢迎注册 bobbycn.cc。', account: '一个账号走全站：博客、游戏厅、模拟炒股，以及以后的项目。',
        verify: '请点击下面的链接完成邮箱验证（30 分钟内有效，仅可使用一次）：',
        ignoreVerify: '如果这不是你本人的操作，忽略本邮件即可；这封邮件由系统自动发出，不用回复。',
        reset: '我们收到了重置 bobbycn.cc 账号密码的请求。',
        resetLink: '请点击下面的链接设置新密码（30 分钟内有效，仅可使用一次）：',
        ignoreReset: '重置后该账号的其它登录状态会全部失效。如果这不是你本人的操作，请忽略本邮件。',
        authorize: '授权', unified: 'bobbycn.cc 统一授权', wants: '想访问你的账号', signedIn: '当前登录：', siteAccount: '站点账号',
        firstParty: '站内应用', thirdParty: '第三方应用', deny: '拒绝', allow: '允许', accountPage: '账号页',
        revokeBefore: '授权后你可以随时在 ', revokeAfter: ' 解除。访问令牌有效期为 10 分钟，长期登录使用可撤销的刷新令牌。',
        openid: '你的站点身份标识（sub）', profile: '用户名与昵称', email: '邮箱地址与验证状态', saves: '读取与写入此应用的云存档', arcade: '游戏厅统一登录',
        errorTitle: '授权失败', errorHeading: '授权请求无法受理', errorAdvice: '请回到应用重新发起授权；如果反复出现，请联系站主。',
    },
    'zh-TW': {
        verifySubject: '【bobbycn.cc】驗證你的電子郵件', resetSubject: '【bobbycn.cc】重設密碼',
        welcome: '歡迎註冊 bobbycn.cc。', account: '一個帳號走全站：部落格、遊戲廳、模擬交易，以及未來的專案。',
        verify: '請點擊以下連結完成電子郵件驗證（30 分鐘內有效，僅可使用一次）：',
        ignoreVerify: '若這不是你的操作，請忽略此郵件。此郵件由系統自動寄出，不必回覆。',
        reset: '我們收到了重設 bobbycn.cc 帳號密碼的請求。',
        resetLink: '請點擊以下連結設定新密碼（30 分鐘內有效，僅可使用一次）：',
        ignoreReset: '重設後，此帳號在其他地方的登入將全部失效。若這不是你的操作，請忽略此郵件。',
        authorize: '授權', unified: 'bobbycn.cc 統一授權', wants: '想存取你的帳號', signedIn: '目前登入：', siteAccount: '網站帳號',
        firstParty: '站內應用程式', thirdParty: '第三方應用程式', deny: '拒絕', allow: '允許', accountPage: '帳號頁',
        revokeBefore: '授權後，你可以隨時在 ', revokeAfter: ' 撤銷。存取權杖有效期為 10 分鐘，持續登入使用可撤銷的更新權杖。',
        openid: '你的網站身分識別碼（sub）', profile: '使用者名稱與暱稱', email: '電子郵件地址與驗證狀態', saves: '讀取與寫入此應用程式的雲端存檔', arcade: '遊戲廳統一登入',
        errorTitle: '授權失敗', errorHeading: '無法受理授權請求', errorAdvice: '請回到應用程式重新授權；若持續發生，請聯絡站主。',
    },
    en: {
        verifySubject: '[bobbycn.cc] Verify your email', resetSubject: '[bobbycn.cc] Reset your password',
        welcome: 'Welcome to bobbycn.cc.', account: 'One account for the blog, games, stock simulator and future projects.',
        verify: 'Use the link below to verify your email. It expires in 30 minutes and works once:',
        ignoreVerify: 'If you did not request this, ignore this email. This is an automated message; you do not need to reply.',
        reset: 'We received a request to reset your bobbycn.cc account password.',
        resetLink: 'Use the link below to set a new password. It expires in 30 minutes and works once:',
        ignoreReset: 'Resetting the password signs this account out everywhere else. If you did not request this, ignore this email.',
        authorize: 'Authorize', unified: 'bobbycn.cc authorization', wants: 'wants to access your account', signedIn: 'Signed in as: ', siteAccount: 'Site account',
        firstParty: 'Site application', thirdParty: 'Third-party application', deny: 'Deny', allow: 'Allow', accountPage: 'account page',
        revokeBefore: 'You can revoke access at any time from your ', revokeAfter: '. Access tokens expire in 10 minutes. Continued sign-in uses refresh tokens that you can revoke.',
        openid: 'Your site identity identifier (sub)', profile: 'Your username and display name', email: 'Your email address and verification status', saves: 'Read and write this application’s cloud saves', arcade: 'Sign in to the game arcade',
        errorTitle: 'Authorization failed', errorHeading: 'Could not process authorization', errorAdvice: 'Return to the application and start authorization again. If this persists, contact the site owner.',
    },
};

export function localeCopy(locale: unknown) { return COPY[normalizeLocale(locale) || 'zh-CN']; }

export function systemEmail(kind: 'verify' | 'reset', locale: unknown, baseUrl: string, token: string) {
    const language = normalizeLocale(locale) || 'zh-CN';
    const copy = COPY[language];
    const url = new URL(kind === 'verify' ? '/verify-email' : '/reset-password', baseUrl);
    url.searchParams.set('token', token); url.searchParams.set('lang', language);
    const link = url.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const content = kind === 'verify' ? [copy.welcome, copy.account, copy.verify] : [copy.reset, copy.resetLink];
    return {
        subject: kind === 'verify' ? copy.verifySubject : copy.resetSubject,
        html: `<html lang="${language}"><body>${content.map(p => `<p>${p}</p>`).join('')}<p><a href="${link}">${link}</a></p><p style="color:#8a8a8a;font-size:12px">${kind === 'verify' ? copy.ignoreVerify : copy.ignoreReset}</p></body></html>`,
    };
}
