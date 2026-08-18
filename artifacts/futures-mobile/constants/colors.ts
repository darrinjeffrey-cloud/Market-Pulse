/**
 * Dark & Gold palette — mirrors the web app's amber-gold aesthetic.
 * Derived from artifacts/futures-alignment/src/index.css (Dark & Gold theme).
 *
 * HSL values from the web app's CSS variables, converted to hex.
 * The app always uses the dark palette (userInterfaceStyle: "dark").
 */

const palette = {
  // Core surfaces
  background: '#100D08',      // HSL(20, 14%, 5%)
  foreground: '#F8F7F4',      // HSL(38, 15%, 97%)
  card: '#17120B',            // HSL(25, 14%, 8%)
  cardForeground: '#F8F7F4',
  border: '#2B2015',          // HSL(30, 12%, 18%)

  // Semantic aliases for compatibility with useColors() hooks
  text: '#F8F7F4',
  tint: '#F5A800',

  // Primary: amber-gold conviction signals
  primary: '#F5A800',         // HSL(43, 96%, 54%)
  primaryForeground: '#100D08',

  // Secondary / elevated surface
  secondary: '#201808',       // HSL(28, 13%, 14%)
  secondaryForeground: '#F8F7F4',

  // Muted / subdued
  muted: '#191209',           // HSL(25, 11%, 11%)
  mutedForeground: '#C0AA87', // HSL(32, 12%, 72%)

  // Accent: lighter gold
  accent: '#E8A83A',          // HSL(38, 90%, 62%)
  accentForeground: '#100D08',

  // Destructive: coral/red (unchanged)
  destructive: '#ea6c5d',     // HSL(7, 77%, 64%)
  destructiveForeground: '#100D08',

  // Chart palette
  success: '#4bce81',         // HSL(145, 57%, 55%) — BULL green
  purple: '#a37fd4',          // HSL(270, 55%, 72%)

  input: '#261D0D',
};

const colors = {
  light: palette,
  dark: palette,
  radius: 10,
};

export default colors;
