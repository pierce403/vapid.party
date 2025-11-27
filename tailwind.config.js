/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-outfit)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-fira-code)', 'ui-monospace', 'monospace'],
      },
      colors: {
        vapor: {
          50: '#f0fdf9',
          100: '#ccfbef',
          200: '#9af5de',
          300: '#5eeac9',
          400: '#2cd4b0',
          500: '#14b898',
          600: '#0d947c',
          700: '#0f7665',
          800: '#115d52',
          900: '#134d44',
          950: '#042f2a',
        },
        midnight: {
          50: '#f4f6fb',
          100: '#e8ecf6',
          200: '#cbd6eb',
          300: '#9db3da',
          400: '#688ac4',
          500: '#456cae',
          600: '#345492',
          700: '#2b4477',
          800: '#273c63',
          900: '#253454',
          950: '#0f1422',
        }
      },
      animation: {
        'gradient': 'gradient 8s ease infinite',
        'float': 'float 6s ease-in-out infinite',
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        gradient: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-20px)' },
        }
      },
      backgroundSize: {
        '300%': '300%',
      }
    },
  },
  plugins: [],
}

