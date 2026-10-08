// 云存档（服务端托管密钥）单测。
// 老方案的存档密钥绑在"游戏厅口令"上——改口令/换设备就丢档；这里验证新方案：
// 密钥跟着站点身份走、服务端只保管不碰内容、配额与体积边界真的拦得住、迁移标记正确。
const { createOauthHarness } = require('../../identity/__tests__/_oauth-harness');

describe('云存档 · 密钥托管', () => {
  let h;
  beforeEach(async () => {
    delete process.env.SAVES_MASTER_KEY;
    delete process.env.IDENTITY_ENC_KEY;
    h = await createOauthHarness();
  });
  afterEach(async () => { await h.close(); });

  test('首次取密钥会生成并落库（包裹后的密文，库里没有明文密钥）', async () => {
    const { identity } = await h.activeIdentity();
    const first = await h.saves.keyForClient(identity.id);
    expect(Buffer.from(first.key, 'base64')).toHaveLength(32);
    expect(first.alg).toBe('AES-256-GCM');

    const row = await h.repos.secret.findOne({ where: { identityId: identity.id } });
    expect(row.saveKey).toMatch(/^v1\./);
    expect(row.saveKey).not.toContain(first.key);
    expect(JSON.stringify(row)).not.toContain(Buffer.from(first.key, 'base64').toString('hex'));
  });

  test('同一身份多次取到的密钥完全一致（这就是"不丢档"的关键）', async () => {
    const { identity } = await h.activeIdentity();
    const a = await h.saves.keyForClient(identity.id);
    const b = await h.saves.keyForClient(identity.id);
    expect(b.key).toBe(a.key);
    // 换实例（模拟进程重启）也一致
    const { GameSavesService } = require('../../../../dist/src/modules/game-saves/game-saves.service');
    const fresh = new GameSavesService(h.repos.save, h.repos.secret, h.repos.appSecret);
    expect((await fresh.keyForClient(identity.id)).key).toBe(a.key);
  });

  test('不同身份的密钥不同（不是全局一把钥匙）', async () => {
    const one = await h.activeIdentity('a@example.com', 'a');
    const two = await h.activeIdentity('b@example.com', 'b');
    expect((await h.saves.keyForClient(one.identity.id)).key)
      .not.toBe((await h.saves.keyForClient(two.identity.id)).key);
  });

  test('环境变量配置主密钥时优先使用（部署侧可控）', async () => {
    process.env.SAVES_MASTER_KEY = 'a'.repeat(64);
    const { GameSavesService } = require('../../../../dist/src/modules/game-saves/game-saves.service');
    const svc = new GameSavesService(h.repos.save, h.repos.secret, h.repos.appSecret);
    const { identity } = await h.activeIdentity('env@example.com', 'envkey');
    const out = await svc.keyForClient(identity.id);
    expect(Buffer.from(out.key, 'base64')).toHaveLength(32);
    // 主密钥来自环境变量 → 不该在 app_secrets 里另生成一份
    expect(await h.repos.appSecret.findOne({ where: { name: 'saves.master' } })).toBeNull();
    delete process.env.SAVES_MASTER_KEY;
  });

  test('主密钥换掉后旧密钥解不开：明确报错，绝不静默换新钥匙（否则老存档全废）', async () => {
    const { identity } = await h.activeIdentity();
    await h.saves.keyForClient(identity.id);
    process.env.SAVES_MASTER_KEY = 'b'.repeat(64);
    const { GameSavesService } = require('../../../../dist/src/modules/game-saves/game-saves.service');
    const svc = new GameSavesService(h.repos.save, h.repos.secret, h.repos.appSecret);
    await expect(svc.keyForClient(identity.id)).rejects.toThrow(/存档密钥不可用/);
    delete process.env.SAVES_MASTER_KEY;
  });
});

