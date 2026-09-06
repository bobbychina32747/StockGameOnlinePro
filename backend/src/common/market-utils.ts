// 市场分类工具：消除 A股/港股/美股 判定逻辑的复制粘贴。
// 股票代码约定：H 前缀=港股，U 前缀=美股，其余=A股（与三服务器架构一致）。
export function symbolMarket(symbol) {
    const s = String(symbol || '');
    if (/^H/.test(s))
        return 'HK';
    if (/^U/.test(s))
        return 'US';
    return 'CN';
}

export function isCnSymbol(symbol) {
    return symbolMarket(symbol) === 'CN';
}

// Phase B: A股涨跌停区间统一函数（生成端钳制/委托价校验/盘口封板/竞价共用，消除多处魔数漂移）
// base=昨收（真实涨停价=昨收×1.1 全天固定）；新股首日按发行价口径 +44%/-36%
export function cnPriceLimits(base, firstDay) {
    const b = Number(base);
    if (!Number.isFinite(b) || b <= 0)
        return null;
    return firstDay ? { up: b * 1.44, down: b * 0.64 } : { up: b * 1.1, down: b * 0.9 };
}
