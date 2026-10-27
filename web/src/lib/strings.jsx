import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './api.js'

// The words girls see, in her language. They come from the server (the Translation studio):
// a sentence nobody has translated and approved yet shows in English.

const StringsContext = createContext(null)
const KEY = 'ubah:lang'

export function savedLanguage() {
  try {
    return localStorage.getItem(KEY) || ''
  } catch {
    return ''
  }
}

export function StringsProvider({ lang, children }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    api
      .get(`/strings?lang=${encodeURIComponent(lang || '')}`)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ lang: 'en', languages: [], strings: {} }))
    try {
      if (lang) localStorage.setItem(KEY, lang)
    } catch {
      /* private mode: nothing to remember */
    }
    return () => {
      live = false
    }
  }, [lang])
  return <StringsContext.Provider value={data}>{children}</StringsContext.Provider>
}

export function useStrings() {
  const data = useContext(StringsContext)
  const t = (key) => data?.strings?.[key] ?? ''
  return { t, ready: Boolean(data), lang: data?.lang ?? 'en', languages: data?.languages ?? [] }
}