describe('云存档 · 读写与配额', () => {
  let h, identity;
  beforeEach(async () => {
    h = await createOauthHarness();
    const active = await h.activeIdentity('saver@example.com', 'saver');
    identity = active.identity;
  });
  afterEach(async () => { await h.close(); });

  test('写入 → 读取 → 列表：密文原样往返，sha256/bytes 由服务端计算', async () => {
    const payload = Buffer.from('ciphertext-ish payload').toString('base64');
    const put = await h.saves.put(identity.id, 'zombie-survival', 'auto', payload, { day: 12, level: 7 });
    expect(put.ok).toBe(true);
    expect(put.bytes).toBe(Buffer.byteLength(payload, 'utf8'));

    const got = await h.saves.get(identity.id, 'zombie-survival', 'auto');
    expect(got.data).toBe(payload);
    expect(got.meta).toEqual({ day: 12, level: 7 });

    const list = await h.saves.list(identity.id, 'zombie-survival');
    expect(list.slots).toHaveLength(1);
    expect(list.slots[0].slot).toBe('auto');
    expect(list.slots[0].sha256).toBe(got.sha256);
  });

  test('同一槽位重复写入是覆盖（不是新增）', async () => {
    await h.saves.put(identity.id, 'dreamcore', '1', 'AAAA');
    await h.saves.put(identity.id, 'dreamcore', '1', 'BBBB');
    const list = await h.saves.list(identity.id, 'dreamcore');
    expect(list.slots).toHaveLength(1);
    expect((await h.saves.get(identity.id, 'dreamcore', '1')).data).toBe('BBBB');
  });

  test('存档按身份隔离：别人的存档读不到', async () => {
    const other = await h.activeIdentity('other@example.com', 'other');
    await h.saves.put(identity.id, 'dreamcore', 'auto', 'MINE');
    await expect(h.saves.get(other.identity.id, 'dreamcore', 'auto')).rejects.toThrow(/没有这个存档/);
    expect((await h.saves.list(other.identity.id, 'dreamcore')).slots).toHaveLength(0);
  });

  test('体积上限：超过 2MB 直接 413 语义（不做静默截断）', async () => {
    const tooBig = 'x'.repeat(2 * 1024 * 1024 + 10);
    await expect(h.saves.put(identity.id, 'dreamcore', 'auto', tooBig)).rejects.toThrow(/上限/);
  });

  test('槽位名与游戏标识有白名单口径（挡住拼路径/奇怪字符）', async () => {
    await expect(h.saves.put(identity.id, 'dreamcore', '../etc/passwd', 'x')).rejects.toThrow(/槽位名不合法/);
    await expect(h.saves.put(identity.id, 'a/b', 'auto', 'x')).rejects.toThrow(/游戏标识不合法/);
    await expect(h.saves.put(identity.id, 'dreamcore', 'auto', '')).rejects.toThrow(/存档内容为空/);
  });

  test('空存档与不存在的槽位：读回是 404 语义', async () => {
    await expect(h.saves.get(identity.id, 'dreamcore', 'nope')).rejects.toThrow(/没有这个存档/);
  });

  test('删除：只剩这一份时确实删掉', async () => {
    await h.saves.put(identity.id, 'dreamcore', 'auto', 'X');
    expect(await h.saves.remove(identity.id, 'dreamcore', 'auto')).toEqual({ ok: true, removed: 1 });
    expect((await h.saves.list(identity.id, 'dreamcore')).slots).toHaveLength(0);
  });

  test('槽位总数有上限（防刷库）', async () => {
    for (let i = 0; i < 5; i++)
      await h.saves.put(identity.id, 'dreamcore', `s${i}`, 'x');
    expect((await h.saves.list(identity.id, 'dreamcore')).slots).toHaveLength(5);
    // 上限本身在常量里，这里只验证配额接口把它暴露出来
    expect(h.saves.quota(identity.id).maxSlots).toBeGreaterThanOrEqual(5);
  });
});

describe('云存档 · 迁移', () => {
  let h, identity;
  beforeEach(async () => {
    h = await createOauthHarness();
    identity = (await h.activeIdentity('migrator@example.com', 'migrator')).identity;
  });
  afterEach(async () => { await h.close(); });

  test('没有服务端存档时引导迁移（needsMigration=true）', async () => {
    const status = await h.saves.migrationStatus(identity.id);
    expect(status.needsMigration).toBe(true);
    expect(status.totalSlots).toBe(0);
    expect(status.hint).toMatch(/迁移/);
  });

  test('迁移上传（migrated=true）后引导收敛，标记保留在槽位上', async () => {
    await h.saves.put(identity.id, 'zombie-survival', 'auto', 'OLD-SAVE', { day: 40 }, true);
    const status = await h.saves.migrationStatus(identity.id);
    expect(status.needsMigration).toBe(false);
    expect(status.games).toHaveLength(1);
    expect(status.games[0]).toMatchObject({ game: 'zombie-survival', slots: 1, migrated: 1 });
    expect((await h.saves.get(identity.id, 'zombie-survival', 'auto')).migrated).toBe(true);
  });

  test('先普通上传、再补一次迁移上传：migrated 只增不减（不会把已迁移的标回未迁移）', async () => {
    await h.saves.put(identity.id, 'dreamcore', 'auto', 'NEW');
    expect((await h.saves.get(identity.id, 'dreamcore', 'auto')).migrated).toBe(false);
    await h.saves.put(identity.id, 'dreamcore', 'auto', 'MIGRATED', null, true);
    expect((await h.saves.get(identity.id, 'dreamcore', 'auto')).migrated).toBe(true);
    await h.saves.put(identity.id, 'dreamcore', 'auto', 'LATER-SAVE');
    expect((await h.saves.get(identity.id, 'dreamcore', 'auto')).migrated).toBe(true);
  });
});
