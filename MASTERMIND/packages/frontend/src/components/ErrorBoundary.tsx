import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clientLogger } from '../lib/clientLogger';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    clientLogger.error('react', 'render error boundary caught', {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-8 space-y-4">
          <p className="text-destructive font-semibold text-lg">Erreur de rendu</p>
          <pre className="text-destructive text-xs font-mono bg-background rounded-lg p-4 overflow-auto max-h-64 whitespace-pre-wrap">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-4 py-2 text-sm bg-primary text-foreground rounded-lg hover:bg-primary/90"
          >
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
