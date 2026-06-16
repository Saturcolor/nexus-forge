/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background:  'var(--color-background)',
        foreground:  'var(--color-foreground)',
        card: {
          DEFAULT:    'var(--color-card)',
          foreground: 'var(--color-card-foreground)',
        },
        primary: {
          DEFAULT:    'var(--color-primary)',
          foreground: 'var(--color-primary-foreground)',
        },
        secondary: {
          DEFAULT:    'var(--color-secondary)',
          foreground: 'var(--color-secondary-foreground)',
        },
        muted: {
          DEFAULT:    'var(--color-muted)',
          foreground: 'var(--color-muted-foreground)',
        },
        destructive: {
          DEFAULT:    'var(--color-destructive)',
        },
        border: 'var(--color-border)',
        input:  'var(--color-input)',
        ring:   'var(--color-ring)',
        // Semantic status colors
        'theme-green':  'var(--color-green)',
        'theme-red':    'var(--color-red)',
        'theme-orange': 'var(--color-orange)',
        'theme-purple': 'var(--color-purple)',
      },
    },
  },
  plugins: [],
};
