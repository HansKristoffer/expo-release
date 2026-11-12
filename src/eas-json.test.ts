import { describe, expect, test } from 'bun:test'
import { applyProfileEnv, resolveBuildProfile } from './eas-json'

const easJson = {
	build: {
		base: {
			node: '22.12.0',
			env: { APP_VARIANT: 'base', SECRETS_ENV: 'staging' },
			ios: { env: { APS_ENVIRONMENT: 'development' } }
		},
		production: {
			extends: 'base',
			channel: 'production',
			environment: 'production',
			env: { APP_VARIANT: 'production' },
			ios: { env: { APS_ENVIRONMENT: 'production' } }
		}
	}
}

describe('resolveBuildProfile', () => {
	test('follows extends and applies the platform block, as eas-cli does', () => {
		expect(resolveBuildProfile(easJson, 'production', 'ios')).toEqual({
			channel: 'production',
			environment: 'production',
			node: '22.12.0',
			bun: undefined,
			env: {
				APP_VARIANT: 'production',
				SECRETS_ENV: 'staging',
				APS_ENVIRONMENT: 'production'
			}
		})
		expect(resolveBuildProfile(easJson, 'production', 'android')?.env).toEqual({
			APP_VARIANT: 'production',
			SECRETS_ENV: 'staging'
		})
	})

	test('a missing profile is null; a missing parent or a cycle throws', () => {
		expect(resolveBuildProfile(easJson, 'nope', 'ios')).toBeNull()
		expect(() =>
			resolveBuildProfile({ build: { a: { extends: 'b' } } }, 'a', 'ios')
		).toThrow('extends missing "b"')
		expect(() =>
			resolveBuildProfile(
				{ build: { a: { extends: 'b' }, b: { extends: 'a' } } },
				'a',
				'ios'
			)
		).toThrow('cycle')
	})
})

describe('applyProfileEnv', () => {
	test('sets only variables that are not set yet', () => {
		const env: Record<string, string | undefined> = { APP_VARIANT: 'mine' }
		expect(
			applyProfileEnv(
				{ env: { APP_VARIANT: 'production', SECRETS_ENV: 'p' } },
				env
			)
		).toEqual(['SECRETS_ENV'])
		expect(env).toEqual({ APP_VARIANT: 'mine', SECRETS_ENV: 'p' })
	})
})
