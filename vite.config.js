import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
	base: '/',
	define: {
		'import.meta.env.VERSION': JSON.stringify(pkg.version),
	},
	server: {
		watch: {
			ignored: ['**/*.tmp', '**/.dev/**', '**/.git/**', '**/.github/**', '**/node_modules/**', '**/dist/**'],
		},
	},
	plugins: [
		VitePWA({
			registerType: 'autoUpdate',
			workbox: {
				clientsClaim: true,
				skipWaiting: true,
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB limit
				globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,woff,ttf}'],
				runtimeCaching: [
					{
						urlPattern: /^https:\/\/.*\.woff2?$/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'font-cache',
							expiration: {
								maxEntries: 10,
								maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
							},
						},
					},
				],
			},
			includeAssets: [
				'logo.png',
				'wordmark.png',
				'wordmark-bw.png',
				'drag-handle.svg',
				'wordmark-font.svg',
				'wordmark.svg',
				'icon-192.png',
				'icon-512.png',
				'icon-maskable-512.png',
				'apple-touch-icon.png',
			],
			manifest: {
				name: 'markon',
				short_name: 'markon',
				description: 'Minimal distraction-free live Markdown editor',
				theme_color: '#100010',
				background_color: '#e2e2ee88',
				display: 'standalone',
				orientation: 'portrait-primary',
				scope: '/',
				start_url: '/',
				icons: [
					{
						src: 'icon-192.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'any',
					},
					{
						src: 'icon-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any',
					},
					{
						src: 'icon-maskable-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable',
					},
				],
			},
			devOptions: {
				enabled: false,
			},
		}),
	],
})
