import { render, screen, act } from '@testing-library/react';
import { PriceText } from './PriceText';
import { useUIStore } from '../../store';

describe('PriceText', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useUIStore.setState({ animEnabled: false });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('按精度渲染价格，支持前后缀', () => {
    render(<PriceText value={12.3} decimals={2} prefix="¥" suffix="元" />);
    expect(screen.getByText('¥12.30元')).toBeInTheDocument();
  });

  it('NaN/null 兜底显示 0', () => {
    const { rerender } = render(<PriceText value={Number.NaN} decimals={2} />);
    expect(screen.getByText('0.00')).toBeInTheDocument();
    rerender(<PriceText value={null as unknown as number} decimals={2} />);
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('动画关闭时价格立即跳变，并触发涨跌闪烁后自动消失', () => {
    const { rerender } = render(<PriceText value={10} decimals={2} />);
    expect(screen.getByText('10.00')).toBeInTheDocument();

    act(() => rerender(<PriceText value={11} decimals={2} />));
    expect(screen.getByText('11.00')).toBeInTheDocument();
    const el = screen.getByText('11.00');
    expect(el.className).toContain('flash-up');

    act(() => jest.advanceTimersByTime(650));
    expect(el.className).not.toContain('flash-');
  });

  it('价格下跌时闪烁 down', () => {
    const { rerender } = render(<PriceText value={10} decimals={2} />);
    act(() => rerender(<PriceText value={9} decimals={2} />));
    expect(screen.getByText('9.00').className).toContain('flash-down');
  });
});
