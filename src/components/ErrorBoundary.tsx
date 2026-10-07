import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result } from 'antd';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Quote desk render error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <Result status="error" title="页面遇到问题" subTitle={this.state.error.message || '请刷新页面重试'} extra={<Button type="primary" onClick={() => this.setState({ error: null })}>重新加载页面</Button>} />;
  }
}
