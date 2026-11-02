import type { Config } from 'tailwindcss';

// Colors are CSS variables (src/styles.css) so light and dark share one set of class names.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Type scale (use only these): 2xs 11 · xs 12 · sm 13 (body) · base 15 · lg 18.
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '20px' }],
        base: ['15px', { lineHeight: '22px' }],
        lg: ['18px', { lineHeight: '26px' }],
      },
      colors: {
        bg: 'var(--bg)',
        fg: 'var(--fg)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        line: 'var(--line)',
        panel: 'var(--panel)',
        hover: 'var(--hover)',
        sel: 'var(--sel)',
        accent: 'var(--accent)',
        'on-accent': 'var(--on-accent)',
        danger: { DEFAULT: 'var(--danger)', bg: 'var(--danger-bg)' },
        'warn-bg': 'var(--warn-bg)',
        kbd: { DEFAULT: 'var(--kbd)', border: 'var(--kbd-border)', fg: 'var(--kbd-fg)' },
      },
    },
  },
  plugins: [],
} satisfies Config;
