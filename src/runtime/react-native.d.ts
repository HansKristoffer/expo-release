// The one react-native API the runtime uses. react-native is an optional peer
// that every Expo app has; this keeps it out of the devDependencies.
declare module 'react-native' {
	export const AppState: {
		addEventListener(
			type: 'change',
			listener: (state: 'active' | 'background' | 'inactive' | string) => void
		): { remove(): void }
	}
}
