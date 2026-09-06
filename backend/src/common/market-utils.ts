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
    // toFixed(4) 消除 100×1.1=110.00000000000001 类浮点尾巴（委托价校验/封板判定的容差口径统一）
    return firstDay
        ? { up: Number((b * 1.44).toFixed(4)), down: Number((b * 0.64).toFixed(4)) }
        : { up: Number((b * 1.1).toFixed(4)), down: Number((b * 0.9).toFixed(4)) };
}
