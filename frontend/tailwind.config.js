/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        beige: {
          50: '#FBF8F3',
          100: '#F5F0E6',
          200: '#EDE4D3',
          300: '#E0D4BE',
          400: '#D4C5A7',
          500: '#C9B49D',
          600: '#B8A48A',
          700: '#9A876F',
          800: '#7A6B58',
          900: '#5C503F',
        },
        warm: {
          50: '#FAF7F2',
          100: '#F4F0E9',
          800: '#3F3A33',
          900: '#2E2923',
        },
      },
    },
  },
  plugins: [],
}

