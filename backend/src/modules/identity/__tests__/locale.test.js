const { requestLocale, systemEmail } = require('../../../../dist/src/modules/identity/locale');
const { createHarness, tokenFromMail, TEST_PASSWORD } = require('./_harness');
const { OauthController } = require('../../../../dist/src/modules/identity/oauth.controller');

test('language negotiation handles traditional regions, quality weights and unsupported input', () => {
  expect(requestLocale({headers:{'accept-language':'fr, zh-HK;q=0.9, en;q=0.8'}})).toBe('zh-TW');
  expect(requestLocale({headers:{'accept-language':'zh-CN;q=0.1, en-US;q=0.9'}})).toBe('en');
  expect(requestLocale({headers:{'accept-language':'en;q=0, fr'}})).toBe('zh-CN');
  expect(requestLocale({query:{lang:'zh-Hant'},headers:{'accept-language':'en'}})).toBe('zh-TW');
  expect(requestLocale({query:{lang:'<script>alert(1)</script>'}})).toBe('zh-CN');
});

test.each(['zh-CN','zh-TW','en'])('system emails preserve token, locale, expiry and single-use guidance (%s)', locale => {
  for(const kind of ['verify','reset']) {
    const mail=systemEmail(kind,locale,'https://example.test','token-1234567890');
    expect(mail.html).toContain(`lang="${locale}"`);
    const link=mail.html.match(/href="([^"]+)"/)[1].replace(/&amp;/g,'&');
    const url=new URL(link);
    expect(url.origin).toBe('https://example.test');
    expect(url.searchParams.get('token')).toBe('token-1234567890');
    expect(url.searchParams.get('lang')).toBe(locale);
    expect(mail.html).toContain('30');
    if(locale==='en')expect(mail.html).not.toMatch(/[\u3400-\u9fff]/);
  }
});

test('consent languages preserve OAuth parameters and escape application and account names', () => {
  const controller=new OauthController({},{});
  const html=controller.consentPage({kind:'page',params:{clientId:'fixture',redirectUri:'https://app.example.test/callback',scope:'openid email saves',state:'fixture-state',codeChallenge:'fixture-challenge',codeChallengeMethod:'S256'},client:{name:'<App>',firstParty:true},scopes:['openid','email','saves']},'User <script>',{query:{lang:'en'},originalUrl:'/api/auth/identity/oauth/authorize?client_id=fixture&state=fixture-state&code_challenge=fixture-challenge'});
  expect(html).toContain('<html lang="en">');
  expect(html).toContain('&lt;App&gt;');expect(html).toContain('User &lt;script&gt;');
  expect(html).toContain('name="state" value="fixture-state"');
  const traditional=html.match(/<a href="([^"]+)" lang="zh-TW"/)[1].replace(/&amp;/g,'&');
  const url=new URL(traditional,'https://site.example.test');
  expect(url.searchParams.get('state')).toBe('fixture-state');
  expect(url.searchParams.get('code_challenge')).toBe('fixture-challenge');
  expect(url.searchParams.get('lang')).toBe('zh-TW');
  expect(html.replace(/简体|繁體/g,'')).not.toMatch(/[\u3400-\u9fff]/);
});

test('registration, resend and reset use the selected locale without changing account activation', async () => {
  const h=await createHarness();
  try {
    await h.service.register('locale@example.test',TEST_PASSWORD,'10.0.0.1','en');
    expect(h.sent[0].subject).toBe('[bobbycn.cc] Verify your email');
    await h.service.register('locale@example.test',TEST_PASSWORD,'10.0.0.2','zh-TW');
    expect(h.sent[1].subject).toContain('驗證');
    const active=await h.service.verify(tokenFromMail(h.sent[1]),'10.0.0.3');
    expect(active.identity.emailVerified).toBe(true);
    await h.service.requestPasswordReset('locale@example.test','10.0.0.4','en');
    expect(h.sent[2].subject).toBe('[bobbycn.cc] Reset your password');
    const before=h.sent.length;
    await h.service.requestPasswordReset('missing@example.test','10.0.0.5','en');
    expect(h.sent.length).toBe(before);
  } finally {await h.close();}
});
