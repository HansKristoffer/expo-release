import { describe, expect, mock, test } from 'bun:test'
import {
	ErrorBoundary,
	type ErrorBoundaryFallbackProps
} from './error-boundary'

describe('ErrorBoundary', () => {
	test('renders children until an error, then the fallback', () => {
		const fallback = mock(
			({ error }: ErrorBoundaryFallbackProps) => error.message
		)
		const boundary = new ErrorBoundary({ children: 'content', fallback })
		expect(boundary.render()).toBe('content')

		boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('boom'))
		expect(boundary.render()).toBe('boom')
		expect(fallback.mock.lastCall?.[0].reset).toBe(boundary.reset)
	})

	test('wraps thrown non-errors', () => {
		expect(ErrorBoundary.getDerivedStateFromError('nope').error?.message).toBe(
			'nope'
		)
	})

	test('reports the error with its component stack', () => {
		const onError = mock()
		const boundary = new ErrorBoundary({ fallback: () => null, onError })
		const error = new Error('boom')
		boundary.componentDidCatch(error, { componentStack: '\n  at Screen' })
		expect(onError).toHaveBeenCalledWith(error, {
			componentStack: '\n  at Screen'
		})
	})

	test('reset clears the error', () => {
		const boundary = new ErrorBoundary({ fallback: () => null })
		const setState = mock()
		boundary.setState = setState
		boundary.reset()
		expect(setState).toHaveBeenCalledWith({ error: null })
	})
})
