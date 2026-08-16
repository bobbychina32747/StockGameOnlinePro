/**
 * Jest + babel-jest（进程内转译，不依赖 esbuild 子进程）：
 * - ts/tsx 用 babel 转译（@babel/preset-typescript / preset-react automatic runtime）
 * - jsdom 环境跑 @testing-library/react
 * - CSS 导入用 identity-obj-proxy 打桩
 */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['babel-jest', { configFile: require.resolve('./babel.config.cjs') }],
    '^.+\\.(js|jsx)$': ['babel-jest', { configFile: require.resolve('./babel.config.cjs') }],
  },
  transformIgnorePatterns: ['node_modules/(?!(echarts|zrender)/)'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  collectCoverageFrom: ['src/utils/**/*.ts', 'src/store/**/*.ts'],
};
