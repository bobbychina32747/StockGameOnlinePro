// 排行榜算法盘机器人标识：机器人（isBot === true）用户名前加 🤖；真人渲染保持不变；isBot 缺字段时安全降级
import { render, screen, fireEvent, within } from '@testing-library/react';
import Ranking from './Ranking';

// jest.mock 工厂被提升，引用外部变量必须以 mock 开头
const mockRankingGet = jest.fn();
const mockSeasonCurrent = jest.fn();
const mockSeasonLeaderboard = jest.fn();

// 只替换数据源，其余（store 依赖的 api / setUnauthorizedHandler）保留真实实现 → 不发真实网络请求
jest.mock('../../services/api.client', () => ({
    ...jest.requireActual('../../services/api.client'),
    rankingApi: {
        get: (...args: any[]) => mockRankingGet(...args),
    },
    seasonApi: {
        current: (...args: any[]) => mockSeasonCurrent(...args),
        leaderboard: (...args: any[]) => mockSeasonLeaderboard(...args),
    },
}));

const BOT_ROW = {
    userId: 'bot-alpha',
    username: 'Alpha', // 后端对机器人下发未脱敏展示名
    totalEquity: 1234567.89,
    totalReturn: 0.321,
    dayReturn: 0.012,
    rank: 2,
    isBot: true,
};

const HUMAN_ROW = {
    userId: 'u-1001',
    username: 'ab*****', // 真人为脱敏名
    totalEquity: 100000,
    totalReturn: 0.1,
    dayReturn: 0.005,
    rank: 1,
};

// 排行榜默认停在「赛季榜」，需切到「全服榜」才渲染全服表；findBy 会等到 loading 结束
async function renderAllBoard(rows: any[]) {
    mockRankingGet.mockResolvedValue(rows);
    render(<Ranking />);
    const tab = await screen.findByRole('button', { name: /全服榜/ });
    fireEvent.click(tab);
    return screen.getByTestId(`ranking-user-${rows[0].userId}`).closest('table') as HTMLElement;
}

describe('Ranking 算法盘机器人标识', () => {
    beforeEach(() => {
        mockRankingGet.mockReset();
        mockSeasonCurrent.mockReset().mockResolvedValue(null);
        mockSeasonLeaderboard.mockReset().mockResolvedValue([]);
    });

    it('机器人条目渲染 🤖 标识，且显示名未被打码', async () => {
        await renderAllBoard([HUMAN_ROW, BOT_ROW]);

        const cell = screen.getByTestId('ranking-user-bot-alpha');
        const text = cell.textContent || '';
        expect(text).toContain('Alpha');
        expect(text).toContain('🤖');
        // 标识必须在用户名之前
        expect(text.indexOf('🤖')).toBeLessThan(text.indexOf('Alpha'));
        // 未脱敏：机器人展示名里不含打码星号
        expect(text).not.toContain('*');
        // 标识带 tooltip 说明
        expect(within(cell).getByTitle('算法盘（机器人玩家）')).toBeInTheDocument();
        // 表头图例
        expect(screen.getByText('🤖 = 算法盘')).toBeInTheDocument();
    });

    it('真人条目不渲染 🤖 标识（回归）', async () => {
        await renderAllBoard([HUMAN_ROW, BOT_ROW]);

        const cell = screen.getByTestId('ranking-user-u-1001');
        expect(cell.textContent).toContain('ab*****');
        expect(cell.textContent).not.toContain('🤖');
        expect(within(cell).queryByTitle('算法盘（机器人玩家）')).toBeNull();
    });

    it('isBot 字段缺失（旧后端/缓存）时不渲染标识也不抛错', async () => {
        // 故意不带 isBot 字段
        const legacyRow = {
            userId: 'u-legacy',
            username: 'cd*****',
            totalEquity: 50000,
            totalReturn: -0.02,
            rank: 3,
        };
        const table = await renderAllBoard([legacyRow, BOT_ROW]);

        expect(table).toBeTruthy();
        const legacyCell = screen.getByTestId('ranking-user-u-legacy');
        expect(legacyCell.textContent).toContain('cd*****');
        expect(legacyCell.textContent).not.toContain('🤖');
        // 缺字段的行不影响同一张表里机器人行的标识
        expect(screen.getByTestId('ranking-user-bot-alpha').textContent).toContain('🤖');
    });
});
