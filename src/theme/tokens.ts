/** Shared by Ant Design, CSS/Tailwind, canvas charts and exported reports. */
export const colors = {
  primary: '#3478f6',
  primaryHover: '#2463d6',
  primaryStrong: '#245bc0',
  primarySoft: '#edf4ff',
  primaryBorder: '#cbdcfa',
  primaryMuted: '#a9c7fa',
  canvas: '#f5f6fa',
  surface: '#ffffff',
  surfaceMuted: '#f8f9fc',
  text: '#252b3b',
  textSecondary: '#667085',
  textMuted: '#7b8497',
  border: '#e5e9f1',
  borderSubtle: '#eef0f5',
  success: '#27866d',
  successSoft: '#edf7f3',
  warning: '#ad7625',
  warningSoft: '#fff7e8',
  error: '#d34f59',
  purple: '#8164d7',
  purpleSoft: '#f2effb',
  cyan: '#2698bb',
  cyanSoft: '#ecf7fb',
  chartRange: '#c3d6f7',
  chartNeutral: '#dce3ef',
  chartLine: '#a8b4c8',
  chartHeatLow: '#eaf2ff',
  chartHeatMid: '#82b0fa',
  chartHeatHigh: '#285db9',
} as const;

export const radii = { sm: 6, md: 8, lg: 12 } as const;
export const shadows = {
  card: '0 2px 12px rgba(37, 43, 59, 0.035)',
  floating: '0 8px 32px rgba(37, 43, 59, 0.12)',
} as const;
export const fontFamily =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** Install on the document so drawers, menus and tooltips inherit the same tokens. */
export function installThemeVariables(root: HTMLElement) {
  const kebab = (key: string) =>
    key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  Object.entries(colors).forEach(([key, value]) =>
    root.style.setProperty(`--color-${kebab(key)}`, value),
  );
  Object.entries(radii).forEach(([key, value]) =>
    root.style.setProperty(`--radius-${key}`, `${value}px`),
  );
  Object.entries(shadows).forEach(([key, value]) =>
    root.style.setProperty(`--shadow-${key}`, value),
  );
  root.style.setProperty('--font-app', fontFamily);
}
