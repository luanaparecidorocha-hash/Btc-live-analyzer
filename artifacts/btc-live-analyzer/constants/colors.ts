/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    text: '#edf4f2',
    tint: '#f3b63f',

    background: '#081412',
    foreground: '#edf4f2',

    card: '#10231f',
    cardForeground: '#edf4f2',

    primary: '#f3b63f',
    primaryForeground: '#152015',

    secondary: '#17322c',
    secondaryForeground: '#dceae6',

    muted: '#16302b',
    mutedForeground: '#8ca8a0',

    accent: '#123b35',
    accentForeground: '#9be3d2',

    destructive: '#ee6f5c',
    destructiveForeground: '#fff7f2',

    border: '#20453d',
    input: '#2b574d',
  },

  dark: {
    text: '#edf4f2',
    tint: '#f3b63f',
    background: '#081412',
    foreground: '#edf4f2',
    card: '#10231f',
    cardForeground: '#edf4f2',
    primary: '#f3b63f',
    primaryForeground: '#152015',
    secondary: '#17322c',
    secondaryForeground: '#dceae6',
    muted: '#16302b',
    mutedForeground: '#8ca8a0',
    accent: '#123b35',
    accentForeground: '#9be3d2',
    destructive: '#ee6f5c',
    destructiveForeground: '#fff7f2',
    border: '#20453d',
    input: '#2b574d',
  },

  radius: 18,
};

export default colors;
