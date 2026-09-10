// 回归用例：MarketIndexBar 的轮询 effect 必须拿到最新的 marketMode（原缺陷 = 依赖数组缺 marketMode，
// 切市场后 load 闭包仍读旧 marketMode，永远显示切换前的市场状态）
import { render, screen, act } from '@testing-library/react';
import { MarketIndexBar } from './MarketIndexBar';
import { useUIStore } from '../../store';

// jest.mock 工厂被提升到文件顶部，引用外部变量必须以 mock 开头；
// 只替换 marketApi 的两个方法，其余（store 依赖的 setUnauthorizedHandler / api）保留真实实现
const mockState = jest.fn();
const mockIndices = jest.fn();

jest.mock('../../services/api.client', () => ({
  ...jest.requireActual('../../services/api.client'),
  marketApi: {
    indices: (...args: any[]) => mockIndices(...args),
    state: (...args: any[]) => mockState(...args),
  },
}));

describe('MarketIndexBar 市场切换依赖修复', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockIndices.mockResolvedValue([{ code: 'IDX', name: '测试指数', value: 100, changePct: 1, market: 'CN' }]);
    mockState.mockImplementation(async () => ({
      markets: {
        CN: { hotTopics: [], marketRegime: 'sideways', gameDay: 1 },
        US: { hotTopics: [], marketRegime: 'bull', gameDay: 2 },
      },
    }));
    useUIStore.setState({ marketMode: 'CN' });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    mockIndices.mockReset();
    mockState.mockReset();
  });

  it('卸载后停止轮询（effect 清理不留悬挂定时器）', async () => {
    const { unmount } = render(<MarketIndexBar />);
    await act(async () => { await Promise.resolve(); });
    const callsAfterMount = mockIndices.mock.calls.length;
    unmount();
    await act(async () => { jest.advanceTimersByTime(20000); });
    expect(mockIndices.mock.calls.length).toBe(callsAfterMount);
  });

  it('初始按 CN 取状态；切到 US 后轮询请求读到最新 marketMode 并渲染新市场状态', async () => {
    render(<MarketIndexBar />);
    // 等待首轮 load 的 promise 落地（load 是同步发起的，无需推进定时器）
    await act(async () => { await Promise.resolve(); });

    expect(mockState).toHaveBeenCalled();
    expect(screen.getByText(/市场状态：震荡整理/)).toBeInTheDocument();

    // 切换市场（等价于用户点 CN/HK/US 切换）
    act(() => { useUIStore.setState({ marketMode: 'US' }); });
    await act(async () => { await Promise.resolve(); });

    // 关键断言：effect 重跑后闭包里读到的是新 marketMode（US 分支），而不是挂载时捕获的 CN
    expect(screen.getByText(/市场状态：牛市行情/)).toBeInTheDocument();
    expect(screen.getByText(/第 3 个交易日/)).toBeInTheDocument();
    expect(screen.queryByText(/市场状态：震荡整理/)).not.toBeInTheDocument();
  });
});
