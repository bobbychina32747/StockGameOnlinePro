import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
}

/** 错误边界：组件崩溃时显示错误信息而非黑屏，并提供恢复按钮 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    console.error('[ErrorBoundary]', error, info?.componentStack || '');
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 20,
            color: 'var(--color-up)',
            fontFamily: 'monospace',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            ⚠️ 界面渲染出错（{this.props.label || 'unknown'}）
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>{String(this.state.error?.message || this.state.error)}</div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: '1px solid var(--border-default)',
              background: 'var(--color-brand)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
