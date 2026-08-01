// 前端：MarketIndexBar 加热点条
const fs = require('fs');
const p = 'src/components/Trading/MarketIndexBar.tsx';
let s = fs.readFileSync(p, 'utf8');

// 1. state
s = s.replace(
  '  const [indices, setIndices] = useState<any[]>([]);',
  '  const [indices, setIndices] = useState<any[]>([]);\n  const [hotTopics, setHotTopics] = useState<any[]>([]);'
);

// 2. load 拉 state
s = s.replace(
  "    const load = () => {\n      marketApi.indices().then((list) => {\n        if (alive && Array.isArray(list)) setIndices(list);\n      }).catch(() => {});\n    };",
  "    const load = () => {\n      marketApi.indices().then((list) => {\n        if (alive && Array.isArray(list)) setIndices(list);\n      }).catch(() => {});\n      marketApi.state().then((st) => {\n        if (alive && Array.isArray(st?.hotTopics)) setHotTopics(st.hotTopics);\n      }).catch(() => {});\n    };"
);

// 3. 热点条
s = s.replace(
  '      <span className="index-regime">\n        市场状态：{REGIME_LABEL[marketRegime] || marketRegime}\n      </span>',
  '      {hotTopics.length > 0 && (\n        <span className="index-hot">\n          🔥 热点：{hotTopics.map((h) => (\n            <b key={h.industry}>{h.industry} <em style={{ color: \'var(--color-up)\' }}>+{(h.strength * 100).toFixed(1)}%</em></b>\n          ))}\n        </span>\n      )}\n      <span className="index-regime">\n        市场状态：{REGIME_LABEL[marketRegime] || marketRegime}\n      </span>'
);

fs.writeFileSync(p, s);
console.log('热点条完成');
