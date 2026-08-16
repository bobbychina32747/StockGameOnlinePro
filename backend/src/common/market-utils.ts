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
