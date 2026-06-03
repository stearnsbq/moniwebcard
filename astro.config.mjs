// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm'

// https://astro.build/config
export default defineConfig({
   site: 'https://stearnsbq.github.io',
      vite: {
    plugins: [tailwindcss(), wasm()],
    optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] }
  },
});