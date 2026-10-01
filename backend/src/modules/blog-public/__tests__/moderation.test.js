// 评论机器人审核（blog-moderation）：站主点名的"dddd 那类"必须在第一道就被拦掉
// 口径：只有 pass / block 两档（没有人审队列），所以每个用例都断言唯一结论。
const { BlogModerationService } = require('../../../../dist/src/modules/blog-public/blog-moderation.service');

const svc = new BlogModerationService();
const verdict = (body) => svc.review({ body }).verdict;

describe('博客评论 · 机器人审核', () => {
  test('站主点名的灌水形态一律 block：dddd / 顶顶顶 / 1111 / 6666 / 哈哈哈哈 / 啊啊啊啊', () => {
    for (const s of ['dddd', 'dddddddddddddddd', 'DDDD', '顶顶顶', '帮顶', '1111', '666666', '哈哈哈哈', '啊啊啊啊啊', '。。。', '，，，，']) {
      expect(`${s} → ${verdict(s)}`).toBe(`${s} → block`);
    }
  });

  test('夹在正常文字里的超长重复也拦（支持ddddddddd），普通的"好的"不受影响', () => {
    expect(verdict('支持ddddddddd')).toBe('block');
    expect(verdict('好的')).toBe('pass');
    expect(verdict('写得不错，学到了')).toBe('pass');
  });

  test('字符重复度太低的内容拦下，正常中文/英文通过', () => {
    expect(verdict('aabb aabb aabb aabb')).toBe('block');
    expect(verdict('我是一个路过的读者，这篇文章讲得很清楚。')).toBe('pass');
    expect(verdict('Nice write-up, thanks for sharing the details.')).toBe('pass');
  });

  test('广告 / 灰产词命中即拒，正常讨论不误伤', () => {
    expect(verdict('加微信 12345 领取福利')).toBe('block');
    expect(verdict('低价代刷游戏币，私信进群')).toBe('block');
    // 「赌博」故意**不在**违禁词里：正常讨论游戏机制会用到它，误杀代价比漏放高（站长也不人工复核）
    expect(verdict('这个游戏的赌博机制你怎么看？')).toBe('pass');
    expect(verdict('这个游戏的随机性设计挺有意思')).toBe('pass');
  });

  test('只有符号/表情不算评论；1~2 个链接放行（渲染成纯文本），3 个以上按垃圾处理', () => {
    expect(verdict('😀😀😀😀😀')).toBe('block');
    expect(verdict('@@@@####')).toBe('block');
    expect(verdict('参考 https://bobbycn.cc/posts/ 这篇')).toBe('pass');
    expect(verdict('a https://a.com b https://b.com c')).toBe('pass');
    expect(verdict('https://a.com https://b.com https://c.com')).toBe('block');
  });

  test('全大写英文长串按垃圾广告拦，正常大小写混排通过', () => {
    expect(verdict('BUY NOW CHEAP PRICES FOR EVERYONE TODAY')).toBe('block');
    expect(verdict('Buy now, prices are cheap for everyone.')).toBe('pass');
  });

  test('边界：单字符 / 空内容拦掉，两个汉字的正常短评放行', () => {
    expect(verdict('d')).toBe('block');
    expect(verdict('')).toBe('block');
    expect(verdict('   ')).toBe('block');
    expect(verdict('赞')).toBe('block');       // 单字：当作灌水（站主口径是"别有意义的重复"）
    expect(verdict('厉害')).toBe('pass');
  });

  test('拒收理由是可读的（进 400 文案与日志），不是错误码', () => {
    const r = svc.review({ body: 'dddddd' });
    expect(r.verdict).toBe('block');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons[0]).toMatch(/灌水|重复/);
  });
});
