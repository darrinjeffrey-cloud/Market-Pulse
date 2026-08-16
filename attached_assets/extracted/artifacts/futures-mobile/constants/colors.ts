/**
 * Dark terminal palette — mirrors the web app's "deep ink" aesthetic.
 * Derived from artifacts/futures-alignment/src/index.css
 *
 * HSL values from the web app's CSS variables, converted to hex.
 * The app always uses the dark palette (userInterfaceStyle: "dark").
 */

const palette = {
  // Core surfaces
  background: '#0e121b',      // HSL(222, 32%, 8%)
  foreground: '#e2eaf1',      // HSL(210, 25%, 91%)
  card: '#161c27',            // HSL(221, 27%, 12%)
  cardForeground: '#e2eaf1',
  border: '#2c3545',          // HSL(219, 22%, 22%)

  // Semantic aliases for compatibility with useColors() hooks
  text: '#e2eaf1',
  tint: '#f6f15a',

  // Primary: chartreuse-yellow conviction signals
  primary: '#f6f15a',         // HSL(58, 90%, 66%)
  primaryForeground: '#0e121b',

  // Secondary / elevated surface
  secondary: '#212836',       // HSL(220, 25%, 17%)
  secondaryForeground: '#e2eaf1',

  // Muted / subdued
  muted: '#1c2331',           // HSL(220, 24%, 15%)
  mutedForeground: '#818ea2', // HSL(216, 15%, 57%)

  // Accent: terminal cyan
  accent: '#50ddf1',          // HSL(187, 85%, 63%)
  accentForeground: '#0e121b',

  // Destructive: coral/red
  destructive: '#ea6c5d',     // HSL(7, 77%, 64%)
  destructiveForeground: '#0e121b',

  // Chart palette
  success: '#4bce81',         // HSL(145, 57%, 55%) — BULL green
  purple: '#a37fd4',          // HSL(270, 55%, 72%)

  input: '#2c3545',
};

const colors = {
  light: palette,
  dark: palette,
  radius: 10,
};

export default colors;
