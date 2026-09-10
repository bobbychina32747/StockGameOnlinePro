// Phase F 前端验收：AI 对手盘在线自适应档位标签（团队 C1/R11：一句话可解释、不暴露裸参数）
import { adaptiveLabel } from './AIAssistant';

describe('Phase F AI 自适应档位标签', () => {
  it('三档映射为可解释中文（激进/收缩/稳健）', () => {
    expect(adaptiveLabel({ level: 'aggressive' })).toBe('⚡ 激进');
    expect(adaptiveLabel({ level: 'cautious' })).toBe('🛡 收缩');
    expect(adaptiveLabel({ level: 'normal' })).toBe('➖ 稳健');
  });

  it('开关关闭或缺字段不渲染标签（旧后端零影响）', () => {
    expect(adaptiveLabel({ level: 'aggressive', enabled: false })).toBeNull();
    expect(adaptiveLabel(undefined)).toBeNull();
    expect(adaptiveLabel(null)).toBeNull();
    expect(adaptiveLabel({})).toBe('➖ 稳健'); // 未知档位兜底为常态
  });
});
