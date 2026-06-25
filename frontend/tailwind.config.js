/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand scales backed by CSS variables (defined in index.css) so every
        // bg-beige-*/text-warm-* utility flips automatically in dark mode.
        beige: {
          50: 'rgb(var(--beige-50) / <alpha-value>)',
          100: 'rgb(var(--beige-100) / <alpha-value>)',
          200: 'rgb(var(--beige-200) / <alpha-value>)',
          300: 'rgb(var(--beige-300) / <alpha-value>)',
          400: 'rgb(var(--beige-400) / <alpha-value>)',
          500: 'rgb(var(--beige-500) / <alpha-value>)',
          600: 'rgb(var(--beige-600) / <alpha-value>)',
          700: 'rgb(var(--beige-700) / <alpha-value>)',
          800: 'rgb(var(--beige-800) / <alpha-value>)',
          900: 'rgb(var(--beige-900) / <alpha-value>)',
        },
        warm: {
          50: 'rgb(var(--warm-50) / <alpha-value>)',
          100: 'rgb(var(--warm-100) / <alpha-value>)',
          800: 'rgb(var(--warm-800) / <alpha-value>)',
          900: 'rgb(var(--warm-900) / <alpha-value>)',
        },
        // Semantic tokens (replace hardcoded white/black so they flip too).
        surface: 'rgb(var(--surface) / <alpha-value>)',
        surface2: 'rgb(var(--surface-2) / <alpha-value>)',
        surface3: 'rgb(var(--surface-3) / <alpha-value>)',
        canvas: 'rgb(var(--bg) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--border) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}
