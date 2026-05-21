/**
 * i18n bootstrap.
 *
 * MVP ships English only. Chinese, Japanese and other locales are queued for
 * M2; the scaffolding already supports per-language JSON bundles via
 * ``i18next.addResourceBundle``.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enCommon from './en.json';
import zhCommon from './zh.json';

export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = 'zvec-studio-language';

function getStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* SSR / privacy mode */ }
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith('zh')) return 'zh';
  return 'en';
}

export function setLanguage(lang: Language): void {
  localStorage.setItem(STORAGE_KEY, lang);
  void i18n.changeLanguage(lang);
}

/** Initialize i18n once per process; safe to call multiple times in tests. */
export function initI18n(): typeof i18n {
  if (i18n.isInitialized) {
    return i18n;
  }
  void i18n
    .use(initReactI18next)
    .init({
      lng: getStoredLanguage(),
      fallbackLng: 'en',
      defaultNS: 'common',
      ns: ['common'],
      resources: {
        en: { common: enCommon },
        zh: { common: zhCommon },
      },
      interpolation: {
        escapeValue: false,
      },
    });
  return i18n;
}

export default i18n;
