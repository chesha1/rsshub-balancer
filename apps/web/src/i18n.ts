import messages from '@intlify/unplugin-vue-i18n/messages'
import { createI18n } from 'vue-i18n'

export const supportedLocales = ['zh-CN', 'en-US'] as const
export type SupportedLocale = (typeof supportedLocales)[number]

const defaultLocale: SupportedLocale = 'zh-CN'
const fallbackLocale: SupportedLocale = 'en-US'
const localeStorageKey = 'rsshub-balancer-locale'

// 判断浏览器持久化的语言值是否属于当前前端支持范围。
function isSupportedLocale(value: string | null): value is SupportedLocale {
  return supportedLocales.includes(value as SupportedLocale)
}

// 读取用户上次选择的语言；读取失败或无效时回到默认中文。
function readStoredLocale(): SupportedLocale {
  try {
    const storedLocale = window.localStorage.getItem(localeStorageKey)
    if (isSupportedLocale(storedLocale)) {
      return storedLocale
    }
  } catch {
    return defaultLocale
  }

  return defaultLocale
}

// 写入用户选择的语言；失败时仍继续切换当前页面状态。
function writeStoredLocale(locale: SupportedLocale) {
  try {
    window.localStorage.setItem(localeStorageKey, locale)
  } catch {}
}

// 同步根元素语言，方便浏览器和辅助技术识别当前页面语言。
function applyHtmlLang(locale: SupportedLocale) {
  document.documentElement.lang = locale
}

const initialLocale = readStoredLocale()

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale,
  messages,
})

applyHtmlLang(initialLocale)

// 切换全局 i18n locale，并同步本地存储和 HTML lang。
export function setAppLocale(locale: SupportedLocale) {
  i18n.global.locale.value = locale
  writeStoredLocale(locale)
  applyHtmlLang(locale)
}
