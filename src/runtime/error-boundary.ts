import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryFallbackProps {
	error: Error
	/** Clears the error and renders the children again. */
	reset: () => void
}

export interface ErrorBoundaryProps {
	children?: ReactNode
	fallback: (props: ErrorBoundaryFallbackProps) => ReactNode
	/**
	 * Report the error here. Render errors never reach global handlers or
	 * error-tracking autocapture, so capture them explicitly.
	 */
	onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
	error: Error | null
}

const toError = (value: unknown) =>
	value instanceof Error ? value : new Error(String(value))

/** Error boundary without UI: `fallback` renders the error screen. */
export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = { error: null }

	static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
		return { error: toError(error) }
	}

	override componentDidCatch(error: unknown, info: ErrorInfo) {
		this.props.onError?.(toError(error), info)
	}

	reset = () => {
		this.setState({ error: null })
	}

	override render() {
		const { error } = this.state
		return error
			? this.props.fallback({ error, reset: this.reset })
			: this.props.children
	}
}
