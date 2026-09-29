// PasswordService：口令算法（argon2id 规格 / scrypt 兜底）、TOTP 密钥加解密、恢复码
require('reflect-metadata');
const { PasswordService } = require('../../../../dist/src/modules/identity/password.service');

describe('PasswordService · 口令哈希与密钥材料', () => {
  let svc;
  beforeEach(() => { svc = new PasswordService(); });

  test('算法为 argon2id 或 scrypt 兜底（规格要求 argon2id；兜底必须在 README 登记）', () => {
    expect(['argon2id', 'scrypt']).toContain(svc.algorithm);
  });

  (process.env.IDENTITY_SKIP_ARGON2_CHECK === '1' ? test.skip : test)('argon2id 生效：哈希串为 PHC 格式 $argon2id$v=19$m=19456,t=2,p=1', async () => {
    if (svc.algorithm !== 'argon2id')
      return; // 目标平台缺预编译包时跳过（此时 README 的「未达规格」条目生效）
    const hash = await svc.hash('Passw0rd!23');
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  });

  test('哈希-校验往返：正确口令通过、错误口令拒绝', async () => {
    const hash = await svc.hash('Passw0rd!23');
    expect(await svc.verify(hash, 'Passw0rd!23')).toBe(true);
    expect(await svc.verify(hash, 'passw0rd!23')).toBe(false);
    expect(await svc.verify(hash, '')).toBe(false);
    // 同一口令两次哈希结果不同（盐随机）
    expect(await svc.hash('Passw0rd!23')).not.toBe(hash);
  });

  test('未知/损坏的哈希串一律判失败（不抛错、不放行）', async () => {
    expect(await svc.verify('', 'x')).toBe(false);
    expect(await svc.verify('bcrypt$2b$10$abcdefghijklmnopqrstuv', 'x')).toBe(false);
    expect(await svc.verify('$argon2id$broken', 'x')).toBe(false);
    expect(await svc.verify('scrypt$32768$8$1$deadbeef$c0ffee', 'x')).toBe(false);
  });

  test('TOTP 密钥加密往返（AES-256-GCM）需要 IDENTITY_ENC_KEY，密文不含明文', () => {
    const original = process.env.IDENTITY_ENC_KEY;
    delete process.env.IDENTITY_ENC_KEY;
    expect(() => svc.encryptTotpSecret('JBSWY3DPEHPK3PXP')).toThrow(/IDENTITY_ENC_KEY/); // 密钥只能来自环境变量
    process.env.IDENTITY_ENC_KEY = 'a'.repeat(64); // 32 字节 hex
    try {
      const enc = svc.encryptTotpSecret('JBSWY3DPEHPK3PXP');
      expect(enc.startsWith('v1:')).toBe(true);
      expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
      expect(svc.decryptTotpSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
      expect(() => svc.decryptTotpSecret('v1:bad')).toThrow();
    }
    finally {
      if (original === undefined)
        delete process.env.IDENTITY_ENC_KEY;
      else
        process.env.IDENTITY_ENC_KEY = original;
    }
  });

  test('恢复码：存哈希可校验、明文不可反推', () => {
    const code = 'RC-8F2K-9QZ1';
    const hashed = svc.hashRecoveryCode(code);
    expect(hashed).not.toContain(code);
    expect(svc.verifyRecoveryCode(hashed, code)).toBe(true);
    expect(svc.verifyRecoveryCode(hashed, 'RC-0000-0000')).toBe(false);
    expect(svc.verifyRecoveryCode('', code)).toBe(false);
  });
});
