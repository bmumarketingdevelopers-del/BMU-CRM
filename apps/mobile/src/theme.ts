import { colors } from '@bmu/shared';

export { colors };

/** Light, minimal palette like bmumarketing.in. */
export const ui = {
  bg: '#FFFFFF',
  soft: colors.ivory,
  line: '#EBEAE6',
  ink: colors.charcoal,
  muted: colors.muted,
  accent: colors.green,
  warn: colors.statusAmber,
  bad: colors.statusRed,
} as const;

export const fonts = {
  display: 'ZenDots_400Regular',
  body: 'AlbertSans_400Regular',
  bodyBold: 'AlbertSans_600SemiBold',
} as const;
