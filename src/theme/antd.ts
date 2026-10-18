import type { ThemeConfig } from 'antd';
import { colors, fontFamily, radii, shadows } from './tokens';

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: colors.primary,
    colorInfo: colors.primary,
    colorSuccess: colors.success,
    colorWarning: colors.warning,
    colorError: colors.error,
    colorText: colors.text,
    colorTextSecondary: colors.textSecondary,
    colorBorder: colors.border,
    colorBorderSecondary: colors.borderSubtle,
    colorBgLayout: colors.canvas,
    colorBgContainer: colors.surface,
    borderRadius: radii.md,
    borderRadiusLG: radii.lg,
    controlHeight: 38,
    fontFamily,
    boxShadowSecondary: shadows.floating,
  },
  components: {
    Layout: {
      bodyBg: colors.canvas,
      siderBg: colors.surface,
      headerBg: colors.surface,
    },
    Menu: {
      itemBg: colors.surface,
      itemColor: colors.textSecondary,
      itemSelectedBg: colors.primarySoft,
      itemSelectedColor: colors.primary,
      itemHoverBg: colors.surfaceMuted,
      itemHeight: 44,
      itemMarginInline: 12,
    },
    Table: {
      headerBg: colors.surfaceMuted,
      headerColor: colors.textSecondary,
      rowHoverBg: colors.primarySoft,
      fontSize: 13,
    },
    Card: { paddingLG: 22 },
    Button: { primaryShadow: 'none', defaultShadow: 'none' },
    Segmented: {
      trackBg: colors.surfaceMuted,
      itemSelectedColor: colors.primary,
    },
  },
};
